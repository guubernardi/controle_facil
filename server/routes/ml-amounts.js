// server/routes/ml-amounts.js
'use strict';

const { query } = require('../db');

function toNumber(x){ const n = Number(x); return Number.isFinite(n) ? n : 0; }
function notBlank(v){ return v !== null && v !== undefined && String(v).trim() !== ''; }

// -- columns helper
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

// tenta achar o nickname no "loja_nome" (ex.: "Mercado Livre · BUSCOU")
function guessNickFromLoja(lojaNome) {
  if (!lojaNome) return null;
  const parts = String(lojaNome).split('·');
  const nick = (parts[parts.length - 1] || '').trim();
  return nick || null;
}

// ================== TOKENS (pool dinâmico) ==================
async function listDbTokens() {
  try {
    const { rows } = await query(
      `SELECT COALESCE(nickname,'') AS nickname, access_token
         FROM ml_accounts
        WHERE access_token IS NOT NULL AND access_token <> ''`
    );
    return rows.map(r => ({
      token: r.access_token,
      source: r.nickname ? `db:ml_accounts.nickname(${r.nickname})` : 'db:ml_accounts',
      nickname: r.nickname || null
    }));
  } catch {
    return [];
  }
}
function listEnvTokens() {
  const items = [];
  for (const k of Object.keys(process.env)) {
    if (/^MELI[_-]?TOKEN_/i.test(k)) {
      items.push({ token: process.env[k], source: `env:${k}`, nickname: k.replace(/^MELI[_-]?TOKEN_/i,'') });
    }
  }
  if (process.env.MELI_OWNER_TOKEN) items.push({ token: process.env.MELI_OWNER_TOKEN, source: 'env:MELI_OWNER_TOKEN', nickname: null });
  if (process.env.ML_ACCESS_TOKEN)  items.push({ token: process.env.ML_ACCESS_TOKEN,  source: 'env:ML_ACCESS_TOKEN',  nickname: null });
  return items.filter(t => notBlank(t.token));
}
async function buildTokenPool(dev) {
  const pool = [];
  const seen = new Set();

  // 1) tentar pelo apelido que veio em loja_nome
  const nick = guessNickFromLoja(dev?.loja_nome);
  if (nick) {
    const envKey = ('MELI_TOKEN_' + nick.toUpperCase().replace(/[^A-Z0-9]+/g, '_'));
    if (process.env[envKey]) {
      const tk = process.env[envKey];
      if (!seen.has(tk)) { pool.push({ token: tk, source: `env:${envKey}`, nickname: nick }); seen.add(tk); }
    }
  }

  // 2) tokens de ml_accounts
  for (const t of await listDbTokens()) {
    if (!seen.has(t.token)) { pool.push(t); seen.add(t.token); }
  }

  // 3) todos MELI_TOKEN_* do ambiente + owner
  for (const t of listEnvTokens()) {
    if (!seen.has(t.token)) { pool.push(t); seen.add(t.token); }
  }

  return { pool, guessedNick: nick || null };
}

// ================== HTTP ML ==================
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
async function mgetWithAnyToken(tokens, path, meta, tag) {
  let lastErr = null;
  for (const t of tokens) {
    try {
      meta.tried.push({ tag, tokenFrom: t.source });
      const data = await mget(t.token, path);
      return { data, tokenFrom: t.source };
    } catch (e) {
      lastErr = e;
      meta.errors.push({ where: `${tag} via ${t.source}`, message: e.message, status: e.status || null, payload: e.payload || null });
      // segue tentando com o próximo token
    }
  }
  if (lastErr) throw lastErr;
  throw new Error('no_token_available');
}

// melhoramos o nome do motivo para PT
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

// mapeia status/substatus do claim para um “log” amigável
function mapClaimToLog(status, substatus) {
  const s  = String(status   || '').toLowerCase();
  const ss = String(substatus|| '').toLowerCase();
  if (/prep|prepar|embaland/.test(ss))                 return 'em_preparacao';
  if (/ready|etiq|label|pronto/.test(ss))              return 'pronto_envio';
  if (/transit|transporte|enviado/.test(ss))           return 'em_transporte';
  if (/delivered|entreg|arrived|recebid/.test(ss))     return 'recebido_cd';
  if (s === 'closed')                                  return 'fechado';
  return null;
}

// soma itens do pedido quando o total dos itens não vier
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

// ===== NOVOS helpers =====
function pickFreightFromOrder(order) {
  if (!order) return null;
  const cands = [
    order?.shipping_cost,
    order?.total_shipping,
    order?.shipping?.cost?.amount,
    order?.shipping?.cost,
    order?.shipping?.shipping_option?.cost,
  ]
    .map(n => Number(n))
    .filter(n => Number.isFinite(n) && n > 0);
  return cands.length ? cands[0] : null;
}
function extractReasonName(claim) {
  if (!claim) return null;
  const rid   = claim?.reason_id || claim?.reason?.id || null;
  const rname = claim?.reason_name || claim?.reason?.name || claim?.reason?.description || null;
  const norm  = normalizeReason(rid, rname);
  claim.reason_name_normalized = norm || rname || rid || null;
  claim.reason_name            = rname || rid || norm || null;
  return claim.reason_name_normalized || claim.reason_name || null;
}

