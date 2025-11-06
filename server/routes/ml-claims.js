// server/routes/ml-claims.js
'use strict';

/**
 * Proxy de rotas oficiais do Mercado Livre (Claims):
 * - messages (GET)
 * - details da claim (GET)
 * - open-dispute, expected-resolutions (GET/POST), partial-refund (GET/POST),
 *   refund total, allow-return
 * - evidences (GET/POST) e attachments-evidences (POST/GET/download)
 * - charges/return-cost (GET)
 *
 * Token:
 * - Header preferencial: x-seller-token: <ACCESS_TOKEN>
 * - Ou, se vier x-seller-id, busca token no banco e faz AUTO-REFRESH quando necessário
 * - Ou fallback: req.session.ml.access_token
 * - Ou último recurso: process.env.MELI_OWNER_TOKEN
 */

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const multer  = require('multer');
const { query } = require('../db');

const router  = express.Router();
const ML_BASE = 'https://api.mercadolibre.com/post-purchase/v1';
const ML_TOKEN_URL = process.env.ML_TOKEN_URL || 'https://api.mercadolibre.com/oauth/token';
const AHEAD_SEC = parseInt(process.env.ML_REFRESH_AHEAD_SEC || '600', 10) || 600; // renova 10min antes

/* ============================== Helpers de token ============================== */

/** Lê o registro mais recente da tabela pública ml_tokens */
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

/** Faz refresh no OAuth do ML e persiste no DB */
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

  // UPSERT no DB
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

/** Resolve o access_token: header -> DB (com auto-refresh) -> sessão -> env */
async function resolveSellerAccessToken(req) {
  // 1) Header direto (debug/forçado)
  const direct = req.get('x-seller-token');
  if (direct) return direct;

  // 2) Seller id: header, query ou sessão
  const sellerId = String(
    req.get('x-seller-id') || req.query.seller_id || req.session?.ml?.user_id || ''
  ).replace(/\D/g, '');

  if (sellerId) {
    const row = await loadTokenRowFromDb(sellerId, req.q || query);
    if (row?.access_token) {
      if (!isExpiringSoon(row.expires_at)) {
        return row.access_token;
      }
      // vai expirar: tenta refresh
      try {
        const refreshed = await refreshAccessToken({
          sellerId,
          refreshToken: row.refresh_token,
          q: req.q || query
        });
        if (refreshed?.access_token) return refreshed.access_token;
      } catch (e) {
        // Se falhar o refresh, ainda tenta usar o token atual (pode estar válido por poucos minutos)
        if (row.access_token && !isExpiringSoon(row.expires_at, 0)) {
          return row.access_token;
        }
        // Se realmente não der, propaga o erro
        throw e;
      }
    }
  }

  // 3) Sessão (se você coloca access_token aí ao logar)
  if (req.session?.ml?.access_token) return req.session.ml.access_token;

  // 4) Fallback owner (ENV)
  return process.env.MELI_OWNER_TOKEN || '';
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj?.[k] !== undefined) out[k] = obj[k];
  return out;
}

/** Fetch JSON/text (levanta erro com .status e .body) */
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
    err.metadata = r.headers.get('metadata') || null; // header especial do ML
    throw err;
  }
  return body;
}

/** Fetch bruto (para download/stream) */
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
    const body = ct.includes('application/json') ? await r.json().catch(() => null)
                                                 : await r.text().catch(() => '');
    const err = new Error((body && (body.message || body.error)) || r.statusText);
    err.status = r.status;
    err.body = body;
    err.metadata = r.headers.get('metadata') || null;
    throw err;
  }
  return r;
}

const ok = (res, data = {}) => res.json({ ok: true, ...data });

/* =========================================================================
 *  0) MENSAGENS E DETALHES DA RECLAMAÇÃO
 * ========================================================================= */

