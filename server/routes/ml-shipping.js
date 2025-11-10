// server/routes/ml-shipping.js
'use strict';

const express = require('express');
const { query } = require('../db');

const router  = express.Router();
const ML_BASE = 'https://api.mercadolibre.com';

/* ============================== Token resolving ============================== */

async function loadTokenRowFromDb(sellerId, q = query) {
  const sql = `
    SELECT user_id, access_token, expires_at
      FROM public.ml_tokens
     WHERE user_id = $1 AND coalesce(access_token,'') <> ''
     ORDER BY updated_at DESC
     LIMIT 1`;
  const { rows } = await q(sql, [sellerId]);
  return rows[0] || null;
}

/**
 * Ordem de resolução:
 * 1) Header x-seller-token
 * 2) x-seller-id / ?seller_id / session.ml.user_id -> public.ml_tokens
 * 3) x-seller-nick / ?seller_nick -> ENV MELI_TOKEN_<NICK> ou public.ml_accounts.nickname
 * 4) Último token válido em public.ml_tokens
 * 5) Sessão (fallback)
 * 6) ENVs MELI_OWNER_TOKEN ou ML_ACCESS_TOKEN
 */
async function resolveSellerAccessToken(req) {
  // 1) direto (forçado)
  const direct = req.get('x-seller-token');
  if (direct) return direct;

  // 2) seller_id
  const sellerId = String(
    req.get('x-seller-id') || req.query.seller_id || req.session?.ml?.user_id || ''
  ).replace(/\D/g, '');
  if (sellerId) {
    const row = await loadTokenRowFromDb(sellerId);
    if (row?.access_token) return row.access_token;
  }

  // 3) seller nickname
  const nick = (req.get('x-seller-nick') || req.query.seller_nick || '').trim();
  if (nick) {
    const envKey = 'MELI_TOKEN_' + nick.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    if (process.env[envKey]) return process.env[envKey];
    try {
      const { rows } = await query(`
        SELECT access_token
          FROM public.ml_accounts
         WHERE nickname = $1 AND coalesce(access_token,'') <> ''
         ORDER BY updated_at DESC NULLS LAST
         LIMIT 1
      `, [nick]);
      if (rows[0]?.access_token) return rows[0].access_token;
    } catch {}
  }

  // 4) último token global no DB
  try {
    const { rows } = await query(`
      SELECT access_token
        FROM public.ml_tokens
       WHERE coalesce(access_token,'') <> ''
       ORDER BY updated_at DESC
       LIMIT 1
    `);
    if (rows[0]?.access_token) return rows[0].access_token;
  } catch {}

  // 5) sessão (se você guarda o token lá)
  if (req.session?.ml?.access_token) return req.session.ml.access_token;

  // 6) ENVs
  return process.env.MELI_OWNER_TOKEN || process.env.ML_ACCESS_TOKEN || '';
}

async function mget(req, path) {
  const token = await resolveSellerAccessToken(req);
  if (!token) {
    const e = new Error('missing_access_token');
    e.status = 401;
    throw e;
  }
  const url = ML_BASE + path;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  });
  const txt = await r.text();
  let j = {}; try { j = txt ? JSON.parse(txt) : {}; } catch {}
  if (!r.ok) {
    const err = new Error(j?.message || j?.error || r.statusText);
    err.status = r.status; err.body = j;
    throw err;
  }
  return j;
}

/* ============================== Helpers ============================== */

function mapShipmentToLog(status = '', substatus = '') {
  const s  = String(status).toLowerCase();
  const ss = String(substatus).toLowerCase();

  // preparação
  if (
    /(ready_to_ship|handling|to_be_agreed|ready|prepar|label|printing|pending)/.test(s) ||
    /(ready|prep|etiq|label|print)/.test(ss)
  ) return 'preparacao';

  // em trânsito
  if (/(shipped|in_transit)/.test(s) || /(transit|transporte|route)/.test(ss))
    return 'transporte';

  // entregue / recebido
  if (/delivered/.test(s) || /(delivered|entreg|received)/.test(ss))
    return 'recebido_cd';

  // não entregue ainda conta como trânsito para nosso funil atual
  if (/not_delivered/.test(s)) return 'transporte';

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
  const has = await tableHasColumns('devolucoes', ['id_venda','log_status','updated_at']);
  if (!has.id_venda || !has.log_status) return { updated: false };

  const { rowCount } = await query(
    `UPDATE devolucoes
        SET log_status = $1,
            ${has.updated_at ? 'updated_at = now(),' : ''}
            id_venda = id_venda
      WHERE id_venda = $2`,
    [suggestedLog, String(orderId)]
  );
  return { updated: !!rowCount, rowCount };
}

/* ============================== Rotas ============================== */

/** Stub: mata 404 do front até implementarmos sync de mensagens */
router.get('/messages/sync', (req, res) => {
  const days = parseInt(req.query.days || req.query._days || '0', 10) || null;
  return res.json({
    ok: true,
    stub: true,
    days,
    note: 'messages/sync ainda não implementado; placeholder.'
  });
});

/**
 * GET /api/ml/shipping/by-order/:orderId
 * Detalha shipments de um pedido
 */
