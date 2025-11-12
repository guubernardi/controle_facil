// server/routes/ml-claims.js
'use strict';

/**
 * Proxy Mercado Livre (Claims)
 * Inclui:
 *  - GET /claims/:id
 *  - GET /claims/:id/messages
 *  - GET /claims/:id/expected-resolutions
 *  - GET /claims/:id/partial-refund/available-offers
 *  - POST /claims/:id/expected-resolutions/partial-refund
 *  - POST /claims/:id/expected-resolutions/refund
 *  - POST /claims/:id/expected-resolutions/allow-return
 *  - GET /claims/:id/evidences
 *  - POST /claims/:id/actions/evidences
 *  - POST /claims/:id/attachments-evidences (upload)
 *  - GET  /claims/:id/attachments-evidences/:attachmentId
 *  - GET  /claims/:id/attachments-evidences/:attachmentId/download
 *  - GET  /claims/:id/charges/return-cost
 *
 *  **NOVO** (compat com teu front):
 *  - GET /claims/search?order_id=...
 *  - GET /claims/of-order/:orderId
 *  - GET /claims?order_id=...   (alias p/ search)
 */

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const multer  = require('multer');
const { query } = require('../db');

const router      = express.Router();
const ML_BASE     = 'https://api.mercadolibre.com/post-purchase/v1';
const ML_TOKEN_URL= process.env.ML_TOKEN_URL || 'https://api.mercadolibre.com/oauth/token';
const AHEAD_SEC   = parseInt(process.env.ML_REFRESH_AHEAD_SEC || '600', 10) || 600;

// ============================== Helpers de token ==============================

