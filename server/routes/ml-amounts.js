// server/routes/ml-amounts.js
'use strict';

const { query } = require('../db');

function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}
function notBlank(v) {
  return v !== null && v !== undefined && String(v).trim() !== '';
}

module.exports = function registerMlAmounts(app) {
  /**
   * Preview de valores vindos do ML (não grava no banco)
   * GET /api/ml/returns/:id/fetch-amounts
   */
  app.get('/api/ml/returns/:id/fetch-amounts', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });

      // carrega a devolução para achar orderId / claimId (nomes de coluna podem variar)
      const { rows } = await query('SELECT * FROM devolucoes WHERE id=$1 LIMIT 1', [id]);
      if (!rows[0]) return res.status(404).json({ error: 'Não encontrado' });
      const dev = rows[0];

      const orderId = dev.id_venda || dev.order_id || null;
      const claimId = dev.ml_claim_id || dev.claim_id || null;

      const token = process.env.MELI_OWNER_TOKEN || process.env.ML_ACCESS_TOKEN;
      if (!token) {
        return res.status(400).json({ error: 'MELI_OWNER_TOKEN ausente no servidor' });
      }

      const base = 'https://api.mercadolibre.com';
      const mget = async (path) => {
        const r = await fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          const msg = j?.message || j?.error || r.statusText;
          const e = new Error(`${r.status} ${msg}`);
          e.status = r.status;
          e.payload = j;
          throw e;
        }
        return j;
      };

      // ----- ORDER: soma de itens -----
      let order = null;
      let itemsTotal = null;
      if (orderId) {
        try {
          const o = await mget(`/orders/${encodeURIComponent(orderId)}`);
          order = o;
          const items = Array.isArray(o?.order_items) ? o.order_items : (Array.isArray(o?.items) ? o.items : []);
          let sum = 0;
          for (const it of items) {
            const unit = toNumber(it?.unit_price ?? it?.sale_price ?? it?.price);
            const qty  = toNumber(it?.quantity ?? 1);
            sum += unit * (qty || 1);
          }
          if (sum > 0) itemsTotal = sum;
        } catch (e) {
          console.warn('[ML AMOUNTS] Falha em /orders:', e.message);
        }
      }

      // ----- FRETE: return-cost do claim -----
      let returnCost = null;
      if (claimId) {
        try {
          returnCost = await mget(`/post-purchase/v1/claims/${encodeURIComponent(claimId)}/charges/return-cost`);
        } catch (e) {
          console.warn('[ML AMOUNTS] Falha em return-cost:', e.message);
        }
      }

      // nada encontrado? 404 (front mostra aviso)
      if (order == null && returnCost == null) {
        return res.status(404).json({ error: 'Sem dados para esta devolução' });
      }

      const freight = (returnCost && returnCost.amount != null) ? toNumber(returnCost.amount) : null;

      // resposta com vários aliases que o front já procura
      res.json({
        product: itemsTotal,
        freight,
        amounts: { product: itemsTotal, freight },
        order_info: order,
        order: order ? {
          id: order.id,
          date_created: order.date_created,
          items_total: itemsTotal,
          buyer: order.buyer,
          seller: order.seller,
          site_id: order.site_id
        } : null,
        return_cost: returnCost,
        sources: { order_id: orderId, claim_id: claimId }
      });
    } catch (e) {
      console.error('[ML AMOUNTS] erro:', e);
      const reveal = String(process.env.REVEAL_ERRORS ?? 'false').toLowerCase() === 'true';
      res.status(500).json({ error: reveal ? (e?.message || String(e)) : 'Falha ao buscar valores' });
    }
  });
};
