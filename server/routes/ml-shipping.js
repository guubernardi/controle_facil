// server/routes/ml-shipping.js
'use strict';

const express = require('express');
const { query } = require('../db');

const router = express.Router();

// =================== Config ML ===================
const ML_API = 'https://api.mercadolibre.com';
const ML_TOKEN_URL = process.env.ML_TOKEN_URL || `${ML_API}/oauth/token`;
const AHEAD_SEC = parseInt(process.env.ML_REFRESH_AHEAD_SEC || '600', 10) || 600; // refresh 10min antes

// =================== Helpers de token (mesmo padrão do ml-claims.js) ===================
async function loadTokenRowFromDb(sellerId, q = query) {
  const { rows } = await q(
    `SELECT user_id, nickname, access_token, refresh_token, expires_at
       FROM public.ml_tokens
      WHERE user_id = $1
      ORDER BY updated_at DESC
      LIMIT 1`,
    [sellerId]
  );
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
async function mlFetch(req, path, opts = {}) {
  const token = await resolveSellerAccessToken(req);
  if (!token) { const e = new Error('missing_access_token'); e.status = 401; throw e; }
  const url = path.startsWith('http') ? path : `${ML_API}${path}`;
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
    err.status = r.status; err.body = body;
    throw err;
  }
  return body;
}

// =================== Shipping helpers ===================
function canonFlow(status, substatus) {
  const t = `${String(status||'').toLowerCase()}_${String(substatus||'').toLowerCase()}`;
  if (/(mediat)/.test(t)) return 'em_mediacao';
  if (/(prep|prepar|embal|label|etiq|ready|pronto)/.test(t)) return 'aguardando_postagem';
  if (/(transit|transito|transporte|enviado|out_for_delivery|returning|shipped)/.test(t)) return 'em_transito';
  if (/(delivered|entreg|arrived|recebid)/.test(t)) return 'recebido_cd';
  if (/(closed|fechado|finaliz|returned)/.test(t)) return 'devolvido';
  return 'pendente';
}

async function getShipmentByOrder(req, orderId) {
  // 1) /orders/{id} → shipping.id
  try {
    const order = await mlFetch(req, `/orders/${encodeURIComponent(orderId)}`);
    const shipId = order?.shipping?.id || order?.shipping_id || null;
    if (shipId) {
      const sh = await mlFetch(req, `/shipments/${encodeURIComponent(shipId)}`);
      return { shipment: sh, order, shipId };
    }
  } catch (_) { /* cai no fallback */ }

  // 2) fallback /shipments/search?order_id=...
  try {
    const sr = await mlFetch(req, `/shipments/search?order_id=${encodeURIComponent(orderId)}`);
    const results = Array.isArray(sr?.results) ? sr.results : (Array.isArray(sr) ? sr : []);
    const first = results[0] || null;
    if (first?.id) {
      const sh = await mlFetch(req, `/shipments/${encodeURIComponent(first.id)}`);
      return { shipment: sh, order: null, shipId: first.id };
    }
  } catch (_) {}

  return { shipment: null, order: null, shipId: null };
}

function pickStatusFields(sh) {
  const status    = sh?.status || sh?.substatus || sh?.shipping_status || null;
  const substatus = sh?.substatus || sh?.sub_status || null;
  return { status, substatus };
}

// =================== ROTAS ===================

// 1) /api/ml/shipping/status?order_id=...
router.get('/shipping/status', async (req, res) => {
  try {
    const orderId = String(req.query.order_id || '').trim();
    if (!orderId) return res.status(400).json({ error: 'missing_order_id' });

    const { shipment, order, shipId } = await getShipmentByOrder(req, orderId);
    if (!shipment) return res.status(404).json({ error: 'shipment_not_found', order_id: orderId });

    const { status, substatus } = pickStatusFields(shipment);
    return res.json({
      order_id: orderId,
      shipping_id: shipId || shipment?.id || null,
      status: String(status || '').toLowerCase(),
      substatus: String(substatus || '').toLowerCase(),
      flow: canonFlow(status, substatus),
      raw: shipment
    });
  } catch (e) {
    const s = e.status || 500;
    res.status(s).json({ error: e.message, detail: e.body || null });
  }
});

// 2) /api/ml/shipping/state?order_id=...  (igual ao /status, só nome semântico)
router.get('/shipping/state', async (req, res) => {
  try {
    const orderId = String(req.query.order_id || '').trim();
    if (!orderId) return res.status(400).json({ error: 'missing_order_id' });
    const { shipment, shipId } = await getShipmentByOrder(req, orderId);
    if (!shipment) return res.status(404).json({ error: 'shipment_not_found', order_id: orderId });

    const { status, substatus } = pickStatusFields(shipment);
    res.json({
      order_id: orderId,
      shipping_id: shipId || shipment?.id || null,
      status: String(status || '').toLowerCase(),
      substatus: String(substatus || '').toLowerCase(),
      flow: canonFlow(status, substatus),
      data: shipment
    });
  } catch (e) {
    const s = e.status || 500;
    res.status(s).json({ error: e.message, detail: e.body || null });
  }
});

// 3) /api/ml/shipping/by-order/:orderId  (atalho REST)
router.get('/shipping/by-order/:orderId', async (req, res) => {
  try {
    const orderId = String(req.params.orderId || '').trim();
    if (!orderId) return res.status(400).json({ error: 'missing_order_id' });
    const { shipment, order, shipId } = await getShipmentByOrder(req, orderId);
    if (!shipment) return res.status(404).json({ error: 'shipment_not_found', order_id: orderId });
    res.json({ order_id: orderId, shipping_id: shipId || shipment?.id || null, order: order || null, shipment });
  } catch (e) {
    const s = e.status || 500;
    res.status(s).json({ error: e.message, detail: e.body || null });
  }
});

// 4) /api/ml/orders/:orderId/shipping  (o front tentou essa URL)
router.get('/orders/:orderId/shipping', async (req, res) => {
  try {
    const orderId = String(req.params.orderId || '').trim();
    if (!orderId) return res.status(400).json({ error: 'missing_order_id' });
    const { shipment, order, shipId } = await getShipmentByOrder(req, orderId);
    if (!shipment) return res.status(404).json({ error: 'shipment_not_found', order_id: orderId });
    res.json({ order_id: orderId, shipping_id: shipId || shipment?.id || null, order: order || null, shipment });
  } catch (e) {
    const s = e.status || 500;
    res.status(s).json({ error: e.message, detail: e.body || null });
  }
});

// 5) /api/ml/shipments?order_id=...  (proxy do search)
router.get('/shipments', async (req, res) => {
  try {
    const orderId = String(req.query.order_id || '').trim();
    if (!orderId) return res.status(400).json({ error: 'missing_order_id' });
    const data = await mlFetch(req, `/shipments/search?order_id=${encodeURIComponent(orderId)}`);
    res.json(data || {});
  } catch (e) {
    const s = e.status || 500;
    res.status(s).json({ error: e.message, detail: e.body || null });
  }
});

module.exports = router;
