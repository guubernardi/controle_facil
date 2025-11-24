// server/routes/ml-claims.js
'use strict';

/**
 * Proxy Mercado Livre (Claims + Returns + Orders)
 */

const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const multer   = require('multer');
const FormData = require('form-data');
const { query }= require('../db');

if (typeof fetch !== 'function') {
  global.fetch = (...args) => import('node-fetch').then(m => m.default(...args));
}

const router       = express.Router();
const ML_V1        = 'https://api.mercadolibre.com/post-purchase/v1';
const ML_V2        = 'https://api.mercadolibre.com/post-purchase/v2';
const AHEAD_SEC    = parseInt(process.env.ML_REFRESH_AHEAD_SEC || '600', 10) || 600;
const ML_TOKEN_URL = process.env.ML_TOKEN_URL || 'https://api.mercadolibre.com/oauth/token';

/* ============================== Token helpers ============================== */

async function loadTokenRowFromDb(sellerId, q = query) {
  const { rows } = await q(`
    SELECT user_id, nickname, access_token, refresh_token, expires_at
      FROM public.ml_tokens
     WHERE user_id = $1
     ORDER BY updated_at DESC
     LIMIT 1
  `, [sellerId]);
  return rows[0] || null;
}

async function loadTokenRowFromDbByNick(nickname, q = query) {
  if (!nickname) return null;
  const { rows } = await q(`
    SELECT user_id, nickname, access_token, refresh_token, expires_at
      FROM public.ml_tokens
     WHERE LOWER(REPLACE(nickname,' ','')) = LOWER(REPLACE($1,' ','')) 
     ORDER BY updated_at DESC
     LIMIT 1
  `, [String(nickname || '').trim()]);
  return rows[0] || null;
}

function isExpiringSoon(expiresAtIso, aheadSec = AHEAD_SEC) {
  if (!expiresAtIso) return true;
  const exp = new Date(expiresAtIso).getTime();
  if (!Number.isFinite(exp)) return true;
  return (exp - Date.now()) <= aheadSec * 1000;
}

async function refreshAccessToken({ sellerId, refreshToken, q = query }) {
  if (!refreshToken) return null;

  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id:     process.env.ML_CLIENT_ID || '',
    client_secret: process.env.ML_CLIENT_SECRET || '',
    refresh_token: refreshToken
  });

  const r = await fetch(ML_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });

  const ct = r.headers.get('content-type') || '';
  const body = ct.includes('application/json')
    ? await r.json().catch(() => null)
    : await r.text().catch(() => '');

  if (!r.ok) {
    const msg = (body && (body.message || body.error)) || r.statusText || 'refresh_failed';
    const err = new Error(msg);
    err.status = r.status;
    err.body = body;
    throw err;
  }

  const { access_token, refresh_token, token_type, scope, expires_in } = body || {};
  const expiresAt = new Date(
    Date.now() + (Math.max(60, Number(expires_in) || 600)) * 1000
  ).toISOString();

  await q(`
    INSERT INTO public.ml_tokens
      (user_id, access_token, refresh_token, token_type, scope, expires_at, raw, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7, now())
    ON CONFLICT (user_id) DO UPDATE SET
      access_token = EXCLUDED.access_token,
      refresh_token= EXCLUDED.refresh_token,
      token_type   = EXCLUDED.token_type,
      scope        = EXCLUDED.scope,
      expires_at   = EXCLUDED.expires_at,
      raw          = EXCLUDED.raw,
      updated_at   = now()
  `, [
    sellerId,
    access_token || null,
    refresh_token || null,
    token_type || null,
    scope || null,
    expiresAt,
    JSON.stringify(body || {})
  ]);

  return { access_token, refresh_token, expires_at: expiresAt };
}