async function loadTokenRowFromDb(sellerId, q = query) {
  const sql = `
    SELECT user_id, nickname, access_token, refresh_token, expires_at
      FROM public.ml_tokens
     WHERE user_id = $1
     ORDER BY updated_at DESC
     LIMIT 1`;
  const { rows } = await q(sql, [sellerId]);
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
  const body = ct.includes('application/json') ? await r.json().catch(() => null)
                                               : await r.text().catch(() => '');

  if (!r.ok) {
    const msg = (body && (body.message || body.error)) || r.statusText || 'refresh_failed';
    const err = new Error(msg);
    err.status = r.status;
    err.body = body;
    throw err;
  }

  const { access_token, refresh_token, token_type, scope, expires_in } = body || {};
  const expiresAt = new Date(Date.now() + (Math.max(60, Number(expires_in) || 600)) * 1000).toISOString();

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
  `, [sellerId, access_token || null, refresh_token || null, token_type || null, scope || null, expiresAt, JSON.stringify(body || {})]);

  return { access_token, refresh_token, expires_at: expiresAt };
}

async function resolveSellerAccessToken(req) {
  const direct = req.get('x-seller-token');
  if (direct) return direct;

  const sellerId = String(
    req.get('x-seller-id') || req.query.seller_id || req.session?.ml?.user_id || ''
  ).replace(/\D/g, '');

  if (sellerId) {
    const row = await loadTokenRowFromDb(sellerId, req.q || query);
    if (row?.access_token) {
      if (!isExpiringSoon(row.expires_at)) return row.access_token;
      try {
        const refreshed = await refreshAccessToken({
          sellerId,
          refreshToken: row.refresh_token,
          q: req.q || query
        });
        if (refreshed?.access_token) return refreshed.access_token;
      } catch (e) {
        if (row.access_token && !isExpiringSoon(row.expires_at, 0)) return row.access_token;
        throw e;
      }
    }
  }

  if (req.session?.ml?.access_token) return req.session.ml.access_token;
  return process.env.MELI_OWNER_TOKEN || '';
}

// seller_id p/ /claims/search
async function resolveSellerId(req) {
  const hdr = String(req.get('x-seller-id') || req.query.seller_id || req.session?.ml?.user_id || '').replace(/\D/g, '');
  if (hdr) return hdr;
  try {
    const me = await mlFetch(req, 'https://api.mercadolibre.com/users/me');
    const id = me?.id || me?.user_id;
    return id ? String(id) : '';
  } catch {
    return '';
  }
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj?.[k] !== undefined) out[k] = obj[k];
  return out;
}

// fetch JSON/text com erro enriquecido
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
  const body = ct.includes('application/json') ? await r.json().catch(() => null)
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
    const e = new Error('missing_access_token'); e.status = 401; throw e;
  }
  const r = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  if (!r.ok) {
    const ct = r.headers.get('content-type') || '';
    const body = ct.includes('application/json') ? await r.json().catch(() => null)
                                                 : await r.text().catch(() => '');
    const err = new Error((body && (body.message || body.error)) || r.statusText);
    err.status = r.status; err.body = body; err.metadata = r.headers.get('metadata') || null;
    throw err;
  }
  return r;
}

const ok = (res, data = {}) => res.json({ ok: true, ...data });

// ======================= 0) Detalhes e mensagens =======================

router.get('/claims/:id', async (req, res) => {
  try {
    const claimId = String(req.params.id || '').replace(/\D/g, '');
    if (!claimId) return res.status(400).json({ error: 'invalid_claim_id' });
    const url = `${ML_BASE}/claims/${encodeURIComponent(claimId)}`;
    const data = await mlFetch(req, url);
    return res.json({ data: data || {} });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

router.get('/claims/:id/messages', async (req, res) => {
  try {
    const claimId = String(req.params.id || '').replace(/\D/g, '');
    if (!claimId) return res.status(400).json({ error: 'invalid_claim_id' });
    const url = `${ML_BASE}/claims/${encodeURIComponent(claimId)}/messages`;
    const data = await mlFetch(req, url);
    const messages = Array.isArray(data) ? data : (data?.messages ?? []);
    return res.json({ messages });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

// ======================= 1) Mediação & Expected Resolutions =======================

router.post('/claims/:id/actions/open-dispute', async (req, res) => {
  try {
    const claimId = encodeURIComponent(String(req.params.id || '').replace(/\D/g, ''));
    const out = await mlFetch(req, `${ML_BASE}/claims/${claimId}/actions/open-dispute`, { method: 'POST' });
    return res.status(200).json(out);
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

router.get('/claims/:id/expected-resolutions', async (req, res) => {
  try {
    const claimId = encodeURIComponent(String(req.params.id || '').replace(/\D/g, ''));
    const out = await mlFetch(req, `${ML_BASE}/claims/${claimId}/expected-resolutions`);
    return res.json(Array.isArray(out) ? out : (out || []));
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

router.get('/claims/:id/partial-refund/available-offers', async (req, res) => {
  try {
    const claimId = encodeURIComponent(String(req.params.id || '').replace(/\D/g, ''));
    const out = await mlFetch(req, `${ML_BASE}/claims/${claimId}/partial-refund/available-offers`);
    return res.json(out || {});
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

router.post('/claims/:id/expected-resolutions/partial-refund', express.json(), async (req, res) => {
  try {
    const claimId = encodeURIComponent(String(req.params.id || '').replace(/\D/g, ''));
    const body = pick(req.body || {}, ['percentage']);
    if (typeof body.percentage !== 'number') return res.status(400).json({ error: 'percentage numérico é obrigatório' });
    const out = await mlFetch(req, `${ML_BASE}/claims/${claimId}/expected-resolutions/partial-refund`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return res.json(out || { ok: true });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

router.post('/claims/:id/expected-resolutions/refund', async (req, res) => {
  try {
    const claimId = encodeURIComponent(String(req.params.id || '').replace(/\D/g, ''));
    const out = await mlFetch(req, `${ML_BASE}/claims/${claimId}/expected-resolutions/refund`, { method: 'POST' });
    return res.json(out || { ok: true });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

router.post('/claims/:id/expected-resolutions/allow-return', async (req, res) => {
  try {
    const claimId = encodeURIComponent(String(req.params.id || '').replace(/\D/g, ''));
    const out = await mlFetch(req, `${ML_BASE}/claims/${claimId}/expected-resolutions/allow-return`, { method: 'POST' });
    return res.json(out || { ok: true });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

// ======================= 2) Evidences & Attachments =======================

router.get('/claims/:id/evidences', async (req, res) => {
  try {
    const claimId = encodeURIComponent(String(req.params.id || '').replace(/\D/g, ''));
    const out = await mlFetch(req, `${ML_BASE}/claims/${claimId}/evidences`);
    return res.json(Array.isArray(out) ? out : (out || []));
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

router.post('/claims/:id/actions/evidences', express.json(), async (req, res) => {
  try {
    const claimId = encodeURIComponent(String(req.params.id || '').replace(/\D/g, ''));
    const body = req.body || {};
    const out = await mlFetch(req, `${ML_BASE}/claims/${claimId}/actions/evidences`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return res.json(out || { ok: true });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

const TMP_DIR = path.join(__dirname, '..', '..', 'tmp-upload');
fs.mkdirSync(TMP_DIR, { recursive: true });
const upload = multer({ dest: TMP_DIR });

router.post('/claims/:id/attachments-evidences', upload.single('file'), async (req, res) => {
  const claimId = encodeURIComponent(String(req.params.id || '').replace(/\D/g, ''));
  if (!req.file) return res.status(400).json({ error: 'file é obrigatório (multipart/form-data)' });

  try {
    const buf = fs.readFileSync(req.file.path);
    const blob = new Blob([buf], { type: req.file.mimetype || 'application/octet-stream' });
    const form = new FormData();
    form.append('file', blob, req.file.originalname || req.file.filename);

    const extraHeaders = {};
    const xPublic = req.get('x-public');
    if (xPublic) extraHeaders['x-public'] = xPublic;

    const out = await mlFetch(req, `${ML_BASE}/claims/${claimId}/attachments-evidences`, {
      method: 'POST',
      headers: { ...extraHeaders },
      body: form
    });

    fs.unlink(req.file.path, () => {});
    const file_name = out?.file_name || out?.filename;
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
    const out = await mlFetch(req, `${ML_BASE}/claims/${claimId}/attachments-evidences/${att}`);
    return res.json(out || {});
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

router.get('/claims/:id/attachments-evidences/:attachmentId/download', async (req, res) => {
  try {
    const claimId = encodeURIComponent(String(req.params.id || '').replace(/\D/g, ''));
    const att = encodeURIComponent(req.params.attachmentId);
    const r = await mlFetchRaw(req, `${ML_BASE}/claims/${claimId}/attachments-evidences/${att}/download`);
    const ct = r.headers.get('content-type') || 'application/octet-stream';
    const disp = r.headers.get('content-disposition') || `inline; filename="${att}"`;
    res.set('Content-Type', ct);
    res.set('Content-Disposition', disp);
    const ab = await r.arrayBuffer();
    return res.send(Buffer.from(ab));
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

// ======================= 3) Return Cost =======================

router.get('/claims/:id/charges/return-cost', async (req, res) => {
  try {
    const claimId = String(req.params.id || '').replace(/\D/g, '');
    if (!claimId) return res.status(400).json({ error: 'invalid_claim_id' });

    const wantUsd = (req.query.usd === 'true' || req.query.calculate_amount_usd === 'true');
    const qs = wantUsd ? '?calculate_amount_usd=true' : '';
    const url = `${ML_BASE}/claims/${encodeURIComponent(claimId)}/charges/return-cost${qs}`;

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

// ======================= 4) Search (compat com teu front) =======================

function coerceList(x) {
  if (Array.isArray(x)) return x;
  if (!x || typeof x !== 'object') return [];
  return x.results || x.items || x.claims || x.data || [];
}

// GET /api/ml/claims/search?order_id=...
router.get('/claims/search', async (req, res) => {
  try {
    const orderId = String(req.query.order_id || req.query.orderId || '').replace(/\D/g, '');
    if (!orderId) return res.status(400).json({ error: 'missing_param', detail: 'order_id é obrigatório' });

    const sellerId = await resolveSellerId(req); // tenta descobrir
    const base = `${ML_BASE}/claims/search`;
    const url = sellerId
      ? `${base}?seller_id=${encodeURIComponent(sellerId)}&order_id=${encodeURIComponent(orderId)}`
      : `${base}?order_id=${encodeURIComponent(orderId)}`;

    const out = await mlFetch(req, url).catch(e => {
      if (e.status === 404) return { results: [] }; // compat
      throw e;
    });

    return res.json({ items: coerceList(out) });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

// GET /api/ml/claims/of-order/:orderId  (alias p/ cima)
router.get('/claims/of-order/:orderId', async (req, res) => {
  req.query.order_id = req.params.orderId;
  return router.handle({ ...req, url: '/claims/search', method: 'GET' }, res);
});

// GET /api/ml/claims?order_id=...  (alias p/ cima)
router.get('/claims', async (req, res, next) => {
  if (req.query.order_id || req.query.orderId) {
    req.url = '/claims/search?' + new URLSearchParams({ order_id: req.query.order_id || req.query.orderId }).toString();
    return router.handle(req, res);
  }
  return res.status(400).json({ error: 'missing_param', detail: 'use ?order_id=...' });
});

// ==== [ADICIONAR AO FINAL DE server/routes/ml-claims.js] =====================

// -- pequenos helpers locais (não conflitam com os seus) --
function coerceArray(x) {
  if (Array.isArray(x)) return x;
  if (x && typeof x === 'object') {
    return x.items || x.results || x.data || x.list || [];
  }
  return [];
}

function flowFromClaim(claim) {
  // stage/status da claim
  const stage = String(claim?.stage || claim?.status || '').toLowerCase();
  const rstat = String(claim?.return?.status || claim?.return_status || '').toLowerCase();

  // prioridade: mediação/disputa
  if (/mediat|media[cç]ao/.test(stage)) return { flow: 'mediacao', raw: rstat || stage };
  if (/(open|opened|pending|dispute|reclama|claim)/.test(stage)) return { flow: 'disputa', raw: rstat || stage };

  // se houver status de devolução (retorno) use para o fluxo canônico
  if (/^delivered$/.test(rstat))           return { flow: 'recebido_cd', raw: rstat };
  if (/^shipped$|pending_delivered$/.test(rstat)) return { flow: 'em_transporte', raw: rstat };
  if (/^ready_to_ship$|label_generated$/.test(rstat)) return { flow: 'pronto_envio', raw: rstat };
  if (/^return_to_buyer$/.test(rstat))     return { flow: 'retorno_comprador', raw: rstat };
  if (/^scheduled$/.test(rstat))           return { flow: 'agendado', raw: rstat };
  if (/^expired$/.test(rstat))             return { flow: 'expirado', raw: rstat };
  if (/^canceled$|^cancelled$/.test(rstat))return { flow: 'cancelado', raw: rstat };

  // fallback
  return { flow: 'pendente', raw: rstat || stage || '' };
}

// ========== 1) CLAIMS OF-ORDER (DB -> ML -> vazio) ===========================
router.get('/claims/of-order/:orderId', async (req, res) => {
  try {
    const orderId = String(req.params.orderId || '').replace(/\D/g, '');
    if (!orderId) return res.status(400).json({ error: 'invalid_order_id' });

    // 1) tenta achar no seu banco (evita chamadas no ML)
    const { rows } = await query(
      `SELECT ml_claim_id AS id
         FROM devolucoes
        WHERE id_venda = $1
          AND ml_claim_id IS NOT NULL
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 1`,
      [orderId]
    );
    if (rows[0]?.id) {
      return res.json({ items: [ { id: String(rows[0].id), order_id: orderId, source: 'db' } ] });
    }

    // 2) tenta buscar no ML (tentamos dois formatos conhecidos)
    let items = [];
    try {
      const a = await mlFetch(req, `${ML_BASE}/claims/search?order_id=${encodeURIComponent(orderId)}`);
      items = coerceArray(a);
    } catch (_) { /* tenta o próximo formato */ }
    if (!items.length) {
      try {
        const b = await mlFetch(req, `${ML_BASE}/claims/search?resource_type=order&resource_id=${encodeURIComponent(orderId)}`);
        items = coerceArray(b);
      } catch (_) { /* ignora */ }
    }

    // normaliza saída
    const out = items.map(c => ({
      id: String(c.id || c.claim_id || c.resource_id || ''),
      order_id: String(orderId),
      status: c.status || c.stage || null,
      source: 'meli'
    })).filter(x => x.id);

    return res.json({ items: out });
  } catch (e) {
    const s = e.status || 500;
    return res.status(s).json({ error: e.message || 'error' });
  }
});

// ========== 2) CLAIMS SEARCH (proxy simples para of-order) ====================
router.get('/claims/search', async (req, res) => {
  const orderId = String(req.query.order_id || req.query.orderId || '').replace(/\D/g, '');
  if (!orderId) return res.status(400).json({ error: 'invalid_order_id' });
  // Reusa a rota acima mantendo compat com o front
  req.params.orderId = orderId;
  return router.handle({ ...req, url: `/claims/of-order/${orderId}` }, res);
});

// ========== 3) IMPORT “NO-OP” (evita 400 e bloqueios no front) ===============
router.get('/claims/import', async (req, res) => {
  // Mantém contrato esperado pelo front, sem provocar 400/invalid_claim_id
  const days = parseInt(req.query.days || '0', 10) || 0;
  return res.json({ ok: true, days, total: 0, updated: 0, touched: [] });
});

// ========== 4) RETURNS STATE (flow + raw_status, compat com front) ===========
router.get('/returns/state', async (req, res) => {
  try {
    const claimId = String(req.query.claim_id || req.query.claimId || '').replace(/\D/g, '');
    const orderId = String(req.query.order_id || req.query.orderId || '').replace(/\D/g, '');
    if (!claimId) return res.status(400).json({ error: 'invalid_claim_id' });

    // busca detalhes da claim no ML
    const claim = await mlFetch(req, `${ML_BASE}/claims/${encodeURIComponent(claimId)}`);
    const { flow, raw } = flowFromClaim(claim);

    // opcional: grava no banco quando houver order_id
    if (orderId) {
      const sets = [];
      const vals = [];
      let p = 1;

      if (raw)  { sets.push(`ml_return_status = $${p++}`); vals.push(raw); }
      if (flow) { sets.push(`log_status = $${p++}`);       vals.push(flow); }
      if (sets.length) {
        sets.push(`updated_at = now()`);
        vals.push(orderId);
        await query(
          `UPDATE devolucoes SET ${sets.join(', ')} WHERE id_venda = $${p}`,
          vals
        ).catch(() => {});
      }
    }

    return res.json({ ok: true, claim_id: claimId, order_id: orderId || null, flow, raw_status: raw });
  } catch (e) {
    const s = e.status || 500;
    return res.status(s).json({ error: e.message || 'error', detail: e.body || null });
  }
});

module.exports = router;
