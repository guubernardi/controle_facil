// server/routes/ml-shipping.js
'use strict';

const express = require('express');
const { query } = require('../db');

const router = express.Router();
const ML_BASE = 'https://api.mercadolibre.com';

// ---------------- Token resolving (reuso do padrão das outras rotas) ----------------
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
  // 1) Header direto
  const direct = req.get('x-seller-token');
  if (direct) return direct;

  // 2) Seller id: header, query ou sessão
  const sellerId = String(
    req.get('x-seller-id') || req.query.seller_id || req.session?.ml?.user_id || ''
  ).replace(/\D/g, '');
  if (sellerId) {
    const row = await loadTokenRowFromDb(sellerId);
    if (row?.access_token) return row.access_token;
  }

  // 3) Sessão
  if (req.session?.ml?.access_token) return req.session.ml.access_token;

  // 4) Fallback owner (ENV)
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
    return 'preparacao';

  if (/(shipped|in_transit)/.test(s) || /(transit|transporte)/.test(ss))
    return 'transporte';

  if (/delivered/.test(s) || /(delivered|entreg)/.test(ss))
    return 'recebido_cd';

  if (/not_delivered/.test(s))
    return 'transporte'; // pode refinar depois (ex.: 'disputa')

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
            -- no-op to keep SQL valid if no updated_at:
            id_venda = id_venda
      WHERE id_venda = $2`,
    [suggestedLog, String(orderId)]
  );
  return { updated: !!rowCount, rowCount };
}

// ---------------- Rotas ----------------

// Stub só para matar o 404 do front por enquanto
router.get('/messages/sync', (req, res) => {
  const days = parseInt(req.query.days || req.query._days || '0', 10) || null;
  return res.json({ ok: true, stub: true, days, note: 'messages/sync ainda não implementado; endpoint de placeholder.' });
});

/**
 * GET /api/ml/shipping/by-order/:orderId
 * Retorna shipments detalhados do pedido
 */
router.get('/shipping/by-order/:orderId', async (req, res) => {
  try {
    const orderId = String(req.params.orderId || '').replace(/\D/g, '');
    if (!orderId) return res.status(400).json({ error: 'order_id inválido' });

    // 1) tenta rota oficial by order
    let shipments = null;
    try {
      const j = await mget(req, `/orders/${encodeURIComponent(orderId)}/shipments`);
      shipments = Array.isArray(j) ? j : (Array.isArray(j?.shipments) ? j.shipments : null);
    } catch (e) {
      // 2) fallback via search
      const j = await mget(req, `/shipments/search?order_id=${encodeURIComponent(orderId)}`);
      shipments = Array.isArray(j?.results) ? j.results : null;
    }

    if (!shipments || !shipments.length) {
      return res.json({ order_id: orderId, shipments: [] });
    }

    // Detalha cada shipment
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
 * Retorna um resumo simples do status logístico
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
      // pega o mais recente como "principal"
      if (!main || new Date(d?.last_updated || d?.date_created || 0) > new Date(main?.last_updated || main?.date_created || 0)) {
        main = d;
      }
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
 * - ?days=...      (bulk stub: responde 200 e ignora por enquanto)
 */
router.get('/shipping/sync', async (req, res) => {
  try {
    const orderId = String(req.query.order_id || '').replace(/\D/g, '');
    const days    = parseInt(req.query.days || req.query._days || '0', 10) || null;

    // bulk (por enquanto: stub 200 para não quebrar o front)
    if (!orderId && days) {
      return res.json({ ok: true, note: 'bulk sync por days ainda não implementado. Use order_id por enquanto.', days });
    }

    if (!orderId) return res.status(400).json({ error: 'order_id é obrigatório' });

    // shipments por pedido
    let shipments = null;
    try {
      const j = await mget(req, `/orders/${encodeURIComponent(orderId)}/shipments`);
      shipments = Array.isArray(j) ? j : (Array.isArray(j?.shipments) ? j.shipments : null);
    } catch (e) {
      const j = await mget(req, `/shipments/search?order_id=${encodeURIComponent(orderId)}`);
      shipments = Array.isArray(j?.results) ? j.results : null;
    }

    const details = [];
    let bestLog = null;

    if (shipments && shipments.length) {
      for (const s of shipments) {
        const id = s?.id || s?.shipment_id || s;
        if (!id) continue;
        const d = await mget(req, `/shipments/${encodeURIComponent(id)}`).catch(() => null);
        if (d) {
          details.push(d);
          const sug = mapShipmentToLog(d.status, d.substatus);
          // escolhe o "mais avançado"
          const rank = { preparacao: 1, transporte: 2, recebido_cd: 3 };
          if (sug && (!bestLog || (rank[sug] || 0) > (rank[bestLog] || 0))) bestLog = sug;
        }
      }
    }

    // atualiza devolução (se existir) com o log sugerido
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
