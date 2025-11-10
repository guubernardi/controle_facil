// server/routes/ml-shipping.js
'use strict';

const express = require('express');
const { query } = require('../db');

const router = express.Router();
const ML_BASE = 'https://api.mercadolibre.com';

// ---------------- Token resolving ----------------
async function loadTokenRowFromDb(sellerId, q = query) {
  const sql = `
    SELECT user_id, access_token, expires_at
      FROM public.ml_tokens
     WHERE user_id = $1
     ORDER BY updated_at DESC
     LIMIT 1`;
  const { rows } = await q(sql, [sellerId]);
  return rows[0] || null;
}

async function resolveSellerAccessToken(req) {
  const direct = req.get('x-seller-token');
  if (direct) return direct;

  const sellerId = String(
    req.get('x-seller-id') || req.query.seller_id || req.session?.ml?.user_id || ''
  ).replace(/\D/g, '');
  if (sellerId) {
    const row = await loadTokenRowFromDb(sellerId);
    if (row?.access_token) return row.access_token;
  }

  if (req.session?.ml?.access_token) return req.session.ml.access_token;
  return process.env.MELI_OWNER_TOKEN || '';
}

async function mget(req, path) {
  const token = await resolveSellerAccessToken(req);
  if (!token) {
    const e = new Error('missing_access_token');
    e.status = 401;
    throw e;
  }
  const url = ML_BASE + path;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  const txt = await r.text();
  let j = {}; try { j = txt ? JSON.parse(txt) : {}; } catch {}
  if (!r.ok) {
    const err = new Error(j?.message || j?.error || r.statusText);
    err.status = r.status; err.body = j;
    throw err;
  }
  return j;
}

// ---------------- Helpers locais ----------------
function mapShipmentToLog(status = '', substatus = '') {
  const s  = String(status).toLowerCase();
  const ss = String(substatus).toLowerCase();

  if (/(ready_to_ship|handling|to_be_agreed|ready|prepar)/.test(s) || /(ready|prep|etiq|label)/.test(ss))
    return 'em_preparacao';

  if (/(shipped|in_transit)/.test(s) || /(transit|transporte|out_for_delivery|returning_to_sender)/.test(ss))
    return 'em_transporte';

  if (/delivered/.test(s) || /(delivered|entreg|arrived|recebid)/.test(ss))
    return 'recebido_cd';

  if (/not_delivered/.test(s)) return 'em_transporte';
  return null;
}

async function tableHasColumns(table, cols) {
  const { rows } = await query(
    `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1`,
    [table]
  );
  const set = new Set(rows.map(r => r.column_name));
  const out = {}; for (const c of cols) out[c] = set.has(c);
  return out;
}

async function updateReturnLogStatusIfAny(orderId, suggestedLog) {
  if (!orderId || !suggestedLog) return { updated: false };
  const has = await tableHasColumns('devolucoes', ['id','id_venda','order_id','log_status','updated_at']);

  const whereCol = has.id_venda ? 'id_venda' : (has.order_id ? 'order_id' : null);
  if (!whereCol || !has.log_status) return { updated: false };

  const { rowCount } = await query(
    `UPDATE devolucoes
        SET log_status = $1,
            ${has.updated_at ? 'updated_at = now(),' : ''}
            ${whereCol} = ${whereCol}  -- no-op p/ manter SQL válido
      WHERE ${whereCol} = $2`,
    [suggestedLog, String(orderId)]
  );
  return { updated: !!rowCount, rowCount };
}

async function fetchShipmentsByOrder(req, orderId) {
  let shipments = null;
  try {
    const j = await mget(req, `/orders/${encodeURIComponent(orderId)}/shipments`);
    shipments = Array.isArray(j) ? j : (Array.isArray(j?.shipments) ? j.shipments : null);
  } catch {
    const j = await mget(req, `/shipments/search?order_id=${encodeURIComponent(orderId)}`);
    shipments = Array.isArray(j?.results) ? j.results : null;
  }
  return shipments || [];
}

async function computeBestLogForOrder(req, orderId) {
  const list = await fetchShipmentsByOrder(req, orderId);
  if (!list.length) return { bestLog: null, details: [] };

  const details = [];
  let bestLog = null;
  const rank = { em_preparacao: 1, em_transporte: 2, recebido_cd: 3 };

  for (const s of list) {
    const id = s?.id || s?.shipment_id || s;
    if (!id) continue;
    const d = await mget(req, `/shipments/${encodeURIComponent(id)}`).catch(() => null);
    if (!d) continue;
    details.push(d);
    const sug = mapShipmentToLog(d.status, d.substatus);
    if (sug && (!bestLog || (rank[sug] || 0) > (rank[bestLog] || 0))) bestLog = sug;
  }
  return { bestLog, details };
}