async function resolveSellerAccessToken(req) {
  const direct = req.get('x-seller-token');
  if (direct) return direct;

  const q = req.q || query;

  const nickname = String((req.query?.nick || req.query?.nickname || '')).trim();
  if (nickname) {
    const row = await loadTokenRowFromDbByNick(nickname, q);
    if (row?.access_token) {
      if (!isExpiringSoon(row.expires_at)) return row.access_token;
      try {
        const refreshed = await refreshAccessToken({ sellerId: row.user_id, refreshToken: row.refresh_token, q });
        if (refreshed?.access_token) return refreshed.access_token;
      } catch {
        if (row.access_token && !isExpiringSoon(row.expires_at, 0)) return row.access_token;
      }
    }
  }

  const sellerId = String(
    req.get('x-seller-id') ||
    req.query?.seller_id ||
    req.session?.ml?.user_id ||
    ''
  ).replace(/\D/g, '');

  if (sellerId) {
    const row = await loadTokenRowFromDb(sellerId, q);
    if (row?.access_token) {
      if (!isExpiringSoon(row.expires_at)) return row.access_token;
      try {
        const refreshed = await refreshAccessToken({ sellerId, refreshToken: row.refresh_token, q });
        if (refreshed?.access_token) return refreshed.access_token;
      } catch {
        if (row.access_token && !isExpiringSoon(row.expires_at, 0)) return row.access_token;
      }
    }
  }

  if (req.session?.ml?.access_token) return req.session.ml.access_token;
  return process.env.MELI_OWNER_TOKEN || '';
}

async function resolveSellerId(req) {
  const hdr = String(
    req.get('x-seller-id') ||
    req.query?.seller_id ||
    req.session?.ml?.user_id ||
    ''
  ).replace(/\D/g, '');
  if (hdr) return hdr;
  try {
    const me = await mlFetch(req, 'https://api.mercadolibre.com/users/me');
    const id = me?.id || me?.user_id;
    return id ? String(id) : '';
  } catch {
    return '';
  }
}

/* ============================== Fetch helpers ============================== */

async function mlFetch(req, url, opts = {}) {
  const token = await resolveSellerAccessToken(req);
  if (!token) {
    const e = new Error('missing_access_token');
    e.status = 401;
    throw e;
  }
  const r = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(opts.headers || {})
    }
  });
  const ct = r.headers.get('content-type') || '';
  const body = ct.includes('application/json')
    ? await r.json().catch(() => null)
    : await r.text().catch(() => '');
  if (!r.ok) {
    const err = new Error((body && (body.message || body.error)) || r.statusText);
    err.status = r.status;
    err.body = body;
    err.metadata = r.headers.get('metadata') || null;
    throw err;
  }
  return body;
}

async function mlFetchRaw(req, url, opts = {}) {
  const token = await resolveSellerAccessToken(req);
  if (!token) {
    const e = new Error('missing_access_token');
    e.status = 401;
    throw e;
  }
  const r = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opts.headers || {})
    }
  });
  if (!r.ok) {
    const ct = r.headers.get('content-type') || '';
    const body = ct.includes('application/json')
      ? await r.json().catch(() => null)
      : await r.text().catch(() => '');
    const err = new Error((body && (body.message || body.error)) || r.statusText);
    err.status = r.status;
    err.body = body;
    err.metadata = r.headers.get('metadata') || null;
    throw err;
  }
  return r;
}

/* ===== helpers extra p/ fallback por nick/loja ===== */
function extractNickFromStoreName(lojaNome) {
  if (!lojaNome) return null;
  let s = String(lojaNome).trim();
  const m = s.split('·');
  if (m.length > 1) return m[1].trim();
  const m2 = s.split('-');
  if (m2.length > 1 && /mercado/i.test(m2[0])) return m2[1].trim();
  if (!/mercado/i.test(s)) return s;
  return null;
}

async function inferNickFromOrderId(orderId) {
  if (!orderId) return null;
  try {
    const { rows } = await query(
      `SELECT loja_nome
         FROM devolucoes
        WHERE id_venda = $1
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 1`,
      [String(orderId)]
    );
    const loja = rows?.[0]?.loja_nome || null;
    return extractNickFromStoreName(loja);
  } catch {
    return null;
  }
}

async function mlFetchAsNick(req, url, nick, opts = {}) {
  const row = await loadTokenRowFromDbByNick(nick, req.q || query);
  const token = row?.access_token || null;
  if (!token) {
    const e = new Error('no_token_for_nick');
    e.status = 401;
    throw e;
  }
  const r = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(opts.headers || {})
    }
  });
  const ct = r.headers.get('content-type') || '';
  const body = ct.includes('application/json')
    ? await r.json().catch(() => null)
    : await r.text().catch(() => '');
  if (!r.ok) {
    const err = new Error((body && (body.message || body.error)) || r.statusText);
    err.status = r.status;
    err.body = body;
    err.metadata = r.headers.get('metadata') || null;
    throw err;
  }
  return body;
}

