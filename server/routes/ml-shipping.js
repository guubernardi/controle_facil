// server/routes/ml-shipping.js
'use strict';

const express = require('express');
const router  = express.Router();
const { query } = require('../db');

// ---- fetch helper (Node 18+ tem fetch nativo; senão cai no node-fetch) ----
const _fetch = (typeof fetch === 'function')
  ? (...a) => fetch(...a)
  : (...a) => import('node-fetch').then(({ default: f }) => f(...a));

// -------- Helpers de coluna (cache simples) --------
const _colsCache = {};
async function tableHasColumns(table, cols) {
  const key = `${table}:${cols.join(',')}`;
  if (_colsCache[key]) return _colsCache[key];
  const { rows } = await query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1`,
    [table]
  );
  const set = new Set(rows.map(r => r.column_name));
  const out = {}; for (const c of cols) out[c] = set.has(c);
  _colsCache[key] = out;
  return out;
}

// -------- Canon do fluxo a partir do status/substatus do shipping --------
function normalizeFlow(mlStatus, mlSub) {
  const s   = String(mlStatus || '').toLowerCase();
  const sub = String(mlSub     || '').toLowerCase();

  if (/^(ready_to_ship|handling|to_be_agreed)$/.test(s) || /(label|ready)/.test(sub)) {
    return 'em_preparacao';
  }
  if (/^(shipped|not_delivered|in_transit|returning|shipping)$/.test(s) ||
      /(in_transit|on_the_way|shipping_in_progress|out_for_delivery|returning_to_sender)/.test(sub)) {
    return 'em_transporte';
  }
  if (/^delivered$/.test(s) || /(delivered|arrived|recebid)/.test(sub)) {
    return 'recebido_cd';
  }
  if (/^cancel/.test(s) || /(returned|fechado|devolvido|closed)/.test(sub)) {
    return 'fechado';
  }
  return 'pendente';
}

// -------- Token resolver --------
async function getActiveMlToken(req) {
  // 1) Sessão (se você salva assim)
  if (req?.session?.user?.ml?.access_token) return req.session.user.ml.access_token;

  // 2) Authorization: Bearer
  const hAuth = req.get('authorization') || '';
  const m = hAuth.match(/Bearer\s+(.+)/i);
  if (m) return m[1];

  // 3) Seller headers vindos do front
  const sellerId   = req.get('x-seller-id')   || null;
  const sellerNick = req.get('x-seller-nick') || null;

  // 4) ml_tokens por seller_id/user_id e/ou nickname (pega o mais recente)
  try {
    const cols = await tableHasColumns('ml_tokens', [
      'is_active','seller_id','user_id','seller_nick','nickname','access_token','updated_at'
    ]);

    const where = [];
    const params = [];
    let p = 1;

    if (cols.is_active) where.push(`is_active IS TRUE`);

    const who = [];
    if (sellerId && cols.seller_id)  { who.push(`seller_id::text = $${p++}`);   params.push(String(sellerId)); }
    if (sellerId && cols.user_id)    { who.push(`user_id::text   = $${p++}`);   params.push(String(sellerId)); }
    if (sellerNick && cols.seller_nick) { who.push(`LOWER(seller_nick)=LOWER($${p++})`); params.push(sellerNick); }
    if (sellerNick && cols.nickname) { who.push(`LOWER(nickname)  =LOWER($${p++})`);     params.push(sellerNick); }

    if (who.length) where.push(`(${who.join(' OR ')})`);

    const { rows } = await query(
      `SELECT access_token
         FROM ml_tokens
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 1`,
      params
    );
    if (rows[0]?.access_token) return rows[0].access_token;
  } catch (_) {}

  // 5) Fallback global
  if (process.env.ML_ACCESS_TOKEN) return process.env.ML_ACCESS_TOKEN;
  return null;
}

// -------- HTTP helper --------
async function mlFetch(path, token, opts = {}) {
  const base = 'https://api.mercadolibre.com';
  const res = await _fetch(base + path, {
    method: opts.method || 'GET',
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...(opts.headers || {})
    },
    body: opts.body || null
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json')
    ? await res.json().catch(() => ({}))
    : await res.text().catch(() => '');

  if (!res.ok) {
    const msg = data?.message || data?.error || `HTTP ${res.status}`;
    const err = new Error(msg); err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}

// -------- Status a partir de order_id --------
async function getShippingStatusFromOrder(orderId, token) {
  // 0) /orders/:id/shipments (algumas contas retornam direto aqui)
  try {
    const oShips = await mlFetch(`/orders/${encodeURIComponent(orderId)}/shipments`, token);
    const ship0  = Array.isArray(oShips) ? oShips[0] : oShips;
    if (ship0) {
      let st = ship0.status || null;
      let ss = ship0.substatus || null;
      const sid = ship0.id || ship0.shipment_id || null;
      if ((!st || !ss) && sid) {
        const d = await mlFetch(`/shipments/${encodeURIComponent(sid)}`, token).catch(() => null);
        if (d) { st = d.status || st; ss = d.substatus || ss; }
      }
      if (st || ss || sid) return { shipmentId: sid || null, mlStatus: st || null, mlSubstatus: ss || null };
    }
  } catch (_) { /* continua */ }

  // 1) /orders/{id} => pega shipment_id
  let shipmentId = null;
  try {
    const order = await mlFetch(`/orders/${encodeURIComponent(orderId)}`, token);
    shipmentId = order?.shipping?.id || order?.shipping_id || order?.shipping?.id_shipping || null;
  } catch (_) {}

  // 2) se não achou, tenta buscas alternativas
  if (!shipmentId) {
    const search =
        await mlFetch(`/shipments/search?order=${encodeURIComponent(orderId)}`, token).catch(() => null)
     || await mlFetch(`/shipments/search?order_id=${encodeURIComponent(orderId)}`, token).catch(() => null)
     || await mlFetch(`/shipments/search?pack=${encodeURIComponent(orderId)}`, token).catch(() => null);

    const first = search?.results?.[0];
    if (first?.id) {
      return { shipmentId: first.id, mlStatus: first.status || null, mlSubstatus: first.substatus || null };
    }
    return { shipmentId: null, mlStatus: null, mlSubstatus: null };
  }

  // 3) /shipments/{id}
  const ship = await mlFetch(`/shipments/${encodeURIComponent(shipmentId)}`, token);
  return {
    shipmentId,
    mlStatus: ship?.status || null,
    mlSubstatus: ship?.substatus || null
  };
}

// -------- Atualiza DB com segurança de colunas --------
async function updateReturnShipping({ orderId, mlStatus, mlSubstatus, logStatus }) {
  const cols = await tableHasColumns('devolucoes', [
    'ml_shipping_status','log_status','updated_at','id_venda','updated_by'
  ]);
  const sets = [];
  const params = [];
  let p = 1;

  if (cols.ml_shipping_status) { sets.push(`ml_shipping_status = $${p++}`); params.push(mlSubstatus || mlStatus || null); }
  if (cols.log_status && logStatus) { sets.push(`log_status = $${p++}`); params.push(logStatus); }
  if (cols.updated_by) { sets.push(`updated_by = 'ml-shipping'`); }
  if (cols.updated_at) sets.push(`updated_at = now()`);

  if (!sets.length) return { updated: false };

  params.push(orderId);
  await query(
    `UPDATE devolucoes
        SET ${sets.join(', ')}
      WHERE id_venda = $${p}`,
    params
  );
  return { updated: true };
}

// -------- Fallback sem token: tenta devolver status do próprio banco --------
async function fallbackFromDb(orderId) {
  const { rows } = await query(
    `SELECT log_status, ml_shipping_status, shipping_status
       FROM devolucoes
      WHERE id_venda = $1
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 1`,
    [orderId]
  );
  const r = rows[0] || {};
  const mlStatus = r.shipping_status || r.ml_shipping_status || null;
  const logStatus = r.log_status || normalizeFlow(mlStatus, null);
  return {
    ml_status: r.shipping_status || null,
    ml_substatus: r.ml_shipping_status || null,
    suggested_log_status: logStatus,
    fallback: true
  };
}

// -------- GET /api/ml/shipping/status --------
router.get('/shipping/status', async (req, res) => {
  try {
    const orderId    = req.query.order_id || req.query.orderId;
    const shipmentIdQ = req.query.shipment_id || req.query.shipmentId || null;
    const doUpdate   = String(req.query.update ?? '1') !== '0';

    if (!orderId && !shipmentIdQ) {
      return res.status(400).json({ error: 'missing_param', detail: 'Informe order_id ou shipment_id' });
    }

    const token = await getActiveMlToken(req);
    if (!token) {
      if (orderId) {
        const fb = await fallbackFromDb(orderId);
        return res.status(401).json({ // importante para o front acionar o breaker
          error: 'missing_access_token',
          order_id: orderId,
          shipment_id: null,
          ml_status: fb.ml_status || null,
          ml_substatus: fb.ml_substatus || null,
          suggested_log_status: fb.suggested_log_status || null,
          fallback: true
        });
      }
      return res.status(401).json({ error: 'missing_access_token' });
    }

    let shipmentId = shipmentIdQ || null;
    let mlStatus = null, mlSubstatus = null;

    if (shipmentId) {
      const ship = await mlFetch(`/shipments/${encodeURIComponent(shipmentId)}`, token);
      mlStatus = ship?.status || null;
      mlSubstatus = ship?.substatus || null;
    } else {
      const s = await getShippingStatusFromOrder(orderId, token);
      shipmentId = s.shipmentId;
      mlStatus   = s.mlStatus;
      mlSubstatus= s.mlSubstatus;
    }

    const suggested = normalizeFlow(mlStatus, mlSubstatus);

    if (doUpdate && orderId) {
      await updateReturnShipping({ orderId, mlStatus, mlSubstatus, logStatus: suggested });
    }

    res.json({
      ok: true,
      order_id: orderId || null,
      shipment_id: shipmentId || null,
      ml_status: mlStatus,
      ml_substatus: mlSubstatus,
      suggested_log_status: suggested
    });
  } catch (e) {
    const code = e?.status || 500;
    res.status(code).json({ error: String(e?.message || e) });
  }
});

// -------- GET /api/ml/shipping/sync --------
// - ?order_id=... => sincroniza apenas esse pedido
// - ?days=30      => sincroniza pedidos criados nos últimos N dias
router.get('/shipping/sync', async (req, res) => {
  try {
    const orderId = req.query.order_id || req.query.orderId || null;
    const days    = parseInt(req.query.days || req.query.recent_days || '0', 10) || 0;
    const silent  = /^1|true$/i.test(String(req.query.silent || '0'));

    const token = await getActiveMlToken(req);
    if (!token) {
      return res.status(401).json({ error: 'missing_access_token', updated: 0, total: 0 });
    }

    const touched = [];
    const errs = [];

    const runOne = async (oid) => {
      try {
        const s = await getShippingStatusFromOrder(oid, token);
        const suggested = normalizeFlow(s.mlStatus, s.mlSubstatus);
        await updateReturnShipping({
          orderId: oid,
          mlStatus: s.mlStatus,
          mlSubstatus: s.mlSubstatus,
          logStatus: suggested
        });
        touched.push({
          order_id: oid,
          shipment_id: s.shipmentId,
          ml_status: s.mlStatus,
          ml_substatus: s.mlSubstatus,
          suggested_log_status: suggested
        });
      } catch (e) {
        errs.push({ order_id: oid, error: String(e?.message || e) });
      }
    };

    if (orderId) {
      await runOne(orderId);
    } else if (days > 0) {
      const { rows } = await query(
        `SELECT DISTINCT id_venda
           FROM devolucoes
          WHERE id_venda IS NOT NULL
            AND (created_at IS NULL OR created_at >= now() - ($1 || ' days')::interval)
          LIMIT 400`,
        [String(days)]
      );
      const ids = rows.map(r => String(r.id_venda)).filter(Boolean);
      const chunk = 25;
      for (let i = 0; i < ids.length; i += chunk) {
        const part = ids.slice(i, i + chunk);
        await Promise.allSettled(part.map(runOne));
      }
    } else {
      return res.status(400).json({ error: 'missing_param', detail: 'Informe order_id ou days' });
    }

    const out = { ok: true, total: touched.length, updated: touched.length, errors: errs };
    if (!silent) out.touched = touched;
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

module.exports = router;
