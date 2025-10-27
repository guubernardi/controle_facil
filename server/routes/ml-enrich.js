'use strict';

const { query } = require('../db');

// ================== utils ==================
const toNumber = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
const notBlank = (v) => v !== null && v !== undefined && String(v).trim() !== '';

function qOf(req){ return (req && req.q) ? req.q : query; }

async function tableHasColumns(table, cols, req) {
  const q = qOf(req);
  const { rows } = await q(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1`, [table]
  );
  const set = new Set(rows.map(r => r.column_name));
  const out = {}; for (const c of cols) out[c] = set.has(c);
  return out;
}

// normaliza para comparar (tira acento, símbolos e espaços duplicados)
function normStr(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim().replace(/\s+/g, ' ')
    .toUpperCase();
}

// tenta achar o nickname em "Mercado Livre · META P," etc.
function guessNickFromLoja(lojaNome) {
  if (!lojaNome) return null;
  const parts = String(lojaNome).split('·');
  let nick = (parts[parts.length - 1] || '').trim();
  nick = nick.replace(/[^\p{L}\p{N}\s]/gu, '').trim();  // tira vírgulas/pontos finais
  return nick || null;
}

// ====== coleta de tokens sem hardcode ======
async function listDbTokensLikeNick(nick, req) {
  const q = qOf(req);
  if (!nick) return [];
  const like = '%' + normStr(nick).replace(/\s+/g, '%') + '%';
  const { rows } = await q(
    `SELECT nickname, seller_id, access_token
       FROM ml_accounts
      WHERE access_token IS NOT NULL
        AND UPPER(TRANSLATE(nickname,
              'ÁÀÂÃÄÅáàâãäåÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇçÑñ',
              'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCcNn'
            )) LIKE $1
      LIMIT 5`, [like]
  );
  return rows.map(r => ({ token: r.access_token, from: `db:ml_accounts:${r.nickname || r.seller_id || 'nick'}` }));
}

async function listAllDbTokens(req) {
  const q = qOf(req);
  const { rows } = await q(
    `SELECT nickname, seller_id, access_token
       FROM ml_accounts
      WHERE access_token IS NOT NULL`
  );
  return rows.map(r => ({ token: r.access_token, from: `db:ml_accounts:${r.nickname || r.seller_id || 'nick'}` }));
}

function listEnvTokensPreferNick(nick) {
  const out = [];
  const env = process.env || {};
  const normNick = normStr(nick);
  for (const k of Object.keys(env)) {
    if (!/^M(ELI|L)_TOKEN_/i.test(k)) continue;
    const from = `env:${k}`;
    const tok  = env[k];
    out.push({ token: tok, from, key: k });
  }
  // owner/fallback
  if (env.MELI_OWNER_TOKEN) out.unshift({ token: env.MELI_OWNER_TOKEN, from: 'env:MELI_OWNER_TOKEN' });
  if (env.ML_ACCESS_TOKEN)  out.unshift({ token: env.ML_ACCESS_TOKEN,  from: 'env:ML_ACCESS_TOKEN' });

  // se temos nick, ordena por probabilidade de match no nome da key
  if (normNick) {
    out.sort((a,b)=>{
      const an = normStr(a.from);
      const bn = normStr(b.from);
      const as = an.includes(normNick) ? -1 : 0;
      const bs = bn.includes(normNick) ? -1 : 0;
      return as - bs;
    });
  }
  // dedup por token
  const seen = new Set(); const uniq = [];
  for (const t of out) { if (t.token && !seen.has(t.token)) { seen.add(t.token); uniq.push(t); } }
  return uniq;
}

// junta candidatos: 1) env (prioriza chaves que parecem o nick) 2) db ~nick 3) db todos
async function buildTokenCandidates(dev, req) {
  const nick = guessNickFromLoja(dev?.loja_nome);
  const env = listEnvTokensPreferNick(nick);
  const dbLike = await listDbTokensLikeNick(nick, req);
  const dbAll  = await listAllDbTokens(req);
  const list = [...env, ...dbLike, ...dbAll];

  // dedup final por token:
  const seen = new Set(); const final = [];
  for (const t of list) { if (t.token && !seen.has(t.token)) { seen.add(t.token); final.push(t); } }
  return { nick, tokens: final };
}

// fetch com um token
async function mgetWithToken(token, path) {
  const base = 'https://api.mercadolibre.com';
  const r = await fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
  const txt = await r.text();
  let j = {}; try { j = txt ? JSON.parse(txt) : {}; } catch {}
  if (!r.ok) {
    const e = new Error(`${r.status} ${j?.message || j?.error || r.statusText}`);
    e.status = r.status; e.payload = j;
    throw e;
  }
  return j;
}

// tenta a mesma chamada em vários tokens até dar 200
async function tryTokens(tokens, path, meta, label) {
  const errs = [];
  for (const t of tokens) {
    try {
      const j = await mgetWithToken(t.token, path);
      meta && meta.push({ op: `GET ${label}`, ok: true, from: t.from });
      return { json: j, used: t };
    } catch (e) {
      errs.push({ from: t.from, status: e.status, message: e.message });
      // 401/403 => tenta próximo token; outros erros (5xx/404) também seguimos tentando
    }
  }
  return { json: null, used: null, errors: errs };
}

// helpers de pedido
const getOrderItems = (o) =>
  Array.isArray(o?.order_items) ? o.order_items : (Array.isArray(o?.items) ? o.items : []);

const sumOrderItemsTotal = (o) => {
  const items = getOrderItems(o); let sum = 0;
  for (const it of items) {
    const unit = toNumber(it?.unit_price ?? it?.sale_price ?? it?.price);
    const qty  = toNumber(it?.quantity ?? 1);
    sum += unit * (qty || 1);
  }
  return sum || null;
};

const getBuyerName = (o) => {
  const b = o?.buyer || {};
  const full = [b.first_name, b.last_name].filter(Boolean).join(' ').trim();
  if (full) return full;
  const recv = o?.shipping?.receiver_address?.receiver_name;
  if (recv) return recv;
  return b.name || b.nickname || null;
};
const getOrderDateIso = (o) => o?.date_created ? new Date(o.date_created).toISOString().slice(0,10) : null;

// busca SKU do primeiro item (variante → item)
async function getSkuFromItem(token, itemId, variationId) {
  if (!itemId) return null;
  const it = await mgetWithToken(token, `/items/${encodeURIComponent(itemId)}?include_attributes=all`);
  if (variationId && Array.isArray(it?.variations)) {
    const v = it.variations.find(v => String(v?.id) === String(variationId));
    const skuVar = v?.seller_custom_field || v?.seller_sku;
    if (notBlank(skuVar)) return skuVar;
  }
  const skuItem = it?.seller_custom_field || it?.seller_sku;
  return notBlank(skuItem) ? skuItem : null;
}

// ================== rotas ==================
module.exports = function registerMlEnrich(app) {

  /**
   * PREVIEW
   * GET /api/ml/returns/:id/fetch-amounts?order_id=...&claim_id=...
   */
  app.get('/api/ml/returns/:id/fetch-amounts', async (req, res) => {
    const meta = { steps: [], tried: [], errors: [] };
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID inválido' });

      const has = await tableHasColumns('devolucoes', ['id_venda','order_id','claim_id','ml_claim_id','loja_nome'], req);
      const q = qOf(req);
      const { rows } = await q('SELECT * FROM devolucoes WHERE id=$1', [id]);
      const dev = rows[0] || {};

      const orderId = (req.query.order_id || req.query.orderId || '').trim() ||
                      (has.id_venda && dev.id_venda) || (has.order_id && dev.order_id) || null;
      const claimId = (req.query.claim_id || req.query.claimId || '').trim() ||
                      (has.claim_id && dev.claim_id) || (has.ml_claim_id && dev.ml_claim_id) || null;

      if (!orderId && !claimId) return res.status(404).json({ error: 'Sem dados para esta devolução' });

      // monta tokens candidatos (env + db), priorizando o nick inferido
      const { nick, tokens } = await buildTokenCandidates(dev, req);
      meta.nick = nick;
      meta.candidates = tokens.map(t => t.from);

      let order = null, retCost = null, amounts = {};

      // tenta ler ORDER com os tokens
      if (orderId) {
        const r = await tryTokens(tokens, `/orders/${encodeURIComponent(orderId)}`, meta.steps, '/orders');
        if (r.json) {
          order = r.json;
          const total = sumOrderItemsTotal(order);
          if (total != null) amounts.product = total;
          meta.order_token = r.used?.from || null;
        } else {
          meta.errors.push({ where: 'orders', tries: r.errors });
        }
      }

      // tenta ler RETURN COST com os tokens (pode ser outro token!)
      if (claimId) {
        const r = await tryTokens(tokens, `/post-purchase/v1/claims/${encodeURIComponent(claimId)}/charges/return-cost`, meta.steps, 'return-cost');
        if (r.json && r.json.amount != null) {
          amounts.freight = toNumber(r.json.amount);
          retCost = r.json;
          meta.return_cost_token = r.used?.from || null;
        } else if (r && r.errors) {
          meta.errors.push({ where: 'return-cost', tries: r.errors });
        }
      }

      if (!order && Object.keys(amounts).length === 0) {
        return res.status(404).json({ error: 'Sem dados para esta devolução', meta });
      }

      res.json({
        amounts,
        order,
        return_cost: retCost,
        sources: { order_id: orderId || null, claim_id: claimId || null },
        meta
      });
    } catch (e) {
      res.status(500).json({ error: 'Falha ao buscar valores no ML', detail: e?.message });
    }
  });

  /**
   * ENRICH
   * POST /api/ml/returns/:id/enrich
   * Atualiza campos (valor_produto, valor_frete, cliente_nome, sku, data_compra, loja_nome)
   */
  app.post('/api/ml/returns/:id/enrich', async (req, res) => {
    const meta = { steps: [], errors: [] };
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID inválido' });

      const q = qOf(req);
      const { rows } = await q('SELECT * FROM devolucoes WHERE id=$1', [id]);
      if (!rows.length) return res.status(404).json({ error: 'Não encontrado' });
      const dev = rows[0];

      const has = await tableHasColumns('devolucoes', [
        'id_venda','order_id','valor_produto','valor_frete','claim_id','ml_claim_id',
        'cliente_nome','sku','data_compra','loja_nome'
      ], req);

      const orderId = (has.id_venda && dev.id_venda) ? dev.id_venda :
                      (has.order_id  && dev.order_id) ? dev.order_id  : null;

      const claimId = (has.claim_id && dev.claim_id) ? dev.claim_id :
                      (has.ml_claim_id && dev.ml_claim_id) ? dev.ml_claim_id : null;

      const { tokens } = await buildTokenCandidates(dev, req);

      let novo_valor_produto = null;
      let novo_valor_frete   = null;
      let novo_cliente_nome  = null;
      let novo_sku           = null;
      let novo_data_compra   = null;
      let novo_loja_nome     = null;

      // ORDER
      if (orderId) {
        const r = await tryTokens(tokens, `/orders/${encodeURIComponent(orderId)}`, meta.steps, '/orders');
        if (r.json) {
          const o = r.json;
          novo_cliente_nome = getBuyerName(o);
          const tot = sumOrderItemsTotal(o);
          if (tot != null) novo_valor_produto = tot;
          novo_data_compra = getOrderDateIso(o);
          const nick = o?.seller?.nickname;
          if (nick) novo_loja_nome = `Mercado Livre · ${nick}`;

          // SKU
          const items = getOrderItems(o);
          const first = items[0] || {};
          const itemId = first?.item?.id ?? first?.item?.item_id ?? first?.item_id ?? null;
          const variationId = first?.item?.variation_id ?? first?.variation_id ?? null;
          const sellerSku = first?.seller_sku ?? first?.item?.seller_sku ?? null;
          if (notBlank(sellerSku)) novo_sku = sellerSku;
          else if (itemId) {
            try {
              const sku = await getSkuFromItem(r.used.token, itemId, variationId);
              if (notBlank(sku)) novo_sku = sku;
            } catch (e) { meta.errors.push({ where: 'items', message: e.message, status: e.status }); }
          }
        } else {
          meta.errors.push({ where: 'orders', tries: r.errors });
        }
      }

      // RETURN COST
      if (claimId) {
        const r = await tryTokens(tokens, `/post-purchase/v1/claims/${encodeURIComponent(claimId)}/charges/return-cost`, meta.steps, 'return-cost');
        if (r.json && r.json.amount != null) novo_valor_frete = toNumber(r.json.amount);
        else if (r && r.errors) meta.errors.push({ where: 'return-cost', tries: r.errors });
      }

      // UPDATE seletivo
      const set = []; const p = [];
      if (has.valor_produto && novo_valor_produto != null && toNumber(dev.valor_produto) !== toNumber(novo_valor_produto))
        set.push(`valor_produto=$${p.push(toNumber(novo_valor_produto))}`);
      if (has.valor_frete && novo_valor_frete != null && toNumber(dev.valor_frete) !== toNumber(novo_valor_frete))
        set.push(`valor_frete=$${p.push(toNumber(novo_valor_frete))}`);
      if (has.cliente_nome && notBlank(novo_cliente_nome) &&
          (!notBlank(dev.cliente_nome) || String(dev.cliente_nome) !== String(novo_cliente_nome)))
        set.push(`cliente_nome=$${p.push(novo_cliente_nome)}`);
      if (has.sku && notBlank(novo_sku) && (!notBlank(dev.sku) || String(dev.sku) !== String(novo_sku)))
        set.push(`sku=$${p.push(novo_sku)}`);
      if (has.data_compra && notBlank(novo_data_compra) &&
          (!notBlank(dev.data_compra) || String(dev.data_compra).slice(0,10) !== String(novo_data_compra).slice(0,10)))
        set.push(`data_compra=$${p.push(novo_data_compra)}`);
      if (has.loja_nome && notBlank(novo_loja_nome) &&
          (!notBlank(dev.loja_nome) || String(dev.loja_nome) !== String(novo_loja_nome)))
        set.push(`loja_nome=$${p.push(novo_loja_nome)}`);

      if (!set.length) return res.json({ item: dev, note: 'sem alterações', meta });

      set.push('updated_at=now()'); p.push(id);
      const upd = await q(`UPDATE devolucoes SET ${set.join(', ')} WHERE id=$${p.length} RETURNING *`, p);
      res.json({ item: upd.rows[0], meta });
    } catch (e) {
      res.status(500).json({ error: 'Falha ao enriquecer dados do ML', detail: e?.message });
    }
  });
};