module.exports = function registerMlAmounts(app) {
  // GET /api/ml/returns/:id/fetch-amounts[?order_id=...&claim_id=...]
  app.get('/api/ml/returns/:id/fetch-amounts', async (req, res) => {
    const meta = { steps: [], errors: [], tried: [], tokenFrom: null, sellerNick: null };

    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID inválido' });

      const hasCols = await tableHasColumns('devolucoes', ['id_venda','order_id','claim_id','ml_claim_id','loja_nome']);
      const { rows } = await query('SELECT * FROM devolucoes WHERE id=$1', [id]);
      if (!rows.length) return res.status(404).json({ error: 'Devolução não encontrada' });
      const dev = rows[0];

      let orderId = String(req.query.order_id || '').trim();
      let claimId = String(req.query.claim_id || '').trim();
      if (!orderId) orderId = (hasCols.id_venda && dev.id_venda) || (hasCols.order_id && dev.order_id) || '';
      if (!claimId) claimId = (hasCols.claim_id && dev.claim_id) || (hasCols.ml_claim_id && dev.ml_claim_id) || '';

      // monta pool de tokens automáticamente
      const { pool, guessedNick } = await buildTokenPool(dev);
      meta.sellerNick = guessedNick || null;

      if (!pool.length) {
        return res.status(400).json({ error: 'Nenhum access token disponível (verifique ml_accounts ou variáveis MELI_TOKEN_*)', meta });
      }

      // ===== NOVO: tentar descobrir claim pelo order_id
      if (!notBlank(claimId) && notBlank(orderId)) {
        try {
          meta.steps.push({ op: 'GET /claims/search', orderId });
          const { data } = await mgetWithAnyToken(pool, `/post-purchase/v1/claims/search?order_id=${encodeURIComponent(orderId)}`, meta, 'claims-search');
          const list = Array.isArray(data?.results) ? data.results
                     : Array.isArray(data?.claims)  ? data.claims
                     : Array.isArray(data?.data)    ? data.data
                     : Array.isArray(data)          ? data
                     : [];
          const first = list[0] || null;
          claimId = first?.id || first?.claim_id || (typeof first === 'string' ? first : null) || '';
          if (claimId) meta.steps.push({ foundClaimId: claimId });
        } catch (e) {
          meta.errors.push({ where: 'claims-search', message: e.message, status: e.status || null, payload: e.payload || null });
        }
      }

      let order = null, claim = null;
      const amounts = {};

      // ---- ORDER (para valor produto e metadados)
      if (notBlank(orderId)) {
        meta.steps.push({ op: 'GET /orders', orderId });
        try {
          const { data, tokenFrom } = await mgetWithAnyToken(pool, `/orders/${encodeURIComponent(orderId)}`, meta, 'orders');
          meta.tokenFrom = tokenFrom;
          order = data;
          const prod = sumOrderProducts(order);
          if (prod != null) amounts.product = prod;
        } catch (e) {
          meta.errors.push({ where: 'orders(final)', message: e.message, status: e.status || null });
        }
      }

      // ---- CLAIM (para motivo, hint de log e custo de devolução)
      if (notBlank(claimId)) {
        meta.steps.push({ op: 'GET /claims', claimId });
        try {
          const { data, tokenFrom } = await mgetWithAnyToken(pool, `/post-purchase/v1/claims/${encodeURIComponent(claimId)}`, meta, 'claim');
          if (!meta.tokenFrom) meta.tokenFrom = tokenFrom;
          claim = {
            id: data?.id || claimId,
            status: data?.status || null,
            substatus: data?.substatus || null,
            reason_id: data?.reason_id || data?.reason?.id || null,
            reason_name: data?.reason_name || data?.reason?.name || data?.reason?.description || null
          };
          extractReasonName(claim);
        } catch (e) {
          meta.errors.push({ where: 'claim(final)', message: e.message, status: e.status || null });
        }

        // return cost (frete da devolução)
        try {
          meta.steps.push({ op: 'GET /claims/return-cost', claimId });
          const { data } = await mgetWithAnyToken(pool, `/post-purchase/v1/claims/${encodeURIComponent(claimId)}/charges/return-cost`, meta, 'return-cost');
          if (data && data.amount != null) amounts.freight = toNumber(data.amount);
        } catch (e) {
          meta.errors.push({ where: 'return-cost(final)', message: e.message, status: e.status || null });
        }
      }

      // ===== FRETE fallback pelo order
      if ((amounts.freight == null || amounts.freight === 0) && order) {
        const f = pickFreightFromOrder(order);
        if (f != null) amounts.freight = f;
      }

      if (!Object.keys(amounts).length && !order && !claim) {
        return res.status(404).json({ error: 'Sem dados para esta devolução', meta });
      }

      // sugestão de log (em_preparacao / em_transporte / recebido_cd …)
      const logHint = claim ? mapClaimToLog(claim.status, claim.substatus) : null;

      return res.json({
        ok: true,
        order_id: notBlank(orderId) ? orderId : null,
        claim_id: notBlank(claimId) ? claimId : null,
        amounts,
        order,
        claim,
        reason_name: (claim && (claim.reason_name_normalized || claim.reason_name)) || null,
        log_status_suggested: logHint,
        meta
      });
    } catch (e) {
      console.error('[ML AMOUNTS] erro geral:', e);
      return res.status(500).json({ error: 'Falha ao buscar valores', detail: e?.message || String(e) });
    }
  });
};
