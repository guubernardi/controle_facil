// server/routes/ml-enrich.js
'use strict';

const { query } = require('../db');

// usa req.q (RLS) se existir; senão fallback global
function qOf(req) { return (req && req.q) ? req.q : query; }

async function tableHasColumns(table, cols, req) {
  const q = qOf(req);
  const { rows } = await q(
    `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1`,
    [table]
  );
  const set = new Set(rows.map(r => r.column_name));
  const out = {};
  for (const c of cols) out[c] = set.has(c);
  return out;
}

function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}
function notBlank(v) { return v !== null && v !== undefined && String(v).trim() !== ''; }

function sumOrderItemsTotal(o) {
  const items = Array.isArray(o?.order_items) ? o.order_items : (Array.isArray(o?.items) ? o.items : []);
  let sum = 0;
  for (const it of items) {
    const unit = toNumber(it?.unit_price ?? it?.sale_price ?? it?.price);
    const qty  = toNumber(it?.quantity ?? 1);
    sum += unit * (qty || 1);
  }
  return sum || null;
}
function getBuyerName(o) {
  const b = o?.buyer || {};
  const full = [b.first_name, b.last_name].filter(Boolean).join(' ').trim();
  if (full) return full;
  const recv = o?.shipping?.receiver_address?.receiver_name;
  if (recv) return recv;
  return b.nickname || null;
}
function getStoreNickname(o) { return o?.seller?.nickname || null; }
function getOrderDateIso(o) { return o?.date_created ? new Date(o.date_created).toISOString().slice(0,10) : null; }

async function getSkuFromItem(token, itemId, variationId) {
  if (!itemId) return null;
  const j = await mget(token, `/items/${encodeURIComponent(itemId)}?include_attributes=all`);
  if (variationId && Array.isArray(j?.variations)) {
    const v = j.variations.find(v => String(v?.id) === String(variationId));
    const skuVar = v?.seller_custom_field || v?.seller_sku;
    if (notBlank(skuVar)) return skuVar;
  }
  const skuItem = j?.seller_custom_field || j?.seller_sku;
  return notBlank(skuItem) ? skuItem : null;
}

async function mget(token, path) {
  const base = 'https://api.mercadolibre.com';
  const r = await fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
  const txt = await r.text();
  let j = {};
  try { j = txt ? JSON.parse(txt) : {}; } catch {}
  if (!r.ok) {
    const msg = j?.message || j?.error || r.statusText;
    const e = new Error(`${r.status} ${msg}`);
    e.status = r.status;
    e.payload = j;
    throw e;
  }
  return j;
}

