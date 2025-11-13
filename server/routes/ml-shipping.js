// server/routes/ml-shipping.js
'use strict';

const express = require('express');
const router  = express.Router();
const { query } = require('../db');

// -------- fetch (Node 18+ tem fetch; senão cai no node-fetch) --------
const _fetch = (typeof fetch === 'function')
  ? fetch
  : (...a) => import('node-fetch').then(({ default: f }) => f(...a));

// -------- Helpers de coluna (cache simples) --------
const _colsCache = {};
async function tableHasColumns(table, cols) {
  const key = `${table}:${cols.join(',')}`;
  if (_colsCache[key]) return _colsCache[key];
  const { rows } = await query(
    `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1`,
    [table]
  );
  const set = new Set(rows.map(r => r.column_name));
  const out = {}; for (const c of cols) out[c] = set.has(c);
  _colsCache[key] = out;
  return out;
}

/**
 * Normalização de fluxo baseada APENAS no shipping do PEDIDO.
 * Importante: shipping "delivered" NÃO vira "recebido_cd".
 * Só a DEVOLUÇÃO (ml_return_status === 'delivered') pode marcar recebido no CD.
 */
function normalizeFlow(mlStatus, mlSub) {
  const s   = String(mlStatus || '').toLowerCase();
  const sub = String(mlSub    || '').toLowerCase();

  if (/^ready_to_ship|handling|to_be_agreed/.test(s) || /(label|ready|etiq|pronto)/.test(sub)) {
    return 'em_preparacao';
  }
  if (/^shipped|not_delivered|in_transit|returning|shipping/.test(s) ||
      /(in_transit|on_the_way|shipping_in_progress|out_for_delivery|a_caminho|em_transito)/.test(sub)) {
    return 'em_transporte';
  }
  // delivered de shipping NÃO promove
  if (/^delivered$/.test(s) || /(delivered|arrived|recebid|entreg)/.test(sub)) {
    return 'pendente';
  }
  if (/^cancel/.test(s) || /(returned|fechado|devolvido|closed|cancel)/.test(sub)) {
    return 'fechado';
  }
  return 'pendente';
}

// -------- Token resolver --------
async function getActiveMlToken(req) {
  // 1) sessão
  if (req?.session?.user?.ml?.access_token) return req.session.user.ml.access_token;
  if (req?.user?.ml?.access_token)         return req.user.ml.access_token;

  // 2) Authorization: Bearer
  const hAuth = req.get('authorization') || '';
  const m = hAuth.match(/Bearer\s+(.+)/i);
  if (m) return m[1];

  // 3) headers da loja
  const sellerIdRaw = req.get('x-seller-id') || null;
  const sellerNick  = req.get('x-seller-nick') || null;
  const sellerId    = sellerIdRaw && /^\d+$/.test(sellerIdRaw) ? sellerIdRaw : null;

  // 4) ml_tokens
  try {
    const cols = await tableHasColumns('ml_tokens', ['is_active','user_id','nickname','access_token','updated_at']);
    const where = [];
    const params = [];
    let p = 1;

    if (cols.is_active) where.push(`is_active IS TRUE`);
    if (sellerId)       { where.push(`user_id = $${p++}::bigint`); params.push(sellerId); }
    if (sellerNick)     { where.push(`lower(nickname) = lower($${p++})`); params.push(sellerNick); }

    const sql = `
      SELECT access_token
        FROM ml_tokens
       ${where.length ? `WHERE ${where.join(' AND ')}` : ``}
       ORDER BY updated_at DESC NULLS LAST
       LIMIT 1`;
    const { rows } = await query(sql, params);
    if (rows[0]?.access_token) return rows[0].access_token;
  } catch (_) {}

  // 5) Fallback global
  if (process.env.ML_ACCESS_TOKEN) return process.env.ML_ACCESS_TOKEN;
  return null;
}

