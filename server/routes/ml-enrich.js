// server/routes/ml-enrich.js
'use strict';

const { query } = require('../db');

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

function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function notBlank(v) {
  return v !== null && v !== undefined && String(v).trim() !== '';
}

module.exports = function registerMlEnrich(app) {
  // POST /api/ml/returns/:id/enrich
  app.post('/api/ml/returns/:id/enrich', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID inválido' });

      // Carrega a devolução
      const { rows } = await query('SELECT * FROM devolucoes WHERE id=$1', [id]);
      if (!rows.length) return res.status(404).json({ error: 'Não encontrado' });
      const dev = rows[0];

      // Verifica colunas disponíveis
      const has = await tableHasColumns('devolucoes', [
        'id_venda', 'order_id',
        'valor_produto', 'valor_frete',
        'claim_id', 'ml_claim_id',
        'cliente_nome', 'sku',
        'data_compra', 'loja_nome'
      ]);

      const orderId =
        (has.id_venda && dev.id_venda) ? dev.id_venda :
        (has.order_id  && dev.order_id) ? dev.order_id  : null;

      const claimId =
        (has.claim_id && dev.claim_id) ? dev.claim_id :
        (has.ml_claim_id && dev.ml_claim_id) ? dev.ml_claim_id : null;

      const token = process.env.MELI_OWNER_TOKEN || process.env.ML_ACCESS_TOKEN;
      if (!token) return res.status(400).json({ error: 'MELI_OWNER_TOKEN (ou ML_ACCESS_TOKEN) ausente no servidor' });

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

      // ---------- helpers de ORDER ----------
      const getBuyerName = (o) => {
        const b = o?.buyer || {};
        const full = [b.first_name, b.last_name].filter(Boolean).join(' ').trim();
        if (full) return full;
        const recv = o?.shipping?.receiver_address?.receiver_name;
        if (recv) return recv;
        return b.nickname || null;
      };

      const getOrderTotalProducts = (o) => {
        const items = Array.isArray(o?.order_items) ? o.order_items : (Array.isArray(o?.items) ? o.items : []);
        let sum = 0;
        for (const it of items) {
          const unit = toNumber(it?.unit_price ?? it?.sale_price ?? it?.price);
          const qty  = toNumber(it?.quantity ?? 1);
          sum += unit * (qty || 1);
        }
        return sum > 0 ? sum : null;
      };

      const getFirstOrderItemRef = (o) => {
        const items = Array.isArray(o?.order_items) ? o.order_items : (Array.isArray(o?.items) ? o.items : []);
        const it = items[0];
        if (!it) return {};
        const itemId = it?.item?.id ?? it?.item?.item_id ?? it?.item_id ?? null;
        const variationId = it?.item?.variation_id ?? it?.variation_id ?? null;
        const sellerSku = it?.seller_sku ?? it?.item?.seller_sku ?? null;
        return { itemId, variationId, sellerSku };
      };

      const getStoreNickname = (o) => o?.seller?.nickname || null;
      const getOrderDateIso = (o) => o?.date_created ? new Date(o.date_created).toISOString().slice(0,10) : null;

      // ---------- helper de ITEM (SKU) ----------
      const getSkuFromItem = async (itemId, variationId) => {
        if (!itemId) return null;
        const j = await mget(`/items/${encodeURIComponent(itemId)}?include_attributes=all`);

        // variação primeiro
        if (variationId && Array.isArray(j?.variations)) {
          const v = j.variations.find(v => String(v?.id) === String(variationId));
          const skuVar = v?.seller_custom_field || v?.seller_sku;
          if (notBlank(skuVar)) return skuVar;
        }
        // fallback no item
        const skuItem = j?.seller_custom_field || j?.seller_sku;
        return notBlank(skuItem) ? skuItem : null;
      };

      // ---------- acumula novos valores ----------
      let novo_valor_produto = null;
      let novo_valor_frete   = null;
      let novo_cliente_nome  = null;
      let novo_sku           = null;
      let novo_data_compra   = null;
      let novo_loja_nome     = null;

      // 1) ORDER: produtos, cliente, data, loja e (talvez) SKU
      if (orderId) {
        try {
          const o = await mget(`/orders/${encodeURIComponent(orderId)}`);

          // nome do cliente
          novo_cliente_nome = getBuyerName(o);

          // total produtos (não sobrescreve se já tem um valor e preferir manter)
          const tot = getOrderTotalProducts(o);
          if (tot != null) novo_valor_produto = tot;

          // data compra e loja (apelido)
          novo_data_compra = getOrderDateIso(o);
          novo_loja_nome   = getStoreNickname(o);

          // SKU: tenta vir no próprio order; senão busca em /items
          const ref = getFirstOrderItemRef(o);
          if (notBlank(ref?.sellerSku)) {
            novo_sku = ref.sellerSku;
          } else if (ref?.itemId) {
            novo_sku = await getSkuFromItem(ref.itemId, ref.variationId);
          }
        } catch (e) {
          console.warn('[ML ENRICH] /orders falhou:', e.message);
        }
      }

      // 2) FRETE DA DEVOLUÇÃO: /claims/{id}/charges/return-cost
      if (claimId) {
        try {
          const rc = await mget(`/post-purchase/v1/claims/${encodeURIComponent(claimId)}/charges/return-cost`);
          if (rc && rc.amount != null) novo_valor_frete = toNumber(rc.amount);
        } catch (e) {
          console.warn('[ML ENRICH] return-cost falhou:', e.message);
        }
      }

      // ---------- prepara UPDATE apenas do que mudou/existe ----------
      const set = [];
      const p   = [];

      // valor_produto
      if (has.valor_produto && novo_valor_produto != null) {
        const atual = toNumber(dev.valor_produto);
        if (atual !== toNumber(novo_valor_produto)) {
          set.push(`valor_produto=$${p.push(toNumber(novo_valor_produto))}`);
        }
      }

      // valor_frete
      if (has.valor_frete && novo_valor_frete != null) {
        const atual = toNumber(dev.valor_frete);
        if (atual !== toNumber(novo_valor_frete)) {
          set.push(`valor_frete=$${p.push(toNumber(novo_valor_frete))}`);
        }
      }

      // cliente_nome
      if (has.cliente_nome && notBlank(novo_cliente_nome)) {
        if (!notBlank(dev.cliente_nome) || String(dev.cliente_nome) !== String(novo_cliente_nome)) {
          set.push(`cliente_nome=$${p.push(novo_cliente_nome)}`);
        }
      }

      // sku
      if (has.sku && notBlank(novo_sku)) {
        if (!notBlank(dev.sku) || String(dev.sku) !== String(novo_sku)) {
          set.push(`sku=$${p.push(novo_sku)}`);
        }
      }

      // data_compra (yyyy-mm-dd)
      if (has.data_compra && notBlank(novo_data_compra)) {
        if (!notBlank(dev.data_compra) || String(dev.data_compra).slice(0,10) !== String(novo_data_compra).slice(0,10)) {
          set.push(`data_compra=$${p.push(novo_data_compra)}`);
        }
      }

      // loja_nome
      if (has.loja_nome && notBlank(novo_loja_nome)) {
        if (!notBlank(dev.loja_nome) || String(dev.loja_nome) !== String(novo_loja_nome)) {
          set.push(`loja_nome=$${p.push(novo_loja_nome)}`);
        }
      }

      if (!set.length) {
        return res.json({ item: dev, note: 'sem alterações' });
      }

      set.push('updated_at=now()');
      p.push(id);

      const upd = await query(
        `UPDATE devolucoes SET ${set.join(', ')} WHERE id=$${p.length} RETURNING *`,
        p
      );

      res.json({
        item: upd.rows[0],
        sources: { order_id: orderId || null, claim_id: claimId || null }
      });
    } catch (e) {
      console.error('[ML ENRICH] erro:', e);
      res.status(500).json({ error: 'Falha ao enriquecer dados do ML', detail: e?.message });
    }
  });
};
