// server/routes/ml-amounts.js
'use strict';

const { query } = require('../db');

const ML_BASE = process.env.ML_BASE_URL || 'https://api.mercadolibre.com';

function pickTokenForTenant(_req) {
  // TODO: se você já salva access_token por loja/tenant, busque aqui.
  // Por enquanto cai no fallback global:
  const t = process.env.MELI_OWNER_TOKEN || process.env.ML_ACCESS_TOKEN;
  if (!t) throw new Error('Falta MELI_OWNER_TOKEN (ou token por loja).');
  return t;
}

async function fetchJson(url, token) {
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j?.message || j?.error || r.statusText;
    throw new Error(`ML ${r.status}: ${msg}`);
  }
  return j;
}

async function getOrderAmounts(orderId, token) {
  if (!orderId) return { product: null, shipFromOrder: null };
  const o = await fetchJson(`${ML_BASE}/orders/${orderId}`, token);

  // bem defensivo: tenta vários campos
  const items = Array.isArray(o?.order_items) ? o.order_items : [];
  const product = items.reduce((acc, it) => {
    const q = Number(it?.quantity || 1);
    const p = Number(it?.unit_price || it?.full_unit_price || it?.sale_fee || 0);
    return acc + (isFinite(q * p) ? q * p : 0);
  }, 0);

  const shipFromOrder =
    Number(o?.shipping_cost) ||
    Number(o?.total_shipping) ||
    Number(o?.shipping?.cost) ||
    null;

  return { product: isFinite(product) ? product : null, shipFromOrder };
}

async function getReturnShippingAmount(claimId, token) {
  if (!claimId) return null;
  const j = await fetchJson(
    `${ML_BASE}/post-purchase/v1/claims/${claimId}/charges/return-cost`,
    token
  );
  // docs: { currency_id, amount, [amount_usd] }
  return Number(j?.amount) || 0;
}

module.exports = function registerMlAmounts(app) {
  /**
   * POST /api/ml/returns/:id/fetch-amounts
   * Busca no ML e atualiza devolucoes.valor_produto / valor_frete.
   */
  app.post('/api/ml/returns/:id/fetch-amounts', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });

      // Carrega a linha para pegar order_id (id_venda) e claim_id (ml_claim_id)
      const { rows } = await query(
        `SELECT id, id_venda, ml_claim_id, valor_produto, valor_frete, log_status
           FROM devolucoes WHERE id=$1 LIMIT 1`,
        [id]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Não encontrado' });

      const row = rows[0];
      const token = pickTokenForTenant(req);

      // Produto pelo pedido
      const { product } = await getOrderAmounts(row.id_venda, token);

      // Frete de devolução pelo claim
      const freight = await getReturnShippingAmount(row.ml_claim_id, token);

      // Regra: se claim retornou frete, usa; senão mantém o que já tiver
      const novo_vp = (product != null) ? product : row.valor_produto;
      const novo_vf = (freight != null) ? freight : row.valor_frete;

      const up = await query(
        `UPDATE devolucoes
            SET valor_produto = COALESCE($1, valor_produto),
                valor_frete   = COALESCE($2, valor_frete),
                updated_at    = now()
          WHERE id=$3
          RETURNING *`,
        [novo_vp, novo_vf, id]
      );

      return res.json({ item: up.rows[0] });
    } catch (e) {
      console.error('[ML] fetch-amounts erro:', e);
      const reveal = String(process.env.REVEAL_ERRORS ?? 'false').toLowerCase() === 'true';
      res.status(500).json({ error: reveal ? (e.message || String(e)) : 'Falha ao buscar valores' });
    }
  });
};
