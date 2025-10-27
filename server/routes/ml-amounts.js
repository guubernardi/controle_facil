// server/routes/ml-enrich.js
'use strict';

const { query } = require('../db');

function toNumber(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }
function notBlank(v){ return v !== null && v !== undefined && String(v).trim() !== ''; }

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

// tenta achar o nickname (ex.: "BUSCOU" em "Mercado Livre · BUSCOU")
function guessNickFromLoja(lojaNome) {
  if (!lojaNome) return null;
  const parts = String(lojaNome).split('·');
  const nick = (parts[parts.length - 1] || '').trim();
  return nick || null;
}

async function getTokenForReturn(dev) {
  // 1) env MELI_TOKEN_<NICK> (ex.: MELI_TOKEN_BUSCOU)
  const nick = guessNickFromLoja(dev?.loja_nome);
  if (nick) {
    const envKey = ('MELI_TOKEN_' + nick.toUpperCase().replace(/[^A-Z0-9]+/g, '_'));
    if (process.env[envKey]) {
      return { token: process.env[envKey], tokenFrom: `env:${envKey}`, sellerNick: nick };
    }
    // 2) opcional: tabela ml_accounts
    try {
      const { rows } = await query(
        `SELECT access_token FROM ml_accounts WHERE LOWER(nickname) = LOWER($1) LIMIT 1`,
        [nick]
      );
      if (rows[0]?.access_token) {
        return { token: rows[0].access_token, tokenFrom: 'db:ml_accounts.nickname', sellerNick: nick };
      }
    } catch (_) {}
  }
  // 3) fallback global
  const fallback = process.env.MELI_OWNER_TOKEN || process.env.ML_ACCESS_TOKEN || null;
  return { token: fallback, tokenFrom: 'env:MELI_OWNER_TOKEN', sellerNick: nick || null };
}

// helpers para extrair infos do pedido
const getBuyerName = (o) => {
  const b = o?.buyer || {};
  const full = [b.first_name, b.last_name].filter(Boolean).join(' ').trim();
  if (full) return full;
  const recv = o?.shipping?.receiver_address?.receiver_name;
  if (recv) return recv;
  return b.name || b.nickname || null;
};
const getOrderDateIso = (o) =>
  o?.date_created ? new Date(o.date_created).toISOString().slice(0, 10) : null;
const getStoreNickname = (o) => o?.seller?.nickname || null;
const getOrderItems = (o) =>
  Array.isArray(o?.order_items) ? o.order_items : (Array.isArray(o?.items) ? o.items : []);

const getOrderTotalProducts = (o) => {
  const items = getOrderItems(o);
  let sum = 0;
  for (const it of items) {
    const unit = toNumber(it?.unit_price ?? it?.sale_price ?? it?.price);
    const qty  = toNumber(it?.quantity ?? 1);
    sum += unit * (qty || 1);
  }
  return sum > 0 ? sum : null;
};

const getFirstOrderItemRef = (o) => {
  const items = getOrderItems(o);
  const it = items[0];
  if (!it) return {};
  const itemId = it?.item?.id ?? it?.item?.item_id ?? it?.item_id ?? null;
  const variationId = it?.item?.variation_id ?? it?.variation_id ?? null;
  const sellerSku = it?.seller_sku ?? it?.item?.seller_sku ?? null;
  return { itemId, variationId, sellerSku };
};

