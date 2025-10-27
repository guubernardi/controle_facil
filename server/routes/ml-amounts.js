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

async function tableHasColumns(table, cols) {
  const { rows } = await query(
    `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1`,
    [table]
  );
  const set = new Set(rows.map(r => r.column_name));
  const out = {};
  for (const c of cols) out[c] = set.has(c);
  return out;
}

module.exports = function registerMlAmounts(app) {
  // GET /api/ml/returns/:id/fetch-amounts[?order_id=...&claim_id=...]
  app.get('/api/ml/returns/:id/fetch-amounts', async (req, res) => {
    const meta = { steps: [], errors: [] };

    function pushErr(where, err) {
      const info = {
        where,
        message: err?.message || String(err),
        status: err?.status || null,
        payload: err?.payload || null,
      };
      meta.errors.push(info);
      console.error('[ML AMOUNTS]', where, info);
    }

    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID inválido' });

      // tenta pegar order/claim do querystring
      let orderId = (req.query.order_id || '').trim();
      let claimId = (req.query.claim_id || '').trim();

      // se não veio, busca na tabela
      if (!orderId || !claimId) {
        const has = await tableHasColumns('devolucoes', ['id_venda','order_id','claim_id','ml_claim_id']);
        const { rows } = await query('SELECT * FROM devolucoes WHERE id=$1', [id]);
        if (!rows.length) return res.status(404).json({ error: 'Devolução não encontrada' });
        const d = rows[0];
        if (!orderId) orderId = (has.id_venda && d.id_venda) || (has.order_id && d.order_id) || '';
        if (!claimId) claimId = (has.claim_id && d.claim_id) || (has.ml_claim_id && d.ml_claim_id) || '';
      }

      const token = process.env.MELI_OWNER_TOKEN || process.env.ML_ACCESS_TOKEN;
      if (!token) return res.status(400).json({ error: 'MELI_OWNER_TOKEN ausente no servidor' });

      const base = 'https://api.mercadolibre.com';
      const mget = async (path) => {
        const r = await fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
        let j = {};
        try { j = await r.json(); } catch (_) {}
        if (!r.ok) {
          const e = new Error(`${r.status} ${j?.message || j?.error || r.statusText}`);
          e.status = r.status;
          e.payload = j;
          throw e;
        }
        return j;
      };

      // ---------- ORDER (valor do produto) ----------
      let orderInfo = null;
      let productAmount = null;

      if (notBlank(orderId)) {
        try {
          meta.steps.push({ op: 'GET /orders', orderId });
          const o = await mget(`/orders/${encodeURIComponent(orderId)}`);
          orderInfo = o;

          const items = Array.isArray(o?.order_items) ? o.order_items : (Array.isArray(o?.items) ? o.items : []);
          let sum = 0;
          for (const it of items) {
            const unit = toNumber(it?.unit_price ?? it?.sale_price ?? it?.price);
            const qty  = toNumber(it?.quantity ?? 1);
            sum += unit * (qty || 1);
          }
          productAmount = sum > 0 ? sum : null;
        } catch (e) {
          pushErr('orders', e);
        }
      }

      // ---------- CLAIM (custo de devolução / frete) ----------
      let returnCost = null;
      if (notBlank(claimId)) {
        try {
          meta.steps.push({ op: 'GET /claims/return-cost', claimId });
          const rc = await mget(`/post-purchase/v1/claims/${encodeURIComponent(claimId)}/charges/return-cost`);
          if (rc && rc.amount != null) returnCost = toNumber(rc.amount);
        } catch (e) {
          pushErr('return-cost', e);
        }
      }

      // se nada deu pra trazer, dá 404 mais claro
      if (productAmount == null && returnCost == null && meta.errors.length && !orderInfo) {
        return res.status(404).json({ error: 'Sem dados para esta devolução', meta });
      }

      return res.json({
        ok: true,
        order_id: notBlank(orderId) ? String(orderId) : null,
        claim_id: notBlank(claimId) ? String(claimId) : null,
        amounts: {
          product: productAmount,
          freight: returnCost
        },
        order: orderInfo || null,
        return_cost: returnCost != null ? { amount: returnCost } : null,
        meta
      });
    } catch (e) {
      console.error('[ML AMOUNTS] erro geral:', e);
      return res.status(500).json({
        error: 'Falha ao buscar valores',
        detail: e?.message || String(e),
        status: e?.status || null,
        payload: e?.payload || null
      });
    }
  });
};
