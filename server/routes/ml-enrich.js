// server/routes/ml-enrich.js
'use strict';

const { query } = require('../db');

// ---------- utils sql ----------
function qOf(req) { return (req && req.q) ? req.q : query; }
async function tableHasColumns(table, cols, req) {
  const q = qOf(req);
  const { rows } = await q(
    `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1`,
    [table]
  );
  const set = new Set(rows.map(r => r.column_name));
  const out = {}; for (const c of cols) out[c] = set.has(c);
  return out;
}

// ---------- helpers gerais ----------
function toNumber(x){ const n = Number(x); return Number.isFinite(n) ? n : 0; }
function notBlank(v){ return v !== null && v !== undefined && String(v).trim() !== ''; }

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
  return b.name || b.nickname || null;
}
function getStoreNickname(o) { return o?.seller?.nickname || null; }
function getOrderDateIso(o) { return o?.date_created ? new Date(o.date_created).toISOString().slice(0,10) : null; }

// ---------- HTTP ML ----------
async function mget(token, path) {
  const base = 'https://api.mercadolibre.com';
  const r = await fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
  const txt = await r.text();
  let j = {}; try { j = txt ? JSON.parse(txt) : {}; } catch {}
  if (!r.ok) {
    const msg = j?.message || j?.error || r.statusText;
    const e = new Error(`${r.status} ${msg}`);
    e.status = r.status; e.payload = j;
    throw e;
  }
  return j;
}

// ---------- seleção automática de token ----------
function guessNickFromLoja(lojaNome) {
  if (!lojaNome) return null;
  const parts = String(lojaNome).split('·');
  const nick = (parts[parts.length - 1] || '').trim();
  return nick || null;
}

function envTokens() {
  const out = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (!v) continue;
    if (k === 'MELI_OWNER_TOKEN' || k === 'ML_ACCESS_TOKEN') {
      out.push({ token: v, tokenFrom: `env:${k}`, nick: null });
    } else if (k.startsWith('MELI_TOKEN_')) {
      out.push({ token: v, tokenFrom: `env:${k}`, nick: k.replace(/^MELI_TOKEN_/, '') });
    }
  }
  return out;
}

async function dbTokens() {
  try {
    const { rows } = await query(`SELECT id, nickname, access_token FROM ml_accounts WHERE access_token IS NOT NULL`);
    return rows.map(r => ({ token: r.access_token, tokenFrom: `db:ml_accounts#${r.id}`, nick: r.nickname || null }));
  } catch { return []; }
}

async function collectCandidateTokens(dev) {
  const list = [...await dbTokens(), ...envTokens()];

  // se loja_nome tiver apelido, prioriza env correspondente no início da fila
  const prefer = guessNickFromLoja(dev?.loja_nome);
  if (prefer) {
    const envKey = 'MELI_TOKEN_' + prefer.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    const v = process.env[envKey];
    if (v) list.unshift({ token: v, tokenFrom: `env:${envKey}`, nick: prefer });
  }

  const seen = new Set();
  return list.filter(t => !!t.token && !seen.has(t.token) && seen.add(t.token));
}

async function pickTokenForOrder({ orderId, claimId, dev, meta }) {
  const candidates = await collectCandidateTokens(dev);
  meta.candidates = candidates.map(c => c.tokenFrom);

  // 1) Se temos orderId, testa por /orders/{id}
  if (notBlank(orderId)) {
    for (const c of candidates) {
      try {
        const order = await mget(c.token, `/orders/${encodeURIComponent(orderId)}`);
        meta.chosen = c.tokenFrom;
        return { token: c.token, tokenFrom: c.tokenFrom, order };
      } catch (e) {
        meta.errors.push({ where: 'try:/orders', tokenFrom: c.tokenFrom, status: e.status || null });
      }
    }
  }

  // 2) Se falhou e temos claimId, testa por /claims/{id}
  if (notBlank(claimId)) {
    for (const c of candidates) {
      try {
        await mget(c.token, `/post-purchase/v1/claims/${encodeURIComponent(claimId)}`);
        meta.chosen = c.tokenFrom;
        return { token: c.token, tokenFrom: c.tokenFrom, order: null };
      } catch (e) {
        meta.errors.push({ where: 'try:/claims', tokenFrom: c.tokenFrom, status: e.status || null });
      }
    }
  }

  return { token: null, tokenFrom: null, order: null };
}

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

