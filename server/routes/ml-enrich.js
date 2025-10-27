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
        'id_venda','order_id',
        'valor_produto','valor_frete',
        'claim_id','ml_claim_id',
        'cliente_nome','sku',
        'data_compra','loja_nome'
      ]);

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

      const debug = { steps: [] };
      const step = (k, v) => debug.steps.push({ k, v });

      // ---------- RESOLVE order_id (aceita pack_id "2000...") ----------
      async function resolveOrderId(raw) {
        if (!raw) return null;
        const s = String(raw);
        const seemsPack = /^\d{13,}$/.test(s) && s.startsWith('20');
        if (!seemsPack) { step('orderId_raw', s); return s; }

        // 1) pack -> orders
        try {
          const p = await mget(`/packs/${encodeURIComponent(s)}`);
          const oid = Array.isArray(p?.orders) ? (p.orders[0]?.id || p.orders[0]) : (p?.orders_ids?.[0]);
          if (oid) { step('pack->order', { pack_id: s, order_id: oid }); return String(oid); }
        } catch (e) { step('packs_fail', e.message); }

        // 2) fallback: orders/search
        try {
          const sr = await mget(`/orders/search?q=${encodeURIComponent(s)}&limit=1&sort=date_desc`);
          const oid = sr?.results?.[0]?.id || sr?.results?.[0];
          if (oid) { step('orders.search->order', { q: s, order_id: oid }); return String(oid); }
        } catch (e) { step('orders.search_fail', e.message); }

        step('treat_as_order', s);
        return s;
      }

      async function findClaimByOrder(orderId) {
        try {
          const r = await mget(`/post-purchase/v1/claims/search?order_id=${encodeURIComponent(orderId)}`);
          const cid = (r?.data?.[0]?.id) || (r?.results?.[0]?.id) || (r?.results?.[0]);
          if (cid) { step('claim_found_by_order', { orderId, claimId: cid }); return String(cid); }
        } catch (e) { step('claim_search_fail', e.message); }
        return null;
      }

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
        if (variationId && Array.isArray(j?.variations)) {
          const v = j.variations.find(v => String(v?.id) === String(variationId));
          const skuVar = v?.seller_custom_field || v?.seller_sku;
          if (notBlank(skuVar)) return skuVar;
        }
        const skuItem = j?.seller_custom_field || j?.seller_sku;
        return notBlank(skuItem) ? skuItem : null;
      };

      // ---------- dados base ----------
      const rawOrderId =
        (has.id_venda && dev.id_venda) ? dev.id_venda :
        (has.order_id  && dev.order_id) ? dev.order_id  : null;

      let orderId = await resolveOrderId(rawOrderId);

      let claimId =
        (has.claim_id && dev.claim_id) ? dev.claim_id :
        (has.ml_claim_id && dev.ml_claim_id) ? dev.ml_claim_id : null;

      if (!claimId && orderId) {
        claimId = await findClaimByOrder(orderId);
      }

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
          novo_cliente_nome = getBuyerName(o);
          const tot = getOrderTotalProducts(o);
          if (tot != null) novo_valor_produto = tot;
          novo_data_compra = getOrderDateIso(o);
          novo_loja_nome   = getStoreNickname(o);
          const ref = getFirstOrderItemRef(o);
          if (notBlank(ref?.sellerSku)) {
            novo_sku = ref.sellerSku;
          } else if (ref?.itemId) {
            novo_sku = await getSkuFromItem(ref.itemId, ref.variationId);
          }
          step('orders_ok', { orderId, items: (o?.order_items || o?.items || []).length, sum: novo_valor_produto });
        } catch (e) {
          step('orders_fail', { orderId, error: e.message });
        }
      } else {
        step('no_orderId', true);
      }

      // 2) FRETE DA DEVOLUÇÃO: /claims/{id}/charges/return-cost
      if (claimId) {
        try {
          const rc = await mget(`/post-purchase/v1/claims/${encodeURIComponent(claimId)}/charges/return-cost`);
          if (rc && rc.amount != null) novo_valor_frete = toNumber(rc.amount);
          step('return_cost_ok', { claimId, amount: novo_valor_frete });
        } catch (e) {
          step('return_cost_fail', { claimId, error: e.message });
        }
      } else {
        step('no_claimId', true);
      }

      // ---------- prepara UPDATE apenas do que mudou/existe ----------
      const set = [];
      const p   = [];

      // valores
      if (has.valor_produto && novo_valor_produto != null && toNumber(dev.valor_produto) !== toNumber(novo_valor_produto)) {
        set.push(`valor_produto=$${p.push(toNumber(novo_valor_produto))}`);
      }
      if (has.valor_frete && novo_valor_frete != null && toNumber(dev.valor_frete) !== toNumber(novo_valor_frete)) {
        set.push(`valor_frete=$${p.push(toNumber(novo_valor_frete))}`);
      }

      // cliente
      if (has.cliente_nome && notBlank(novo_cliente_nome) && String(dev.cliente_nome || '') !== String(novo_cliente_nome)) {
        set.push(`cliente_nome=$${p.push(novo_cliente_nome)}`);
      }

      // sku
      if (has.sku && notBlank(novo_sku) && String(dev.sku || '') !== String(novo_sku)) {
        set.push(`sku=$${p.push(novo_sku)}`);
      }

      // data_compra (yyyy-mm-dd)
      if (has.data_compra && notBlank(novo_data_compra) &&
          String(dev.data_compra || '').slice(0,10) !== String(novo_data_compra).slice(0,10)) {
        set.push(`data_compra=$${p.push(novo_data_compra)}`);
      }

      // loja_nome
      if (has.loja_nome && notBlank(novo_loja_nome) && String(dev.loja_nome || '') !== String(novo_loja_nome)) {
        set.push(`loja_nome=$${p.push(novo_loja_nome)}`);
      }

      // persistir claim descoberto, se houver coluna e ainda não tiver
      if (claimId && !dev.claim_id && !dev.ml_claim_id) {
        if (has.claim_id) {
          set.push(`claim_id=$${p.push(claimId)}`);
        } else if (has.ml_claim_id) {
          set.push(`ml_claim_id=$${p.push(claimId)}`);
        }
      }

      if (!set.length) {
        return res.json({ item: dev, note: 'sem alterações', debug, sources: { order_id: orderId || null, claim_id: claimId || null } });
      }

      set.push('updated_at=now()');
      p.push(id);

      const upd = await query(
        `UPDATE devolucoes SET ${set.join(', ')} WHERE id=$${p.length} RETURNING *`,
        p
      );

      res.json({
        item: upd.rows[0],
        debug,
        sources: { order_id: orderId || null, claim_id: claimId || null }
      });
    } catch (e) {
      console.error('[ML ENRICH] erro:', e);
      res.status(500).json({ error: 'Falha ao enriquecer dados do ML', detail: e?.message });
    }
  });
};