const ok = (res, data = {}) => res.json({ ok: true, ...data });

/* ============================== Util helpers ============================== */

const safeNum = (v) => (v == null ? null : Number(v));
const coerceList = (x) => Array.isArray(x) ? x : (x && (x.results || x.items || x.claims || x.data)) || [];

/* ---- Reason helpers ---- */
function humanizeReason(idOrText = '') {
  const s = String(idOrText).toLowerCase();
  const byId = {
    'different_from_description': 'Produto diferente do anunciado',
    'not_as_described': 'Produto diferente do anunciado',
    'wrong_item': 'Produto diferente do anunciado',
    'variations_mismatch': 'Variação errada',
    'size_color_mismatch': 'Variação errada',
    'damaged_item': 'Produto com defeito',
    'incomplete_item': 'Produto incompleto',
    'broken': 'Produto com defeito',
    'missing_parts': 'Produto incompleto',
    'not_delivered': 'Entrega atrasada',
    'undelivered': 'Entrega atrasada'
  };
  if (byId[s]) return byId[s];

  if (/diferente.*anunciad/.test(s) || /not.*describ/.test(s)) return 'Produto diferente do anunciado';
  if (/cor|tamanho|variaç|variation/.test(s))                  return 'Variação errada';
  if (/defeit|quebrad|broken|damag/.test(s))                   return 'Produto com defeito';
  if (/incomplet|faltando|missing/.test(s))                    return 'Produto incompleto';
  if (/undeliver|not.*deliver|atras/.test(s))                  return 'Entrega atrasada';

  return idOrText || 'Outro';
}

function extractClaimReason(claim = {}) {
  const rid =
    claim?.reason_id ||
    claim?.reason_key ||
    claim?.reason?.id ||
    claim?.substatus ||
    claim?.type ||
    '';
  const rtext =
    claim?.reason_name ||
    claim?.reason?.name ||
    claim?.reason?.text ||
    claim?.reason?.description ||
    claim?.title ||
    claim?.detail ||
    '';
  const label = humanizeReason(rid || rtext);
  return { id: rid || null, label, raw: (rtext || rid || null) };
}

/* ---- Flow helpers (PRIORIDADE: logística) ---- */
function flowFromReturnStatus(rstat) {
  const s = String(rstat || '').toLowerCase();
  if (!s) return null;
  if (s === 'delivered')                            return 'recebido_cd';
  if (s === 'shipped' || s === 'pending_delivered') return 'em_transporte';
  if (s === 'ready_to_ship' || s === 'label_generated') return 'pronto_envio';
  if (s === 'return_to_buyer')                      return 'retorno_comprador';
  if (s === 'scheduled')                            return 'agendado';
  if (s === 'expired')                              return 'expirado';
  if (s === 'canceled' || s === 'cancelled')        return 'cancelado';
  return null;
}

function flowFromClaimStage(stageLike) {
  const s = String(stageLike || '').toLowerCase();
  if (/mediat|media[cç]ao/.test(s)) return 'mediacao';
  if (/(open|opened|pending|dispute|reclama|claim)/.test(s)) return 'disputa';
  return null;
}

function flowFromClaimPreferReturn(claim = {}, ret = {}) {
  const prefer = flowFromReturnStatus(ret?.status || claim?.return_status);
  if (prefer) return { flow: prefer, raw: ret?.status || claim?.return_status || '' };
  const stageFlow = flowFromClaimStage(claim?.stage || claim?.stage_name || claim?.status);
  return { flow: stageFlow || 'pendente', raw: ret?.status || claim?.return_status || stageFlow || '' };
}

/* ======================= 0) Claim & Messages ======================= */