// ---------- CLAIM helpers ----------
async function fetchClaimRaw(token, claimId) {
  if (!notBlank(claimId)) return null;
  return await mget(token, `/post-purchase/v1/claims/${encodeURIComponent(claimId)}`);
}

function shapeClaimForUI(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const {
    id, resource_id, status, type, stage, claim_version,
    claimed_quantity, parent_id, resource, reason_id,
    fulfilled, quantity_type, players, available_actions,
    resolution, site_id, created_date, last_updated,
    related_entities, return: hasReturn
  } = raw;

  return {
    basic: {
      id, resource_id, status, type, stage, claim_version,
      claimed_quantity, parent_id, resource, reason_id,
      fulfilled, quantity_type, site_id, created_date, last_updated,
      has_return: Boolean(hasReturn)
    },
    players: Array.isArray(players) ? players : [],
    actions: Array.isArray(available_actions) ? available_actions : [],
    resolution: resolution ? { ...resolution } : null,
    related_entities: Array.isArray(related_entities) ? related_entities : []
  };
}

module.exports = function registerMlEnrich(app) {

  /**
   * PREVIEW
   * GET /api/ml/returns/:id/fetch-amounts?order_id=...&claim_id=...
   */
  app.get('/api/ml/returns/:id/fetch-amounts', async (req, res) => {
    const meta = { steps: [], errors: [], candidates: [], chosen: null };

    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID inválido' });

      const hasCols = await tableHasColumns('devolucoes', ['id_venda','order_id','claim_id','ml_claim_id','loja_nome'], req);
      const q = qOf(req);
      const { rows } = await q('SELECT * FROM devolucoes WHERE id=$1', [id]);
      const dev = rows[0] || {};

      const orderId =
        (req.query.order_id || req.query.orderId || '').toString().trim() ||
        (hasCols.id_venda && dev.id_venda) ||
        (hasCols.order_id && dev.order_id) || null;

      const claimId =
        (req.query.claim_id || req.query.claimId || '').toString().trim() ||
        (hasCols.claim_id && dev.claim_id) ||
        (hasCols.ml_claim_id && dev.ml_claim_id) || null;

      // escolhe token automaticamente (tenta todos)
      const pick = await pickTokenForOrder({ orderId, claimId, dev, meta });
      if (!pick.token) {
        return res.status(404).json({ error: 'Sem dados para esta devolução', meta });
      }

      // se já veio o order, usa; senão busca agora
      let order = pick.order;
      if (!order && notBlank(orderId)) {
        meta.steps.push({ op: 'GET /orders', orderId, using: pick.tokenFrom });
        try {
          order = await mget(pick.token, `/orders/${encodeURIComponent(orderId)}`);
        } catch (e) {
          meta.errors.push({ where: 'orders', status: e.status || null, message: e.message });
        }
      }

      // return-cost
      let retCost = null;
      const amounts = {};
      if (order) {
        const productTotal = sumOrderItemsTotal(order);
        if (productTotal != null) amounts.product = productTotal;
      }
      if (notBlank(claimId)) {
        meta.steps.push({ op: 'GET /claims/return-cost', claimId, using: pick.tokenFrom });
        try {
          const rc = await mget(pick.token, `/post-purchase/v1/claims/${encodeURIComponent(claimId)}/charges/return-cost`);
          if (rc && rc.amount != null) {
            amounts.freight = toNumber(rc.amount);
            retCost = rc;
          }
        } catch (e) {
          meta.errors.push({ where: 'return-cost', status: e.status || null, message: e.message });
        }
      }

      // claim raw + shape (preview também inclui para debug)
      let claim = null;
      if (notBlank(claimId)) {
        meta.steps.push({ op: 'GET /claims/{id}', claimId, using: pick.tokenFrom });
        try {
          const raw = await fetchClaimRaw(pick.token, claimId);
          claim = shapeClaimForUI(raw);
        } catch (e) {
          meta.errors.push({ where: 'claim', status: e.status || null, message: e.message });
        }
      }

      if (Object.keys(amounts).length === 0 && !order && !claim) {
        return res.status(404).json({ error: 'Sem dados para esta devolução', meta });
      }

      res.json({
        amounts,
        order,
        return_cost: retCost,
        claim,
        sources: { order_id: orderId || null, claim_id: claimId || null },
        meta
      });
    } catch (e) {
      console.error('[ML PREVIEW] erro:', e);
      res.status(500).json({ error: 'Falha ao buscar valores no ML', detail: e?.message || String(e) });
    }
  });

  // ------- enrich handler compartilhado (GET/POST) -------
  async function handleEnrich(req, res) {
    const meta = { steps: [], errors: [], candidates: [], chosen: null };

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
        'cliente_nome','sku','data_compra','loja_nome'
      ], req);

      const orderId =
        (has.id_venda && dev.id_venda) ? dev.id_venda :
        (has.order_id  && dev.order_id) ? dev.order_id  : null;

      const claimId =
        (has.claim_id && dev.claim_id) ? dev.claim_id :
        (has.ml_claim_id && dev.ml_claim_id) ? dev.ml_claim_id : null;

      const pick = await pickTokenForOrder({ orderId, claimId, dev, meta });
      if (!pick.token) return res.status(404).json({ error: 'Sem dados para enriquecer', meta });

      // ------- buscar dados no ML -------
      let novo_valor_produto = null;
      let novo_valor_frete   = null;
      let novo_cliente_nome  = null;
      let novo_sku           = null;
      let novo_data_compra   = null;
      let novo_loja_nome     = null;

      // order
      let order = null;
      if (notBlank(orderId)) {
        try {
          order = pick.order || await mget(pick.token, `/orders/${encodeURIComponent(orderId)}`);
          novo_cliente_nome = getBuyerName(order);
          const tot = sumOrderItemsTotal(order); if (tot != null) novo_valor_produto = tot;
          novo_data_compra = getOrderDateIso(order);
          const nick = getStoreNickname(order);
          novo_loja_nome = nick ? `Mercado Livre · ${nick}` : (dev.loja_nome || null);

          const items = Array.isArray(order?.order_items) ? order.order_items : (Array.isArray(order?.items) ? order.items : []);
          const first = items[0] || {};
          const itemId = first?.item?.id ?? first?.item?.item_id ?? first?.item_id ?? null;
          const variationId = first?.item?.variation_id ?? first?.variation_id ?? null;
          const sellerSku = first?.seller_sku ?? first?.item?.seller_sku ?? null;
          if (notBlank(sellerSku)) novo_sku = sellerSku;
          else if (itemId) novo_sku = await getSkuFromItem(pick.token, itemId, variationId);
        } catch (e) {
          meta.errors.push({ where: 'orders', status: e.status || null, message: e.message });
        }
      }

      // return-cost
      let retCost = null;
      if (notBlank(claimId)) {
        meta.steps.push({ op: 'GET /claims/return-cost', claimId, using: pick.tokenFrom });
        try {
          const rc = await mget(pick.token, `/post-purchase/v1/claims/${encodeURIComponent(claimId)}/charges/return-cost`);
          if (rc && rc.amount != null) novo_valor_frete = toNumber(rc.amount);
          retCost = rc || null;
        } catch (e) {
          meta.errors.push({ where: 'return-cost', status: e.status || null, message: e.message });
        }
      }

      // claim raw + shape
      let claim = null;
      if (notBlank(claimId)) {
        meta.steps.push({ op: 'GET /claims/{id}', claimId, using: pick.tokenFrom });
        try {
          const raw = await fetchClaimRaw(pick.token, claimId);
          claim = shapeClaimForUI(raw);
        } catch (e) {
          meta.errors.push({ where: 'claim', status: e.status || null, message: e.message });
        }
      }

      // ------- UPDATE só do que mudou -------
      const set = [];
      const p   = [];

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
        // sem alterações em banco, mas retorna o pacote completo para a UI
        return res.json({
          item: dev,
          note: 'sem alterações',
          order,
          return_cost: retCost,
          claim,
          sources: { order_id: orderId || null, claim_id: claimId || null },
          meta
        });
      }

      set.push('updated_at=now()');
      p.push(id);

      const upd = await q(`UPDATE devolucoes SET ${set.join(', ')} WHERE id=$${p.length} RETURNING *`, p);
      res.json({
        item: upd.rows[0],
        order,
        return_cost: retCost,
        claim,
        sources: { order_id: orderId || null, claim_id: claimId || null },
        meta
      });
    } catch (e) {
      console.error('[ML ENRICH] erro:', e);
      res.status(500).json({ error: 'Falha ao enriquecer dados do ML', detail: e?.message });
    }
  }

  /**
   * ENRICH (POST e GET, mesma lógica)
   * POST /api/ml/returns/:id/enrich
   * GET  /api/ml/returns/:id/enrich
   */
  app.post('/api/ml/returns/:id/enrich', handleEnrich);
  app.get('/api/ml/returns/:id/enrich', handleEnrich);
};