// -------- HTTP helper (propaga status do ML) --------
async function mlFetch(path, token, opts = {}) {
  const base = 'https://api.mercadolibre.com';
  const res = await _fetch(base + path, {
    method: opts.method || 'GET',
    headers: {
      'Accept': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      ...(opts.headers || {})
    },
    body: opts.body || null
  });

  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json')
    ? await res.json().catch(() => ({}))
    : await res.text().catch(() => '');

  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// -------- Fallback sem token/sem acesso: consulta do próprio banco --------
async function fallbackFromDb(orderId) {
  const cols = await tableHasColumns('devolucoes', ['ml_shipping_status','shipping_status','log_status','updated_at','id_venda']);

  // Monta SELECT apenas com colunas existentes
  const fields = [];
  if (cols.log_status)         fields.push('log_status');
  if (cols.ml_shipping_status) fields.push('ml_shipping_status');
  if (cols.shipping_status)    fields.push('shipping_status');

  if (!fields.length) {
    return {
      order_id: orderId,
      shipment_id: null,
      ml_status: null,
      ml_substatus: null,
      suggested_log_status: 'pendente',
      fallback: true
    };
  }

  const sql = `
    SELECT ${fields.join(', ')}
      FROM devolucoes
     WHERE id_venda = $1
     ORDER BY updated_at DESC NULLS LAST
     LIMIT 1`;
  const { rows } = await query(sql, [orderId]);
  const r = rows[0] || {};

  const mlStatus    = cols.shipping_status    ? (r.shipping_status ?? null)    : null;
  const mlSubstatus = cols.ml_shipping_status ? (r.ml_shipping_status ?? null) : null;

  const logStatus = cols.log_status && r.log_status
    ? r.log_status
    : normalizeFlow(mlStatus, mlSubstatus);

  return {
    order_id: orderId,
    shipment_id: null,
    ml_status: mlStatus,
    ml_substatus: mlSubstatus,
    suggested_log_status: logStatus,
    fallback: true
  };
}

// -------- Status a partir de order_id --------
async function getShippingStatusFromOrder(orderId, token) {
  // 1) /orders/{id} => pega shipment_id se possível
  try {
    const order = await mlFetch(`/orders/${encodeURIComponent(orderId)}`, token);
    const shipmentId =
      order?.shipping?.id ||
      order?.shipping_id ||
      order?.shipping?.id_shipping ||
      null;

    if (shipmentId) {
      const ship = await mlFetch(`/shipments/${encodeURIComponent(shipmentId)}`, token);
      return {
        shipmentId,
        mlStatus:    ship?.status    || null,
        mlSubstatus: ship?.substatus || null
      };
    }
  } catch (e) {
    if (e?.status) throw e; // 401/403/404 → propaga
    throw new Error(`orders fetch failed: ${e?.message || e}`);
  }

  // 2) tentar localizar shipment via search (variações)
  const searchPaths = [
    `/shipments/search?order=${encodeURIComponent(orderId)}`,
    `/shipments/search?order_id=${encodeURIComponent(orderId)}`,
    `/shipments/search?pack=${encodeURIComponent(orderId)}`
  ];

  for (const path of searchPaths) {
    try {
      const search = await mlFetch(path, token);
      const first =
        (Array.isArray(search?.results) && search.results[0]) ||
        (Array.isArray(search?.data)    && search.data[0]) ||
        null;
      if (first?.id) {
        const ship = await mlFetch(`/shipments/${encodeURIComponent(first.id)}`, token);
        return {
          shipmentId:  first.id,
          mlStatus:    ship?.status    || first.status    || null,
          mlSubstatus: ship?.substatus || first.substatus || null
        };
      }
    } catch (e) {
      if (e?.status === 401 || e?.status === 403) throw e; // sem acesso
      // 404 aqui = "não achei" — tenta a próxima variação
    }
  }

  // 3) nada encontrado
  return { shipmentId: null, mlStatus: null, mlSubstatus: null };
}

// -------- Atualiza DB com segurança de colunas --------
async function updateReturnShipping({ orderId, mlStatus, mlSubstatus, logStatus }) {
  const cols = await tableHasColumns('devolucoes', ['ml_shipping_status','shipping_status','log_status','updated_at','id_venda']);
  const sets = [];
  const params = [];
  let p = 1;

  if (cols.ml_shipping_status) {
    sets.push(`ml_shipping_status = $${p++}`);
    params.push(mlSubstatus || mlStatus || null);
  }
  if (cols.shipping_status) {
    sets.push(`shipping_status = $${p++}`);
    params.push(mlStatus || null);
  }
  if (cols.log_status && logStatus) {
    sets.push(`log_status = $${p++}`);
    params.push(logStatus);
  }
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

// -------- GET /api/ml/shipping/status --------
router.get('/shipping/status', async (req, res) => {
  try {
    const orderId     = req.query.order_id  || req.query.orderId  || null;
    const shipmentIdQ = req.query.shipment_id || req.query.shipmentId || null;

    // IMPORTANTE: por padrão NÃO atualiza. Só grava quando update=1.
    const doUpdate = /^1|true$/i.test(String(req.query.update || '0'));

    if (!orderId && !shipmentIdQ) {
      return res.status(400).json({ error: 'missing_param', detail: 'Informe order_id ou shipment_id' });
    }

    const token = await getActiveMlToken(req);
    if (!token) {
      if (orderId) {
        const fb = await fallbackFromDb(orderId);
        return res.json({ ok: true, ...fb });
      }
      return res.status(401).json({ error: 'missing_access_token' });
    }

    let shipmentId = shipmentIdQ || null;
    let mlStatus = null, mlSubstatus = null;

    if (shipmentId) {
      const ship = await mlFetch(`/shipments/${encodeURIComponent(shipmentId)}`, token);
      mlStatus    = ship?.status    || null;
      mlSubstatus = ship?.substatus || null;
    } else {
      const s = await getShippingStatusFromOrder(orderId, token);
      shipmentId = s.shipmentId;
      mlStatus    = s.mlStatus;
      mlSubstatus = s.mlSubstatus;
    }

    const suggested = normalizeFlow(mlStatus, mlSubstatus);

    if (doUpdate && orderId) {
      await updateReturnShipping({ orderId, mlStatus, mlSubstatus, logStatus: suggested });
    }

    return res.json({
      ok: true,
      order_id: orderId || null,
      shipment_id: shipmentId || null,
      ml_status: mlStatus,
      ml_substatus: mlSubstatus,
      suggested_log_status: suggested
    });
  } catch (e) {
    const code = e?.status || 500;

    // Para 401/403/404, se houver order_id, tente fallback do banco
    const orderId = req.query.order_id || req.query.orderId || null;
    if ((code === 401 || code === 403 || code === 404) && orderId) {
      try {
        const fb = await fallbackFromDb(orderId);
        return res.status(code).json({ ok: false, from_meli: true, ...fb, error: String(e?.message || e) });
      } catch {
        // se até fallback falhar, cai no retorno padrão
      }
    }

    return res.status(code).json({ error: String(e?.message || e), from_meli: true });
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
      return res.status(200).json({ ok: false, warning: 'missing_access_token', updated: 0, total: 0 });
    }

    const touched = [];
    const errs    = [];

    const runOne = async (oid) => {
      try {
        const s = await getShippingStatusFromOrder(oid, token);
        const suggested = normalizeFlow(s.mlStatus, s.mlSubstatus);
        await updateReturnShipping({ orderId: oid, mlStatus: s.mlStatus, mlSubstatus: s.mlSubstatus, logStatus: suggested });
        touched.push({
          order_id: oid,
          shipment_id: s.shipmentId,
          ml_status: s.mlStatus,
          ml_substatus: s.mlSubstatus,
          suggested_log_status: suggested
        });
      } catch (e) {
        const code = e?.status || 500;
        errs.push({ order_id: oid, status: code, error: String(e?.message || e) });
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
    return res.json(out);
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

module.exports = router;