// >>> AQUI é a mudança importante: só aceita id numérico
router.get('/claims/:id(\\d+)', async (req, res) => {
  try {
    const claimId = String(req.params.id || '').replace(/\D/g, '');
    if (!claimId) return res.status(400).json({ error: 'invalid_claim_id' });
    const data = await mlFetch(req, `${ML_V1}/claims/${encodeURIComponent(claimId)}`);
    return res.json({ data: data || {} });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

router.get('/claims/:id/messages', async (req, res) => {
  try {
    const claimId = String(req.params.id || '').replace(/\D/g, '');
    if (!claimId) return res.status(400).json({ error: 'invalid_claim_id' });
    const out = await mlFetch(req, `${ML_V1}/claims/${encodeURIComponent(claimId)}/messages`);
    const messages = Array.isArray(out) ? out : (out?.messages ?? out?.data ?? []);
    return res.json({ messages: Array.isArray(messages) ? messages : [] });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

/* ======================= 1) Mediation & Expected Resolutions ======================= */

router.post('/claims/:id/actions/open-dispute', async (req, res) => {
  try {
    const claimId = encodeURIComponent(String(req.params.id || '').replace(/\D/g, ''));
    const out = await mlFetch(req, `${ML_V1}/claims/${claimId}/actions/open-dispute`, { method: 'POST' });
    return res.status(200).json(out || { ok: true });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

router.get('/claims/:id/expected-resolutions', async (req, res) => {
  try {
    const claimId = encodeURIComponent(String(req.params.id || '').replace(/\D/g, ''));
    const out = await mlFetch(req, `${ML_V1}/claims/${claimId}/expected-resolutions`);
    return res.json(Array.isArray(out) ? out : (out || []));
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

router.get('/claims/:id/partial-refund/available-offers', async (req, res) => {
  try {
    const claimId = encodeURIComponent(String(req.params.id || '').replace(/\D/g, ''));
    const out = await mlFetch(req, `${ML_V1}/claims/${claimId}/partial-refund/available-offers`);
    return res.json(out || {});
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

router.post('/claims/:id/expected-resolutions/partial-refund', express.json(), async (req, res) => {
  try {
    const claimId = encodeURIComponent(String(req.params.id || '').replace(/\D/g, ''));
    const body = { percentage: Number(req.body?.percentage) };
    if (!Number.isFinite(body.percentage)) return res.status(400).json({ error: 'percentage numérico é obrigatório' });
    const out = await mlFetch(
      req,
      `${ML_V1}/claims/${claimId}/expected-resolutions/partial-refund`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    return res.json(out || { ok: true });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

router.post('/claims/:id/expected-resolutions/refund', async (req, res) => {
  try {
    const claimId = encodeURIComponent(String(req.params.id || '').replace(/\D/g, ''));
    const out = await mlFetch(req, `${ML_V1}/claims/${claimId}/expected-resolutions/refund`, { method: 'POST' });
    return res.json(out || { ok: true });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

router.post('/claims/:id/expected-resolutions/allow-return', async (req, res) => {
  try {
    const claimId = encodeURIComponent(String(req.params.id || '').replace(/\D/g, ''));
    const out = await mlFetch(req, `${ML_V1}/claims/${claimId}/expected-resolutions/allow-return`, { method: 'POST' });
    return res.json(out || { ok: true });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

/* ======================= 2) Evidences & Attachments ======================= */

const TMP_DIR = path.join(__dirname, '..', '..', 'tmp-upload');
fs.mkdirSync(TMP_DIR, { recursive: true });
const upload = multer({ dest: TMP_DIR });

router.post('/claims/:id/attachments-evidences', upload.single('file'), async (req, res) => {
  const claimId = encodeURIComponent(String(req.params.id || '').replace(/\D/g, ''));
  if (!req.file) return res.status(400).json({ error: 'file é obrigatório (multipart/form-data)' });
  try {
    const form = new FormData();
    form.append('file', fs.createReadStream(req.file.path), {
      filename: req.file.originalname || req.file.filename,
      contentType: req.file.mimetype || 'application/octet-stream'
    });
    const extraHeaders = form.getHeaders();
    const xPublic = req.get('x-public');
    if (xPublic) extraHeaders['x-public'] = xPublic;
    const r = await mlFetchRaw(
      req,
      `${ML_V1}/claims/${claimId}/attachments-evidences`,
      { method: 'POST', headers: extraHeaders, body: form }
    );
    const out = await r.json().catch(() => ({}));
    fs.unlink(req.file.path, () => {});
    const file_name = out?.file_name || out?.filename || null;
    return ok(res, { file_name });
  } catch (e) {
    fs.unlink(req.file?.path || '', () => {});
    return res.status(e.status || 500).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

router.get('/claims/:id/attachments-evidences/:attachmentId', async (req, res) => {
  try {
    const claimId = encodeURIComponent(String(req.params.id || '').replace(/\D/g, ''));
    const att = encodeURIComponent(req.params.attachmentId);
    const out = await mlFetch(req, `${ML_V1}/claims/${claimId}/attachments-evidences/${att}`);
    return res.json(out || {});
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

router.get('/claims/:id/attachments-evidences/:attachmentId/download', async (req, res) => {
  try {
    const claimId = encodeURIComponent(String(req.params.id || '').replace(/\D/g, ''));
    const att = encodeURIComponent(req.params.attachmentId);
    const r = await mlFetchRaw(req, `${ML_V1}/claims/${claimId}/attachments-evidences/${att}/download`);
    const ct  = r.headers.get('content-type') || 'application/octet-stream';
    const disp = r.headers.get('content-disposition') || `inline; filename="${att}"`;
    res.set('Content-Type', ct);
    res.set('Content-Disposition', disp);
    const ab = await r.arrayBuffer();
    return res.send(Buffer.from(ab));
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

/* ======================= 3) Return Cost ======================= */

router.get('/claims/:id/charges/return-cost', async (req, res) => {
  try {
    const claimId = String(req.params.id || '').replace(/\D/g, '');
    if (!claimId) return res.status(400).json({ error: 'invalid_claim_id' });

    const wantUsd = (req.query.usd === 'true' || req.query.calculate_amount_usd === 'true');
    const qs = wantUsd ? '?calculate_amount_usd=true' : '';
    const url = `${ML_V1}/claims/${encodeURIComponent(claimId)}/charges/return-cost${qs}`;

    const out = await mlFetch(req, url);
    return res.json({
      amount: Number(out?.amount || 0),
      currency_id: out?.currency_id || 'BRL',
      amount_usd: (out?.amount_usd != null ? Number(out.amount_usd) : null)
    });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

/* ======================= 4) Search (compat) ======================= */

router.get('/claims/search', async (req, res) => {
  try {
    const orderId = String(req.query.order_id || req.query.orderId || '').replace(/\D/g, '');
    if (!orderId) return res.status(400).json({ error: 'missing_param', detail: 'order_id é obrigatório' });

    const sellerId = await resolveSellerId(req);
    const base = `${ML_V1}/claims/search`;

    async function doSearch(withSeller) {
      const url = withSeller && sellerId
        ? `${base}?seller_id=${encodeURIComponent(sellerId)}&order_id=${encodeURIComponent(orderId)}`
        : `${base}?order_id=${encodeURIComponent(orderId)}`;
      try {
        return await mlFetch(req, url);
      } catch (e) {
        if (withSeller && (e.status === 403 || e.status === 429)) return doSearch(false);
        if (e.status === 404) return { results: [] };
        throw e;
      }
    }

    const out = await doSearch(true);
    return res.json({ items: coerceList(out) });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

router.get('/claims/of-order/:orderId', (req, res) => {
  const orderId = String(req.params.orderId || '').replace(/\D/g, '');
  req.url = '/claims/search?' + new URLSearchParams({ order_id: orderId }).toString();
  return router.handle(req, res);
});

router.get('/claims', (req, res) => {
  if (req.query.order_id || req.query.orderId) {
    req.url = '/claims/search?' + new URLSearchParams({ order_id: req.query.order_id || req.query.orderId }).toString();
    return router.handle(req, res);
  }
  return res.status(400).json({ error: 'missing_param', detail: 'use ?order_id=...' });
});

/* ======================= 5) Returns (v2) + Reviews + Orders ======================= */

router.get('/claims/:claim_id/returns', async (req, res) => {
  try {
    const claimId = String(req.params.claim_id || '').replace(/\D/g, '');
    if (!claimId) return res.status(400).json({ error: 'invalid_claim_id' });
    const data = await mlFetch(req, `${ML_V2}/claims/${encodeURIComponent(claimId)}/returns`);
    const out = Array.isArray(data) ? data[0] || null : data || null;
    res.json(out || {});
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

router.get('/returns/:return_id/reviews', async (req, res) => {
  try {
    const returnId = String(req.params.return_id || '').replace(/\D/g, '');
    if (!returnId) return res.status(400).json({ error: 'invalid_return_id' });
    const data = await mlFetch(req, `${ML_V1}/returns/${encodeURIComponent(returnId)}/reviews`);
    res.json(data || {});
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

router.get('/orders/:order_id', async (req, res) => {
  try {
    const orderId = String(req.params.order_id || '').replace(/\D/g, '');
    if (!orderId) return res.status(400).json({ error: 'invalid_order_id' });
    const data = await mlFetch(req, `https://api.mercadolibre.com/orders/${encodeURIComponent(orderId)}`);
    res.json(data || {});
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

// Aliases p/ variações do front
router.get('/order/:order_id', (req, res) => {
  req.url = `/orders/${encodeURIComponent(String(req.params.order_id||''))}`;
  return router.handle(req, res);
});
router.get('/sales/:order_id', (req, res) => {
  req.url = `/orders/${encodeURIComponent(String(req.params.order_id||''))}`;
  return router.handle(req, res);
});

/* ===== Enriched (robusto) ===== */

router.get('/claims/:claim_id/returns/enriched', async (req, res) => {
  try {
    const claimId = String(req.params.claim_id || '').replace(/\D/g, '');
    if (!claimId) return res.status(400).json({ error: 'invalid_claim_id' });
    const wantUSD = String(req.query.usd || req.query.calculate_amount_usd || '') === 'true';

    let claim = null;
    try { claim = await mlFetch(req, `${ML_V1}/claims/${encodeURIComponent(claimId)}`); }
    catch (e) { if (e.status !== 404) throw e; }

    let ret = null;
    try {
      const raw = await mlFetch(req, `${ML_V2}/claims/${encodeURIComponent(claimId)}/returns`);
      ret = Array.isArray(raw) ? (raw[0] || null) : (raw || null);
    } catch (e) { if (e.status !== 404) throw e; }

    let reviews = { reviews: [] };
    if (ret?.id) {
      try { reviews = await mlFetch(req, `${ML_V1}/returns/${ret.id}/reviews`); }
      catch (e) { if (e.status !== 404) throw e; }
    }

    let return_cost = null;
    try {
      const qp = wantUSD ? '?calculate_amount_usd=true' : '';
      return_cost = await mlFetch(req, `${ML_V1}/claims/${encodeURIComponent(claimId)}/charges/return-cost${qp}`);
    } catch (e) {
      return_cost = { error: e.body?.error || 'unavailable', message: e.body?.message || e.message };
    }

    const orders = [];
    const orderIds = new Set();
    const fetchOrder = async (oid) => {
      if (!oid) return { error: 'missing_order_id' };
      try {
        const od = await mlFetch(req, `https://api.mercadolibre.com/orders/${encodeURIComponent(oid)}`);
        const it = (od?.order_items && od.order_items[0]) || {};
        return {
          order_id: oid,
          item_id: it?.item?.id || null,
          title:    it?.item?.title || null,
          unit_price: Number(it?.unit_price ?? 0),
          quantity:   Number(it?.quantity ?? 1),
          total_paid: Number(od?.paid_amount ?? (Number(it?.unit_price ?? 0) * Number(it?.quantity ?? 1))),
          buyer: od?.buyer || null
        };
      } catch (e) {
        return { order_id: oid, error: e.body?.error || 'unavailable', message: e.body?.message || e.message };
      }
    };

    const promises = [];
    const pushOrder = (oid) => {
      const id = String(oid || '').replace(/\D/g, '');
      if (!id || orderIds.has(id)) return;
      orderIds.add(id);
      promises.push(fetchOrder(id).then(o => orders.push(o)));
    };

    if (ret?.orders?.length) {
      for (const o of ret.orders) pushOrder(o.order_id);
    } else if (claim) {
      const maybeOid =
        claim?.order_id ||
        claim?.resource?.id ||
        claim?.purchase?.order_id ||
        claim?.context?.order_id ||
        null;
      if (maybeOid) pushOrder(maybeOid);
    }

    if (promises.length) await Promise.allSettled(promises);

    const reason = extractClaimReason(claim || {});
    const { flow, raw } = flowFromClaimPreferReturn(claim, { status: ret?.status });

    const summary = {
      status: ret?.status || (claim?.stage || claim?.status || null),
      refund_at: ret?.refund_at || null,
      subtype: ret?.subtype || null,
      status_money: ret?.status_money || null,
      shipments: (ret?.shipments || []).map(s => ({
        shipment_id: s?.shipment_id ?? s?.id ?? null,
        status: s?.status || null,
        type: s?.type || null,
        destination: s?.destination?.name || null,
      })),
      reasons_from_review: (reviews?.reviews || [])
        .flatMap(r => (r?.resource_reviews || []))
        .map(rr => ({
          status: rr?.status || null,
          seller_status: rr?.seller_status || null,
          reason_id: rr?.reason_id || null,
          reason_label: humanizeReason(rr?.reason_id || rr?.seller_reason || ''),
          seller_reason: rr?.seller_reason || null,
          product_condition: rr?.product_condition || null
        })),
      claim_reason: reason,
      flow,
      raw_status: raw
    };

    return res.json({ claim_id: claimId, returns: ret, claim, reviews, return_cost, orders, summary });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

/* ======================= 6) Returns state (helper) ======================= */

router.get('/returns/state', async (req, res) => {
  const claimId = String(req.query.claim_id || req.query.claimId || '').replace(/\D/g, '');
  const orderId = String(req.query.order_id || req.query.orderId || '').replace(/\D/g, '');
  if (!claimId) return res.status(400).json({ error: 'invalid_claim_id' });

  try {
    // 1) claim v1 (com tentativa por nick inferido se 401/403)
    let claim = null;
    try {
      claim = await mlFetch(req, `${ML_V1}/claims/${encodeURIComponent(claimId)}`);
    } catch (e) {
      if ((e.status === 401 || e.status === 403) && orderId && !req.query.nick) {
        const inferredNick = await inferNickFromOrderId(orderId);
        if (inferredNick) {
          claim = await mlFetchAsNick(req, `${ML_V1}/claims/${encodeURIComponent(claimId)}`, inferredNick);
        } else {
          throw e;
        }
      } else {
        throw e;
      }
    }

    // 2) return v2 (status logístico real)
    let ret = null;
    try {
      const raw = await mlFetch(req, `${ML_V2}/claims/${encodeURIComponent(claimId)}/returns`);
      ret = Array.isArray(raw) ? (raw[0] || null) : (raw || null);
    } catch (e) {
      if (e.status !== 404) throw e;
    }

    // 3) Deriva fluxo priorizando logística
    const rstat = ret?.status || claim?.return_status || null;
    const { flow, raw } = flowFromClaimPreferReturn(claim, { status: rstat });

    // 4) Atualiza tabela se veio orderId (best-effort)
    if (orderId) {
      const sets = [];
      const vals = [];
      let p = 1;

      if (rstat) { sets.push(`ml_return_status = $${p++}`); vals.push(String(rstat)); }
      if (flow)  { sets.push(`log_status       = $${p++}`); vals.push(String(flow)); }
      if (sets.length) {
        sets.push(`updated_at = now()`);
        vals.push(orderId);
        await query(`UPDATE devolucoes SET ${sets.join(', ')} WHERE id_venda = $${p}`, vals).catch(() => {});
      }
    }

    return res.json({
      ok: true,
      claim_id: claimId,
      order_id: orderId || null,
      flow,
      ml_return_status: rstat || null,
      raw_status: raw || null
    });
  } catch (e) {
    // === Fallback “gracioso”: não quebra a UI em 401/403 ===
    if ((e.status === 401 || e.status === 403) && orderId) {
      let last = null;
      try {
        const { rows } = await query(
          `SELECT ml_return_status, log_status
             FROM devolucoes
            WHERE id_venda = $1
            ORDER BY updated_at DESC NULLS LAST
            LIMIT 1`,
          [orderId]
        );
        last = rows?.[0] || null;
      } catch {}

      return res.json({
        ok: false,
        claim_id: claimId,
        order_id: orderId,
        reason: 'forbidden',
        flow: last?.log_status || null,
        ml_return_status: last?.ml_return_status || null
      });
    }
    const s = e.status || 500;
    return res.status(s).json({ error: e.message || 'error', detail: e.body || null, metadata: e.metadata || null });
  }
});

module.exports = router;