module.exports = function registerMlEnrich(app) {
  // POST /api/ml/returns/:id/enrich[?order_id=...&claim_id=...]
  app.post('/api/ml/returns/:id/enrich', async (req, res) => {
    const meta = { steps: [], errors: [], tokenFrom: null, sellerNick: null };
    const pushErr = (where, err) => {
      const info = {
        where,
        message: err?.message || String(err),
        status: err?.status || null,
        payload: err?.payload || null,
      };
      meta.errors.push(info);
      console.warn('[ML ENRICH]', where, info);
    };

    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID inválido' });

      // Carrega devolução para descobrir loja/apelido e ids
      const hasCols = await tableHasColumns('devolucoes', [
        'id_venda','order_id','valor_produto','valor_frete',
        'claim_id','ml_claim_id','cliente_nome','sku','data_compra','loja_nome'
      ]);
      const { rows } = await query('SELECT * FROM devolucoes WHERE id=$1', [id]);
      if (!rows.length) return res.status(404).json({ error: 'Não encontrado' });
      const dev = rows[0];

      // ids por query têm prioridade
      let orderId = (req.query.order_id || '').trim();
      let claimId = (req.query.claim_id || '').trim();
      if (!orderId) orderId = (hasCols.id_venda && dev.id_venda) || (hasCols.order_id && dev.order_id) || '';
      if (!claimId) claimId = (hasCols.claim_id && dev.claim_id) || (hasCols.ml_claim_id && dev.ml_claim_id) || '';

      // Escolhe token da loja
      const { token, tokenFrom, sellerNick } = await getTokenForReturn(dev);
      meta.tokenFrom = tokenFrom; meta.sellerNick = sellerNick;
      if (!token) return res.status(400).json({ error: 'Access token ausente para esta loja', meta });

      const base = 'https://api.mercadolibre.com';
      const mget = async (path) => {
        const r = await fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
        let j = {}; try { j = await r.json(); } catch (_) {}
        if (!r.ok) {
          const e = new Error(`${r.status} ${j?.message || j?.error || r.statusText}`);
          e.status = r.status; e.payload = j; throw e;
        }
        return j;
      };

      // ---------- Buscar ORDER (produto + metadados) ----------
      let novo_valor_produto = null;
      let novo_cliente_nome  = null;
      let novo_sku           = null;
      let novo_data_compra   = null;
      let novo_loja_nome     = null;

      if (notBlank(orderId)) {
        try {
          meta.steps.push({ op: 'GET /orders', orderId });
          const o = await mget(`/orders/${encodeURIComponent(orderId)}`);

          novo_valor_produto = getOrderTotalProducts(o);
          novo_cliente_nome  = getBuyerName(o);
          novo_data_compra   = getOrderDateIso(o);
          const nick         = getStoreNickname(o);
          novo_loja_nome     = nick ? `Mercado Livre · ${nick}` : (dev.loja_nome || null);

          const ref = getFirstOrderItemRef(o);
          if (notBlank(ref?.sellerSku)) {
            novo_sku = ref.sellerSku;
          } else if (ref?.itemId) {
            try {
              meta.steps.push({ op: 'GET /items', itemId: ref.itemId, variationId: ref.variationId || null });
              const it = await mget(`/items/${encodeURIComponent(ref.itemId)}?include_attributes=all`);
              if (ref.variationId && Array.isArray(it?.variations)) {
                const v = it.variations.find(v => String(v?.id) === String(ref.variationId));
                const skuVar = v?.seller_custom_field || v?.seller_sku;
                if (notBlank(skuVar)) novo_sku = skuVar;
              }
              if (!novo_sku) {
                const skuItem = it?.seller_custom_field || it?.seller_sku;
                if (notBlank(skuItem)) novo_sku = skuItem;
              }
            } catch (e) { pushErr('items', e); }
          }
        } catch (e) {
          pushErr('orders', e);
        }
      }

      // ---------- Buscar FRETE da devolução ----------
      let novo_valor_frete = null;
      if (notBlank(claimId)) {
        try {
          meta.steps.push({ op: 'GET /claims/return-cost', claimId });
          const rc = await mget(`/post-purchase/v1/claims/${encodeURIComponent(claimId)}/charges/return-cost`);
          if (rc && rc.amount != null) novo_valor_frete = toNumber(rc.amount);
        } catch (e) {
          pushErr('return-cost', e);
        }
      }

      // ---------- Monta UPDATE apenas do que mudou ----------
      const set = [];
      const p   = [];

      if (hasCols.valor_produto && novo_valor_produto != null) {
        const atual = toNumber(dev.valor_produto);
        if (atual !== toNumber(novo_valor_produto)) {
          set.push(`valor_produto=$${p.push(toNumber(novo_valor_produto))}`);
        }
      }
      if (hasCols.valor_frete && novo_valor_frete != null) {
        const atual = toNumber(dev.valor_frete);
        if (atual !== toNumber(novo_valor_frete)) {
          set.push(`valor_frete=$${p.push(toNumber(novo_valor_frete))}`);
        }
      }
      if (hasCols.cliente_nome && notBlank(novo_cliente_nome)) {
        if (!notBlank(dev.cliente_nome) || String(dev.cliente_nome) !== String(novo_cliente_nome)) {
          set.push(`cliente_nome=$${p.push(novo_cliente_nome)}`);
        }
      }
      if (hasCols.sku && notBlank(novo_sku)) {
        if (!notBlank(dev.sku) || String(dev.sku) !== String(novo_sku)) {
          set.push(`sku=$${p.push(novo_sku)}`);
        }
      }
      if (hasCols.data_compra && notBlank(novo_data_compra)) {
        if (!notBlank(dev.data_compra) || String(dev.data_compra).slice(0,10) !== String(novo_data_compra).slice(0,10)) {
          set.push(`data_compra=$${p.push(novo_data_compra)}`);
        }
      }
      if (hasCols.loja_nome && notBlank(novo_loja_nome)) {
        if (!notBlank(dev.loja_nome) || String(dev.loja_nome) !== String(novo_loja_nome)) {
          set.push(`loja_nome=$${p.push(novo_loja_nome)}`);
        }
      }

      if (!set.length) {
        return res.json({ item: dev, note: 'sem alterações', meta });
      }

      set.push('updated_at=now()');
      p.push(id);

      const upd = await query(
        `UPDATE devolucoes SET ${set.join(', ')} WHERE id=$${p.length} RETURNING *`,
        p
      );

      return res.json({
        item: upd.rows[0],
        sources: { order_id: notBlank(orderId) ? orderId : null, claim_id: notBlank(claimId) ? claimId : null },
        meta
      });
    } catch (e) {
      console.error('[ML ENRICH] erro:', e);
      return res.status(500).json({ error: 'Falha ao enriquecer dados do ML', detail: e?.message });
    }
  });
};