module.exports = function registerMlEnrich(app) {

  /**
   * PREVIEW
   * GET /api/ml/returns/:id/fetch-amounts?order_id=...&claim_id=...
   * Retorna { amounts: { product, freight }, order, return_cost }
   */
  app.get('/api/ml/returns/:id/fetch-amounts', async (req, res) => {
    const token = process.env.MELI_OWNER_TOKEN || process.env.ML_ACCESS_TOKEN;
    if (!token) return res.status(400).json({ error: 'MELI_OWNER_TOKEN (ou ML_ACCESS_TOKEN) ausente no servidor' });

    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID inválido' });

      const hasCols = await tableHasColumns('devolucoes', [
        'id_venda','order_id','claim_id','ml_claim_id'
      ], req);

      // devolução da base (para fallback de ids)
      const q = qOf(req);
      const { rows } = await q('SELECT * FROM devolucoes WHERE id=$1', [id]);
      const dev = rows[0] || {};

      // overrides vindos da querystring
      const orderIdQS = (req.query.order_id || req.query.orderId || '').toString().trim();
      const claimIdQS = (req.query.claim_id || req.query.claimId || '').toString().trim();

      const orderId =
        orderIdQS ||
        (hasCols.id_venda && dev.id_venda) ||
        (hasCols.order_id && dev.order_id) || null;

      const claimId =
        claimIdQS ||
        (hasCols.claim_id && dev.claim_id) ||
        (hasCols.ml_claim_id && dev.ml_claim_id) || null;

      if (!orderId && !claimId) {
        return res.status(404).json({ error: 'Sem dados para esta devolução' });
      }

      // chama APIs do ML (cada uma protegida com try/catch)
      let order = null;
      let amounts = {};
      let retCost = null;

      // ORDER
      if (orderId) {
        try {
          order = await mget(token, `/orders/${encodeURIComponent(orderId)}`);
          const productTotal = sumOrderItemsTotal(order);
          if (productTotal != null) amounts.product = productTotal;
        } catch (e) {
          // 404 no pedido => segue tentando claim
          if (e.status === 401) return res.status(502).json({ error: 'Token do ML inválido/expirado', code: 'auth_error' });
          if (e.status !== 404) console.warn('[ML PREVIEW] /orders erro:', e.message);
        }
      }

      // RETURN COST (FRETE DA DEVOLUÇÃO)
      if (claimId) {
        try {
          const rc = await mget(token, `/post-purchase/v1/claims/${encodeURIComponent(claimId)}/charges/return-cost`);
          if (rc && rc.amount != null) {
            amounts.freight = toNumber(rc.amount);
            retCost = rc;
          }
        } catch (e) {
          if (e.status === 401) return res.status(502).json({ error: 'Token do ML inválido/expirado', code: 'auth_error' });
          if (e.status !== 404) console.warn('[ML PREVIEW] return-cost erro:', e.message);
        }
      }

      // se nada foi obtido, 404 amigável
      if (Object.keys(amounts).length === 0 && !order) {
        return res.status(404).json({ error: 'Sem dados para esta devolução' });
      }

      res.json({
        amounts,
        order,
        return_cost: retCost,
        sources: { order_id: orderId || null, claim_id: claimId || null }
      });
    } catch (e) {
      console.error('[ML PREVIEW] erro:', e);
      const detail = e?.message || String(e);
      res.status(500).json({ error: 'Falha ao buscar valores no ML', detail });
    }
  });

  /**
   * ENRICH
   * POST /api/ml/returns/:id/enrich
   * Atualiza campos (valor_produto, valor_frete, cliente_nome, sku, data_compra, loja_nome)
   */
  app.post('/api/ml/returns/:id/enrich', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID inválido' });

      const q = qOf(req);
      const { rows } = await q('SELECT * FROM devolucoes WHERE id=$1', [id]);
      if (!rows.length) return res.status(404).json({ error: 'Não encontrado' });
      const dev = rows[0];

      const has = await tableHasColumns('devolucoes', [
        'id_venda','order_id',
        'valor_produto','valor_frete',
        'claim_id','ml_claim_id',
        'cliente_nome','sku',
        'data_compra','loja_nome'
      ], req);

      const orderId =
        (has.id_venda && dev.id_venda) ? dev.id_venda :
        (has.order_id  && dev.order_id) ? dev.order_id  : null;

      const claimId =
        (has.claim_id && dev.claim_id) ? dev.claim_id :
        (has.ml_claim_id && dev.ml_claim_id) ? dev.ml_claim_id : null;

      const token = process.env.MELI_OWNER_TOKEN || process.env.ML_ACCESS_TOKEN;
      if (!token) return res.status(400).json({ error: 'MELI_OWNER_TOKEN (ou ML_ACCESS_TOKEN) ausente no servidor' });

      // ------- buscar dados no ML -------
      let novo_valor_produto = null;
      let novo_valor_frete   = null;
      let novo_cliente_nome  = null;
      let novo_sku           = null;
      let novo_data_compra   = null;
      let novo_loja_nome     = null;

      if (orderId) {
        try {
          const o = await mget(token, `/orders/${encodeURIComponent(orderId)}`);
          // valores e metadados do pedido
          novo_cliente_nome = getBuyerName(o);
          const tot = sumOrderItemsTotal(o);
          if (tot != null) novo_valor_produto = tot;
          novo_data_compra = getOrderDateIso(o);
          novo_loja_nome   = getStoreNickname(o);

          // sku (variante->item)
          const items = Array.isArray(o?.order_items) ? o.order_items : (Array.isArray(o?.items) ? o.items : []);
          const first = items[0] || {};
          const itemId = first?.item?.id ?? first?.item?.item_id ?? first?.item_id ?? null;
          const variationId = first?.item?.variation_id ?? first?.variation_id ?? null;
          const sellerSku = first?.seller_sku ?? first?.item?.seller_sku ?? null;
          if (notBlank(sellerSku)) novo_sku = sellerSku;
          else if (itemId) novo_sku = await getSkuFromItem(token, itemId, variationId);
        } catch (e) {
          if (e.status !== 404) console.warn('[ML ENRICH] /orders falhou:', e.message);
        }
      }

      if (claimId) {
        try {
          const rc = await mget(token, `/post-purchase/v1/claims/${encodeURIComponent(claimId)}/charges/return-cost`);
          if (rc && rc.amount != null) novo_valor_frete = toNumber(rc.amount);
        } catch (e) {
          if (e.status !== 404) console.warn('[ML ENRICH] return-cost falhou:', e.message);
        }
      }

      // ------- UPDATE somente do que mudou -------
      const set = [];
      const p = [];

      if (has.valor_produto && novo_valor_produto != null &&
          toNumber(dev.valor_produto) !== toNumber(novo_valor_produto)) {
        set.push(`valor_produto=$${p.push(toNumber(novo_valor_produto))}`);
      }
      if (has.valor_frete && novo_valor_frete != null &&
          toNumber(dev.valor_frete) !== toNumber(novo_valor_frete)) {
        set.push(`valor_frete=$${p.push(toNumber(novo_valor_frete))}`);
      }
      if (has.cliente_nome && notBlank(novo_cliente_nome) &&
          (!notBlank(dev.cliente_nome) || String(dev.cliente_nome) !== String(novo_cliente_nome))) {
        set.push(`cliente_nome=$${p.push(novo_cliente_nome)}`);
      }
      if (has.sku && notBlank(novo_sku) &&
          (!notBlank(dev.sku) || String(dev.sku) !== String(novo_sku))) {
        set.push(`sku=$${p.push(novo_sku)}`);
      }
      if (has.data_compra && notBlank(novo_data_compra) &&
          (!notBlank(dev.data_compra) || String(dev.data_compra).slice(0,10) !== String(novo_data_compra).slice(0,10))) {
        set.push(`data_compra=$${p.push(novo_data_compra)}`);
      }
      if (has.loja_nome && notBlank(novo_loja_nome) &&
          (!notBlank(dev.loja_nome) || String(dev.loja_nome) !== String(novo_loja_nome))) {
        set.push(`loja_nome=$${p.push(novo_loja_nome)}`);
      }

      if (!set.length) {
        return res.json({ item: dev, note: 'sem alterações' });
      }

      set.push('updated_at=now()');
      p.push(id);

      const upd = await q(`UPDATE devolucoes SET ${set.join(', ')} WHERE id=$${p.length} RETURNING *`, p);
      res.json({ item: upd.rows[0], sources: { order_id: orderId || null, claim_id: claimId || null } });
    } catch (e) {
      console.error('[ML ENRICH] erro:', e);
      res.status(500).json({ error: 'Falha ao enriquecer dados do ML', detail: e?.message });
    }
  });
};
