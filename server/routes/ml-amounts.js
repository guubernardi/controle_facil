// server/routes/ml-amounts.js
'use strict';

const { query } = require('../db');

const ML_BASE = process.env.ML_BASE_URL || 'https://api.mercadolibre.com';

function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}
function notBlank(v) {
  return v !== null && v !== undefined && String(v).trim() !== '';
}

function pickTokenForTenant(_req) {
  // Se você guarda tokens por loja/tenant, puxe aqui.
  // Fallback global:
  const t = process.env.MELI_OWNER_TOKEN || process.env.ML_ACCESS_TOKEN;
  if (!t) throw new Error('Falta MELI_OWNER_TOKEN (ou ML_ACCESS_TOKEN).');
  return t;
}

async function fetchJson(url, token) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j?.message || j?.error || r.statusText;
    const e = new Error(`${r.status} ${msg}`);
    e.status = r.status;
    e.payload = j;
    throw e;
  }
  return j;
}

function totalsFromOrder(o) {
  const items = Array.isArray(o?.order_items) ? o.order_items
               : Array.isArray(o?.items)      ? o.items
               : [];
  let sum = 0;
  for (const it of items) {
    const unit = toNumber(it?.unit_price ?? it?.sale_price ?? it?.price);
    const qty  = toNumber(it?.quantity ?? 1);
    sum += unit * (qty || 1);
  }
  return sum > 0 ? sum : null;
}

module.exports = function registerMlAmounts(app) {
  // Preview: valores (produto/frete) + pedaços úteis do pedido
  // GET /api/ml/returns/:id/fetch-amounts[?order_id=...&claim_id=...]
  app.get('/api/ml/returns/:id/fetch-amounts', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id)) {
        return res.status(400).json({ error: 'ID inválido' });
      }

      // 1) Carrega devolução (para tentar pegar order/claim do BD)
      const { rows } = await query('SELECT * FROM devolucoes WHERE id = $1', [id]);
      if (!rows.length) return res.status(404).json({ error: 'Devolução não encontrada' });
      const dev = rows[0];

      // 2) Aceita overrides via querystring (se o usuário digitou e ainda não salvou)
      const qOrder = (req.query.order_id || req.query.id_venda || '').toString().trim();
      const qClaim = (req.query.claim_id || req.query.ml_claim_id || '').toString().trim();

      const orderId =
        (qOrder && /^\d{6,}$/.test(qOrder)) ? qOrder
        : (dev.id_venda || dev.order_id || null);

      const claimId =
        (qClaim && /^\d{5,}$/.test(qClaim)) ? qClaim
        : (dev.claim_id || dev.ml_claim_id || null);

      if (!orderId && !claimId) {
        return res.status(404).json({ error: 'Sem dados para esta devolução' });
      }

      const token = pickTokenForTenant(req);

      // 3) Busca no ML
      let orderInfo = null;
      let amounts = { product: null, freight: null };

      if (orderId) {
        orderInfo = await fetchJson(`${ML_BASE}/orders/${encodeURIComponent(orderId)}`, token);
        const prod = totalsFromOrder(orderInfo);
        if (prod != null) amounts.product = prod;
      }

      if (claimId) {
        try {
          const rc = await fetchJson(
            `${ML_BASE}/post-purchase/v1/claims/${encodeURIComponent(claimId)}/charges/return-cost`,
            token
          );
          if (rc && rc.amount != null) amounts.freight = toNumber(rc.amount);
        } catch (e) {
          // 4xx aqui é normal para alguns casos (claim inexistente/permissão)
          if (e?.status >= 500) throw e;
        }
      }

      // 4) Monta saída no formato que o front entende
      // o front procura product/freight em:
      //   j.product, j.freight
      //   j.amounts.product / j.amounts.freight
      //   (e lê j.order para preencher id/sku/nick, etc)
      const out = {
        product: amounts.product,
        freight: amounts.freight,
        amounts,
        order: orderInfo || null
      };

      // Se nada foi encontrado de verdade:
      if (out.product == null && out.freight == null && !out.order) {
        return res.status(404).json({ error: 'Sem dados para esta devolução' });
      }

      res.json(out);
    } catch (e) {
      console.error('[ML] fetch-amounts erro:', e);
      const reveal = String(process.env.REVEAL_ERRORS ?? 'false').toLowerCase() === 'true';
      res.status(500).json({ error: reveal ? (e.message || String(e)) : 'Falha ao buscar valores' });
    }
  });
};