router.get('/shipping/by-order/:orderId', async (req, res) => {
  try {
    const orderId = String(req.params.orderId || '').replace(/\D/g, '');
    if (!orderId) return res.status(400).json({ error: 'order_id inválido' });

    // tenta via /orders/{id}/shipments
    let shipments = null;
    try {
      const j = await mget(req, `/orders/${encodeURIComponent(orderId)}/shipments`);
      shipments = Array.isArray(j) ? j : (Array.isArray(j?.shipments) ? j.shipments : null);
    } catch {
      // fallback /shipments/search?order_id=...
      const j = await mget(req, `/shipments/search?order_id=${encodeURIComponent(orderId)}`);
      shipments = Array.isArray(j?.results) ? j.results : null;
    }

    if (!shipments || !shipments.length) {
      return res.json({ order_id: orderId, shipments: [] });
    }

    const details = [];
    for (const s of shipments) {
      const id = s?.id || s?.shipment_id || s;
      if (!id) continue;
      try {
        const d = await mget(req, `/shipments/${encodeURIComponent(id)}`);
        details.push(d);
      } catch {
        details.push({ id, error: 'fetch_failed' });
      }
    }

    return res.json({ order_id: orderId, shipments: details });
  } catch (e) {
    const s = e.status || 500;
    return res.status(s).json({ error: e.message, detail: e.body || null });
  }
});

/**
 * GET /api/ml/shipping/status?order_id=...
 * Resumo simples do status logístico
 */
router.get('/shipping/status', async (req, res) => {
  try {
    const orderId = String(req.query.order_id || '').replace(/\D/g, '');
    if (!orderId) return res.status(400).json({ error: 'order_id é obrigatório' });

    const j = await mget(req, `/orders/${encodeURIComponent(orderId)}/shipments`).catch(() => null);
    const list = Array.isArray(j) ? j : (Array.isArray(j?.shipments) ? j.shipments : []);
    let main = null;

    for (const s of list) {
      const id = s?.id || s?.shipment_id || s;
      if (!id) continue;
      const d = await mget(req, `/shipments/${encodeURIComponent(id)}`).catch(() => null);
      if (!d) continue;
      const dWhen = new Date(d?.last_updated || d?.date_created || 0).getTime();
      const mWhen = new Date(main?.last_updated || main?.date_created || 0).getTime();
      if (!main || dWhen > mWhen) main = d;
    }

    if (!main) return res.json({ order_id: orderId, status: null });

    const suggested = mapShipmentToLog(main.status, main.substatus);
    return res.json({
      order_id: orderId,
      shipment_id: main.id || null,
      ml_status: main.status || null,
      ml_substatus: main.substatus || null,
      suggested_log_status: suggested || null,
      last_updated: main.last_updated || null
    });
  } catch (e) {
    const s = e.status || 500;
    return res.status(s).json({ error: e.message, detail: e.body || null });
  }
});

/**
 * GET /api/ml/shipping/sync
 * - ?order_id=...  (principal)
 * - ?days=... ou ?_days=... (bulk STUB: 200 ok)
 * - nenhum param => no-op 200 para não poluir o console
 */
router.get('/shipping/sync', async (req, res) => {
  try {
    const orderId = String(req.query.order_id || '').replace(/\D/g, '');
    const days = parseInt(req.query.days || req.query._days || '0', 10) || null;

    // bulk stub (não quebra o front)
    if (!orderId && days) {
      return res.json({ ok: true, mode: 'bulk-stub', days, note: 'bulk ainda não implementado' });
    }

    // no-op silencioso para chamadas vazias
    if (!orderId && !days) {
      return res.json({ ok: true, mode: 'noop', note: 'passe ?order_id=... ou ?days=...' });
    }

    // ------- fluxo por pedido -------
    let shipments = null;
    try {
      const j = await mget(req, `/orders/${encodeURIComponent(orderId)}/shipments`);
      shipments = Array.isArray(j) ? j : (Array.isArray(j?.shipments) ? j.shipments : null);
    } catch {
      const j = await mget(req, `/shipments/search?order_id=${encodeURIComponent(orderId)}`);
      shipments = Array.isArray(j?.results) ? j.results : null;
    }

    const details = [];
    let bestLog = null;
    if (shipments && shipments.length) {
      const rank = { preparacao: 1, transporte: 2, recebido_cd: 3 };
      for (const s of shipments) {
        const id = s?.id || s?.shipment_id || s;
        if (!id) continue;
        const d = await mget(req, `/shipments/${encodeURIComponent(id)}`).catch(() => null);
        if (!d) continue;
        details.push(d);
        const sug = mapShipmentToLog(d.status, d.substatus);
        if (sug && (!bestLog || (rank[sug] || 0) > (rank[bestLog] || 0))) bestLog = sug;
      }
    }

    const upd = await updateReturnLogStatusIfAny(orderId, bestLog);

    return res.json({
      ok: true,
      order_id: orderId,
      suggested_log_status: bestLog || null,
      db_update: upd,
      shipments: details
    });
  } catch (e) {
    const s = e.status || 500;
    return res.status(s).json({ error: e.message, detail: e.body || null });
  }
});

module.exports = router;
