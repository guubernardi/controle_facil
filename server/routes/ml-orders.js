// server/routes/ml-orders.js
'use strict';

const express = require('express');
const router  = express.Router();
const { query } = require('../db');

// --- Token helpers ----------------------------------------------------------
async function getMLTokenByNick(nick) {
  // tenta por nickname (se existir coluna), depois cai para o ativo mais recente
  try {
    if (nick) {
      const { rows } = await query(
        `SELECT access_token
           FROM ml_tokens
          WHERE is_active IS TRUE
            AND (nickname ILIKE $1 OR seller_nickname ILIKE $1)
          ORDER BY updated_at DESC NULLS LAST
          LIMIT 1`,
        [nick]
      );
      if (rows[0]?.access_token) return rows[0].access_token;
    }
  } catch {}
  return getMLToken();
}

async function getMLToken(req) {
  try {
    if (req?.user?.ml?.access_token) return req.user.ml.access_token;
  } catch {}
  if (process.env.ML_ACCESS_TOKEN) return process.env.ML_ACCESS_TOKEN;
  try {
    const { rows } = await query(
      `SELECT access_token
         FROM ml_tokens
        WHERE is_active IS TRUE
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 1`
    );
    return rows[0]?.access_token || null;
  } catch { return null; }
}

async function mlFetchJson(path, token) {
  const url = 'https://api.mercadolibre.com' + path;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const txt = await r.text();
  let j = {};
  try { j = txt ? JSON.parse(txt) : {}; } catch {}
  if (!r.ok) {
    const err = new Error((j && (j.error || j.message)) || `HTTP ${r.status}`);
    err.status = r.status; err.body = j;
    throw err;
  }
  return j;
}

// --- Normalizador simples para o front --------------------------------------
function normalizeOrder(o) {
  // devolvemos tanto "order" (compat) quanto o objeto raiz
  return {
    order: {
      id: o.id,
      order_id: o.id,
      date_created: o.date_created || o.date_closed || o.paid_at,
      created_at: o.date_created,
      paid_at: o.date_closed,
      seller: { nickname: o.seller?.nickname || o.seller?.nick_name },
      buyer: {
        id: o.buyer?.id,
        nickname: o.buyer?.nickname,
        first_name: o.buyer?.first_name,
        last_name: o.buyer?.last_name,
        name: o.buyer?.first_name && o.buyer?.last_name
          ? `${o.buyer.first_name} ${o.buyer.last_name}` : o.buyer?.nickname
      },
      order_items: Array.isArray(o.order_items) ? o.order_items : [],
      shipping: o.shipping || o.shipment || null,
      total_paid_amount: o.total_paid_amount ?? null,
      total_amount: o.total_amount ?? null,
      amount: o.amount ?? null
    }
  };
}

// --- Rotas -------------------------------------------------------------------

// GET /api/ml/orders/:id  (principal)
router.get('/orders/:id', async (req, res) => {
  const { id } = req.params;
  const nick = req.query.nick;
  try {
    const token = await getMLTokenByNick(nick);
    if (!token) return res.status(401).json({ error: 'ML token ausente' });

    // /orders/:id (expande itens; o objeto já traz buyer/seller/itens)
    const order = await mlFetchJson(`/orders/${encodeURIComponent(id)}`, token);
    return res.json(normalizeOrder(order));
  } catch (e) {
    const code = e.status || 500;
    return res.status(code).json({ error: e.message || 'Falha', details: e.body || null });
  }
});

// Aliases aceitos pelo front
router.get('/order/:id', (req, res) => {
  // redireciona internamente para manter uma única implementação
  req.url = req.url.replace('/order/', '/orders/');
  return router.handle(req, res);
});
router.get('/sales/:id', (req, res) => {
  req.url = req.url.replace('/sales/', '/orders/');
  return router.handle(req, res);
});

// GET /api/ml/users/:id  (para obter nome do comprador quando o pedido não trouxe)
router.get('/users/:id', async (req, res) => {
  const { id } = req.params;
  const nick = req.query.nick;
  try {
    const token = await getMLTokenByNick(nick);
    if (!token) return res.status(401).json({ error: 'ML token ausente' });

    const user = await mlFetchJson(`/users/${encodeURIComponent(id)}`, token);
    // resposta limpa pro front
    return res.json({
      id: user.id,
      nickname: user.nickname,
      first_name: user.first_name,
      last_name: user.last_name,
      name: (user.first_name && user.last_name) ? `${user.first_name} ${user.last_name}` : (user.nickname || null)
    });
  } catch (e) {
    const code = e.status || 500;
    return res.status(code).json({ error: e.message || 'Falha', details: e.body || null });
  }
});

module.exports = router;
