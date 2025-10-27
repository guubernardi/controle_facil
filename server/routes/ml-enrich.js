// server/routes/ml-enrich.js
'use strict';

const { query } = require('../db');

function toNumber(x){ const n = Number(x); return Number.isFinite(n) ? n : 0; }
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

function guessNickFromLoja(lojaNome) {
  if (!lojaNome) return null;
  const parts = String(lojaNome).split('·');
  const nick = (parts[parts.length - 1] || '').trim();
  return nick || null;
}
async function getTokenForReturn(dev) {
  const nick = guessNickFromLoja(dev?.loja_nome);
  if (nick) {
    const envKey = ('MELI_TOKEN_' + nick.toUpperCase().replace(/[^A-Z0-9]+/g, '_'));
    if (process.env[envKey]) return { token: process.env[envKey], tokenFrom: `env:${envKey}`, sellerNick: nick };
    try {
      const { rows } = await query(`SELECT access_token FROM ml_accounts WHERE LOWER(nickname)=LOWER($1) LIMIT 1`, [nick]);
      if (rows[0]?.access_token) return { token: rows[0].access_token, tokenFrom: 'db:ml_accounts.nickname', sellerNick: nick };
    } catch {}
  }
  const fallback = process.env.MELI_OWNER_TOKEN || process.env.ML_ACCESS_TOKEN || null;
  return { token: fallback, tokenFrom: 'env:MELI_OWNER_TOKEN', sellerNick: nick || null };
}

async function mget(token, path) {
  const base = 'https://api.mercadolibre.com';
  const r = await fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
  let j = {}; try { j = await r.json(); } catch {}
  if (!r.ok) {
    const e = new Error(`${r.status} ${j?.message || j?.error || r.statusText}`);
    e.status = r.status; e.payload = j; throw e;
  }
  return j;
}

// mapeia reason para frase que casa com suas regras de dashboard
function normalizeReason(reasonId, reasonName) {
  const t = String(reasonName || reasonId || '').toLowerCase();
  if (/tamanho|size/.test(t))       return 'Tamanho incorreto (cliente)';
  if (/cor|color/.test(t))          return 'Cor errada (cliente)';
  if (/arrepend|didn.?t like|no me gust|engano|mistake|compra errad|nao serviu|não serviu/.test(t))
                                    return 'Arrependimento do cliente';
  if (/defeit|avari|damag|quebrad|faltando|incomplet/.test(t))
                                    return 'Defeito/avaria no produto';
  return reasonName || reasonId || null;
}

const getOrderItems = (o) => Array.isArray(o?.order_items) ? o.order_items : (Array.isArray(o?.items) ? o.items : []);
const sumOrderProducts = (o) => {
  let sum = 0;
  for (const it of getOrderItems(o)) {
    const unit = toNumber(it?.unit_price ?? it?.sale_price ?? it?.price);
    const qty  = toNumber(it?.quantity ?? 1);
    sum += unit * (qty || 1);
  }
  return sum > 0 ? sum : null;
};
const getBuyerName = (o) => {
  const b = o?.buyer || {};
  const full = [b.first_name, b.last_name].filter(Boolean).join(' ').trim();
  if (full) return full;
  const recv = o?.shipping?.receiver_address?.receiver_name;
  if (recv) return recv;
  return b.name || b.nickname || null;
};
const getOrderDateIso  = (o) => o?.date_created ? new Date(o.date_created).toISOString().slice(0,10) : null;
const getStoreNickname = (o) => o?.seller?.nickname || null;

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