// ---------------- Rotas ----------------

// Stub pra matar 404 do front (ok deixar)
router.get('/messages/sync', (req, res) => {
  const days = parseInt(req.query.days || req.query._days || '0', 10) || null;
  return res.json({ ok: true, stub: true, days, note: 'messages/sync ainda não implementado; endpoint de placeholder.' });
});

/** GET /api/ml/shipping/by-order/:orderId */
router.get('/shipping/by-order/:orderId', async (req, res) => {
  try {
    const orderId = String(req.params.orderId || '').replace(/\D/g, '');
    if (!orderId) return res.status(400).json({ error: 'order_id inválido' });

    const list = await fetchShipmentsByOrder(req, orderId);
    const details = [];
    for (const s of list) {
      const id = s?.id || s?.shipment_id || s;
      if (!id) continue;
      const d = await mget(req, `/shipments/${encodeURIComponent(id)}`).catch(() => null);
      details.push(d || { id, error: 'fetch_failed' });
    }
    return res.json({ order_id: orderId, shipments: details });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, detail: e.body || null });
  }
});

/** GET /api/ml/shipping/status?order_id=... */
router.get('/shipping/status', async (req, res) => {
  try {
    const orderId = String(req.query.order_id || '').replace(/\D/g, '');
    if (!orderId) return res.status(400).json({ error: 'order_id é obrigatório' });

    const { bestLog, details } = await computeBestLogForOrder(req, orderId);
    const main = details.sort((a,b) =>
      new Date(b?.last_updated || b?.date_created || 0) - new Date(a?.last_updated || a?.date_created || 0)
    )[0] || null;

    return res.json({
      order_id: orderId,
      shipment_id: main?.id || null,
      ml_status: main?.status || null,
      ml_substatus: main?.substatus || null,
      suggested_log_status: bestLog || null,
      last_updated: main?.last_updated || null
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, detail: e.body || null });
  }
});

/**
 * GET /api/ml/shipping/sync
 * - ?order_id=...     (principal)
 * - ?days=...&limit=N (bulk real)
 */
router.get('/shipping/sync', async (req, res) => {
  try {
    const orderId = String(req.query.order_id || '').replace(/\D/g, '');
    const days    = parseInt(req.query.days || req.query._days || req.query.recent_days || '0', 10) || null;
    const limit   = Math.min(300, Math.max(1, parseInt(req.query.limit || '100', 10) || 100));

    // ---- per-order ----
    if (orderId) {
      const { bestLog, details } = await computeBestLogForOrder(req, orderId);
      const upd = await updateReturnLogStatusIfAny(orderId, bestLog);
      return res.json({
        ok: true,
        order_id: orderId,
        suggested_log_status: bestLog || null,
        db_update: upd,
        shipments: details
      });
    }

    // ---- bulk ----
    if (!days) return res.status(400).json({ error: 'Informe ?order_id=... ou ?days=...' });

    // pega devoluções recentes com id_venda/order_id numérico
    const sql = `
      SELECT id, 
             COALESCE(NULLIF(id_venda, '')::text, NULLIF(order_id::text, '')) AS order_id
        FROM devolucoes
       WHERE COALESCE(NULLIF(id_venda, '') ~ '^[0-9]+$', FALSE)
          OR COALESCE(NULLIF(order_id::text, '') ~ '^[0-9]+$', FALSE)
         AND (created_at IS NULL OR created_at >= now() - make_interval(days => $1::int))
       ORDER BY created_at DESC NULLS LAST
       LIMIT $2
    `;
    const { rows } = await query(sql, [days, limit]);

    let processed = 0, updated = 0, failures = 0;
    const results = [];

    for (const r of rows) {
      const oid = String(r.order_id || '').replace(/\D/g, '');
      if (!oid) continue;
      try {
        const { bestLog } = await computeBestLogForOrder(req, oid);
        const upd = await updateReturnLogStatusIfAny(oid, bestLog);
        processed++; if (upd.updated) updated++;
        results.push({ order_id: oid, suggested_log_status: bestLog || null, db_update: upd });
      } catch (e) {
        failures++;
        results.push({ order_id: oid, error: String(e?.message || e) });
      }
    }

    return res.json({ ok:true, days, limit, processed, updated, failures, results });
  } catch (e) {
    const s = e.status || 500;
    return res.status(s).json({ error: e.message, detail: e.body || null });
  }
});

module.exports = router;