/** Detalhes da claim (usado pelo front para enriquecer UI) */
router.get('/claims/:id', async (req, res) => {
  try {
    const claimId = String(req.params.id || '').replace(/\D/g, '');
    if (!claimId) return res.status(400).json({ error: 'invalid_claim_id' });

    const url = `${ML_BASE}/claims/${encodeURIComponent(claimId)}`;
    const data = await mlFetch(req, url);
    // Normaliza leve mantendo compat com front (data|claim)
    return res.json({ data: data || {} });
  } catch (e) {
    const s = e.status || 500;
    return res.status(s).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

/** Obter todas as mensagens da claim */
router.get('/claims/:id/messages', async (req, res) => {
  try {
    const claimId = String(req.params.id || '').replace(/\D/g, '');
    if (!claimId) return res.status(400).json({ error: 'invalid_claim_id' });

    const url = `${ML_BASE}/claims/${encodeURIComponent(claimId)}/messages`;
    const data = await mlFetch(req, url);

    // Normaliza sempre para { messages: [...] }
    const messages = Array.isArray(data) ? data : (data?.messages ?? []);
    return res.json({ messages });
  } catch (e) {
    const s = e.status || 500;
    return res.status(s).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

/* =========================================================================
 *  1) MEDIAÇÃO
 * ========================================================================= */

/** Abrir disputa (mediação) */
router.post('/claims/:id/actions/open-dispute', async (req, res) => {
  try {
    const claimId = encodeURIComponent(req.params.id);
    const out = await mlFetch(req, `${ML_BASE}/claims/${claimId}/actions/open-dispute`, {
      method: 'POST'
    });
    return res.status(200).json(out);
  } catch (e) {
    const s = e.status || 500;
    return res.status(s).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

/* =========================================================================
 *  2) EXPECTED RESOLUTIONS
 * ========================================================================= */

/** Listar resoluções esperadas da claim */
router.get('/claims/:id/expected-resolutions', async (req, res) => {
  try {
    const claimId = encodeURIComponent(req.params.id);
    const out = await mlFetch(req, `${ML_BASE}/claims/${claimId}/expected-resolutions`);
    return res.json(Array.isArray(out) ? out : (out || []));
  } catch (e) {
    const s = e.status || 500;
    return res.status(s).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

/** Ofertas disponíveis para reembolso parcial */
router.get('/claims/:id/partial-refund/available-offers', async (req, res) => {
  try {
    const claimId = encodeURIComponent(req.params.id);
    const out = await mlFetch(req, `${ML_BASE}/claims/${claimId}/partial-refund/available-offers`);
    return res.json(out || {});
  } catch (e) {
    const s = e.status || 500;
    return res.status(s).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

/** Criar expected-resolution: partial_refund (percentage obrigatório) */
router.post('/claims/:id/expected-resolutions/partial-refund', express.json(), async (req, res) => {
  try {
    const claimId = encodeURIComponent(req.params.id);
    const body = pick(req.body || {}, ['percentage']);
    if (typeof body.percentage !== 'number') {
      return res.status(400).json({ error: 'percentage numérico é obrigatório' });
    }
    const out = await mlFetch(req, `${ML_BASE}/claims/${claimId}/expected-resolutions/partial-refund`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return res.json(out || { ok: true });
  } catch (e) {
    const s = e.status || 500;
    return res.status(s).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

/** Criar expected-resolution: refund (devolução total) */
router.post('/claims/:id/expected-resolutions/refund', async (req, res) => {
  try {
    const claimId = encodeURIComponent(req.params.id);
    const out = await mlFetch(req, `${ML_BASE}/claims/${claimId}/expected-resolutions/refund`, {
      method: 'POST'
    });
    return res.json(out || { ok: true });
  } catch (e) {
    const s = e.status || 500;
    return res.status(s).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

/** Criar expected-resolution: allow-return (devolução do produto) */
router.post('/claims/:id/expected-resolutions/allow-return', async (req, res) => {
  try {
    const claimId = encodeURIComponent(req.params.id);
    const out = await mlFetch(req, `${ML_BASE}/claims/${claimId}/expected-resolutions/allow-return`, {
      method: 'POST'
    });
    return res.json(out || { ok: true });
  } catch (e) {
    const s = e.status || 500;
    return res.status(s).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

/* =========================================================================
 *  3) EVIDENCES
 * ========================================================================= */

/** Listar evidences da claim */
router.get('/claims/:id/evidences', async (req, res) => {
  try {
    const claimId = encodeURIComponent(req.params.id);
    const out = await mlFetch(req, `${ML_BASE}/claims/${claimId}/evidences`);
    return res.json(Array.isArray(out) ? out : (out || []));
  } catch (e) {
    const s = e.status || 500;
    return res.status(s).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

/** Enviar evidences (shipping_evidence / handling_shipping_evidence, etc) */
router.post('/claims/:id/actions/evidences', express.json(), async (req, res) => {
  try {
    const claimId = encodeURIComponent(req.params.id);
    const body = req.body || {};
    const out = await mlFetch(req, `${ML_BASE}/claims/${claimId}/actions/evidences`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return res.json(out || { ok: true });
  } catch (e) {
    const s = e.status || 500;
    return res.status(s).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

/* =========================================================================
 *  4) ATTACHMENTS - EVIDENCES (upload/info/download)
 * ========================================================================= */

const TMP_DIR = path.join(__dirname, '..', '..', 'tmp-upload');
fs.mkdirSync(TMP_DIR, { recursive: true });
const upload = multer({ dest: TMP_DIR });

/** Upload de anexo para evidences */
router.post('/claims/:id/attachments-evidences', upload.single('file'), async (req, res) => {
  const claimId = encodeURIComponent(req.params.id);
  if (!req.file) return res.status(400).json({ error: 'file é obrigatório (multipart/form-data)' });

  try {
    const buf = fs.readFileSync(req.file.path);
    const blob = new Blob([buf], { type: req.file.mimetype || 'application/octet-stream' });
    const form = new FormData();
    form.append('file', blob, req.file.originalname || req.file.filename);

    // opcional: o ML aceita x-public: true; repassa se vier do cliente
    const extraHeaders = {};
    const xPublic = req.get('x-public');
    if (xPublic) extraHeaders['x-public'] = xPublic;

    const out = await mlFetch(req, `${ML_BASE}/claims/${claimId}/attachments-evidences`, {
      method: 'POST',
      headers: { ...extraHeaders },
      body: form
    });

    fs.unlink(req.file.path, () => {});
    // Resposta: { user_id, file_name }
    const file_name = out?.file_name || out?.filename;
    return ok(res, { file_name });
  } catch (e) {
    fs.unlink(req.file?.path || '', () => {});
    const s = e.status || 500;
    return res.status(s).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

/** Info do anexo de evidences */
router.get('/claims/:id/attachments-evidences/:attachmentId', async (req, res) => {
  try {
    const claimId = encodeURIComponent(req.params.id);
    const att = encodeURIComponent(req.params.attachmentId);
    const out = await mlFetch(req, `${ML_BASE}/claims/${claimId}/attachments-evidences/${att}`);
    return res.json(out || {});
  } catch (e) {
    const s = e.status || 500;
    return res.status(s).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

/** Download do anexo de evidences */
router.get('/claims/:id/attachments-evidences/:attachmentId/download', async (req, res) => {
  try {
    const claimId = encodeURIComponent(req.params.id);
    const att = encodeURIComponent(req.params.attachmentId);
    const r = await mlFetchRaw(req, `${ML_BASE}/claims/${claimId}/attachments-evidences/${att}/download`);
    // Propaga headers principais
    const ct = r.headers.get('content-type') || 'application/octet-stream';
    const disp = r.headers.get('content-disposition') || `inline; filename="${att}"`;
    res.set('Content-Type', ct);
    res.set('Content-Disposition', disp);
    const ab = await r.arrayBuffer();
    return res.send(Buffer.from(ab));
  } catch (e) {
    const s = e.status || 500;
    return res.status(s).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

/* =========================================================================
 *  5) CUSTO DE DEVOLUÇÃO (return-cost)
 * ========================================================================= */

/**
 * GET /api/ml/claims/:id/charges/return-cost
 * Query opcional:
 *   ?usd=true  -> repassa calculate_amount_usd=true
 */
router.get('/claims/:id/charges/return-cost', async (req, res) => {
  try {
    const claimId = String(req.params.id || '').replace(/\D/g, '');
    if (!claimId) return res.status(400).json({ error: 'invalid_claim_id' });

    const wantUsd = (req.query.usd === 'true' || req.query.calculate_amount_usd === 'true');
    const qs = wantUsd ? '?calculate_amount_usd=true' : '';
    const url = `${ML_BASE}/claims/${encodeURIComponent(claimId)}/charges/return-cost${qs}`;

    const out = await mlFetch(req, url);
    const data = {
      claim_id: Number(claimId) || claimId,
      currency_id: out?.currency_id || 'BRL',
      amount: Number(out?.amount || 0),
      amount_usd: (out?.amount_usd != null ? Number(out.amount_usd) : null)
    };
    return res.json({ data });
  } catch (e) {
    const s = e.status || 500;
    return res.status(s).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

module.exports = router;