module.exports = function registerMlEnrich(app) {
  // POST /api/ml/returns/:id/enrich
  app.post('/api/ml/returns/:id/enrich', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID inválido' });

      const { rows } = await query('SELECT * FROM devolucoes WHERE id=$1', [id]);
      if (!rows.length) return res.status(404).json({ error: 'Não encontrado' });
      const dev = rows[0];

      const has = await tableHasColumns('devolucoes', [
        'id_venda','order_id','valor_produto','valor_frete',
        'claim_id','ml_claim_id','cliente_nome','sku','data_compra','loja_nome',
        'tipo_reclamacao','reclamacao'
      ]);

      const orderId = (has.id_venda && dev.id_venda) || (has.order_id && dev.order_id) || null;
      const claimId = (has.claim_id && dev.claim_id) || (has.ml_claim_id && dev.ml_claim_id) || null;

      const { token } = await getTokenForReturn(dev);
      if (!token) return res.status(400).json({ error: 'Access token ausente para esta loja' });

      // dados a atualizar
      let novo_valor_produto = null;
      let novo_valor_frete   = null;
      let novo_cliente_nome  = null;
      let novo_sku           = null;
      let novo_data_compra   = null;
      let novo_loja_nome     = null;
      let novo_motivo        = null;

      // ORDER
      if (orderId) {
        try {
          const o = await mget(token, `/orders/${encodeURIComponent(orderId)}`);
          novo_valor_produto = sumOrderProducts(o);
          novo_cliente_nome  = getBuyerName(o);
          novo_data_compra   = getOrderDateIso(o);
          const nick         = getStoreNickname(o);
          if (nick) novo_loja_nome = `Mercado Livre · ${nick}`;
          const first = getOrderItems(o)[0] || {};
          const itemId = first?.item?.id ?? first?.item?.item_id ?? first?.item_id ?? null;
          const variationId = first?.item?.variation_id ?? first?.variation_id ?? null;
          const sellerSku   = first?.seller_sku ?? first?.item?.seller_sku ?? null;
          novo_sku = notBlank(sellerSku) ? sellerSku : (itemId ? await getSkuFromItem(token, itemId, variationId) : null);
        } catch (e) {
          console.warn('[ML ENRICH] /orders falhou:', e?.message || e);
        }
      }

      // CLAIM (motivo + frete)
      if (claimId) {
        try {
          const c = await mget(token, `/post-purchase/v1/claims/${encodeURIComponent(claimId)}`);
          const rid   = c?.reason_id || c?.reason?.id || null;
          const rname = c?.reason_name || c?.reason?.name || c?.reason?.description || null;
          novo_motivo = normalizeReason(rid, rname);
        } catch (e) {
          console.warn('[ML ENRICH] /claims falhou:', e?.message || e);
        }
        try {
          const rc = await mget(token, `/post-purchase/v1/claims/${encodeURIComponent(claimId)}/charges/return-cost`);
          if (rc && rc.amount != null) novo_valor_frete = toNumber(rc.amount);
        } catch (e) {
          console.warn('[ML ENRICH] return-cost falhou:', e?.message || e);
        }
      }

      // monta UPDATE apenas do que mudou
      const set = [], p = [];
      if (has.valor_produto && novo_valor_produto != null && toNumber(dev.valor_produto) !== toNumber(novo_valor_produto)) {
        set.push(`valor_produto=$${p.push(toNumber(novo_valor_produto))}`);
      }
      if (has.valor_frete && novo_valor_frete != null && toNumber(dev.valor_frete) !== toNumber(novo_valor_frete)) {
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
      // motivo – tenta em tipo_reclamacao, senão em reclamacao
      if (notBlank(novo_motivo)) {
        if (has.tipo_reclamacao && (!notBlank(dev.tipo_reclamacao) || String(dev.tipo_reclamacao) !== String(novo_motivo))) {
          set.push(`tipo_reclamacao=$${p.push(novo_motivo)}`);
        } else if (has.reclamacao && (!notBlank(dev.reclamacao) || String(dev.reclamacao) !== String(novo_motivo))) {
          set.push(`reclamacao=$${p.push(novo_motivo)}`);
        }
      }

      if (!set.length) return res.json({ item: dev, note: 'sem alterações' });

      set.push('updated_at=now()');
      p.push(id);
      const upd = await query(`UPDATE devolucoes SET ${set.join(', ')} WHERE id=$${p.length} RETURNING *`, p);

      return res.json({
        item: upd.rows[0],
        sources: { order_id: orderId || null, claim_id: claimId || null }
      });
    } catch (e) {
      console.error('[ML ENRICH] erro:', e);
      return res.status(500).json({ error: 'Falha ao enriquecer dados do ML', detail: e?.message || String(e) });
    }
  });
};
