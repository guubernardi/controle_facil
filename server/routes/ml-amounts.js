// server/routes/ml-amounts.js — amounts + motivo (label/key/code) + claim via order + frete fallback
'use strict';

const { query } = require('../db');

/* ======================= utils básicos ======================= */
function toNumber(x){ const n = Number(x); return Number.isFinite(n) ? n : 0; }
function notBlank(v){ return v !== null && v !== undefined && String(v).trim() !== ''; }

/** Verifica colunas existentes na tabela (evita quebras em bases antigas) */
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

/** tenta achar o nickname no "loja_nome" (ex.: "Mercado Livre · BUSCOU") */
function guessNickFromLoja(lojaNome) {
  if (!lojaNome) return null;
  const parts = String(lojaNome).split('·');
  const nick = (parts[parts.length - 1] || '').trim();
  return nick || null;
}

/* ======================= pool de tokens ======================= */
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

/* ======================= HTTP ML ======================= */
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
      // tenta próximo token
    }
  }
  if (lastErr) throw lastErr;
  throw new Error('no_token_available');
}

/* ======================= Motivo (server side) ======================= */
function isReasonCode(v){ return /^[A-Z]{2,}\d{3,}$/i.test(String(v||'').trim()); }

const CODE_TO_LABEL = {
  PDD9939: 'Pedido incorreto',
  PDD9904: 'Produto com defeito',
  PDD9905: 'Avaria no transporte',
  PDD9906: 'Cliente: arrependimento',
  PDD9907: 'Cliente: endereço errado',
  PDD9944: 'Defeito de produção',
};
function labelFromCode(code){
  const k = String(code||'').toUpperCase();
  return CODE_TO_LABEL[k] || null;
}
function stripAcc(s){ try { return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,''); } catch(_) { return String(s||''); } }
function norm(s){ return stripAcc(String(s||'').toLowerCase()); }

function labelFromKey(key){
  switch(String(key||'').toLowerCase()){
    // cliente
    case 'cliente_arrependimento':
    case 'buyer_remorse':
    case 'changed_mind':
    case 'doesnt_fit':
    case 'size_issue':
      return 'Cliente: arrependimento';
    case 'cliente_endereco_errado':
    case 'wrong_address_buyer':
    case 'recipient_absent':
    case 'absent_receiver':
    case 'didnt_pickup':
      return 'Cliente: endereço errado';
    // produto
    case 'produto_defeito':
    case 'product_defective':
    case 'broken':
    case 'damaged':
    case 'incomplete':
    case 'missing_parts':
    case 'quality_issue':
      return 'Produto com defeito';
    // transporte
    case 'avaria_transporte':
    case 'damaged_in_transit':
    case 'shipping_damage':
    case 'carrier_damage':
      return 'Avaria no transporte';
    // pedido errado
    case 'pedido_incorreto':
    case 'wrong_item':
    case 'different_from_publication':
    case 'not_as_described':
    case 'mixed_order':
      return 'Pedido incorreto';
    default: return null;
  }
}

function labelFromText(text){
  const t = norm(text||'');
  if (!t) return null;
  // cliente
  if (/(arrepend|desist|nao serv|não serv|mudou de ideia|tamanho|size|color|cor|didn t like|changed mind|buyer remorse)/.test(t)) return 'Cliente: arrependimento';
  if (/(endereco|endereço|address|ausenc|receptor|recipient absent|absent receiver|wrong address|didn t pick up|pickup)/.test(t)) return 'Cliente: endereço errado';
  // produto
  if (/(defeit|avari|quebrad|danific|faltand|incomplet|missing|broken|damaged|defective|quality)/.test(t)) return 'Produto com defeito';
  // transporte
  if (/(transporte|logistic|logistica|shipping damage|carrier damage|in transit)/.test(t)) return 'Avaria no transporte';
  // pedido errado
  if (/(pedido incorret|produto errad|item errad|sku incorret|wrong item|different from|not as described|mixed order)/.test(t)) return 'Pedido incorreto';
  return null;
}

/** Extrai melhor rótulo do “root” (aceita claim / claims[0] / reason_* soltos) */
function deriveReason(root){
  if (!root || typeof root !== 'object') return { code:null, key:null, text:null, label:null };

  const bag = { codes:[], keys:[], texts:[] };
  const push = (arr, v) => { if (v!==undefined && v!==null && String(v).trim()!=='') arr.push(v); };

  // Top-level
  push(bag.codes, root.reason_code || root.reason_id || root.substatus || root.sub_status || root.code || root.tipo_reclamacao);
  push(bag.keys,  root.reason_key);
  push(bag.texts, root.reason_name || root.reason_description || root.reason);

  // Nested 'reason'
  if (root.reason && typeof root.reason === 'object') {
    push(bag.codes, root.reason.code || root.reason.id);
    push(bag.keys,  root.reason.key);
    push(bag.texts, root.reason.name || root.reason.description);
  }

  // claim / claims[0]
  const claim = root.claim || root.ml_claim || null;
  const claims = Array.isArray(root.claims) ? root.claims : [];
  const c0 = claims[0] || {};
  const claimBlock = [claim, c0].filter(Boolean);
  for (const c of claimBlock) {
    push(bag.codes, c.reason_code || c.reason_id || c.substatus || c.sub_reason_code);
    push(bag.keys,  c.reason_key || (c.reason && c.reason.key));
    if (c.reason && typeof c.reason === 'object') {
      push(bag.codes, c.reason.code || c.reason.id);
      push(bag.keys,  c.reason.key);
      push(bag.texts, c.reason.name || c.reason.description);
    }
    push(bag.texts, c.reason_name);
  }

  // return/details/meta
  if (root.return && typeof root.return === 'object') {
    push(bag.texts, root.return.reason || root.return.reason_name || root.return.reason_description);
  }
  if (root.details && typeof root.details === 'object') {
    push(bag.keys,  root.details.reason_key);
    push(bag.texts, root.details.reason || root.details.reason_name);
  }
  if (root.meta && typeof root.meta === 'object') {
    push(bag.texts, root.meta.reason || root.meta.reason_name);
  }

  // Decide na ordem: código -> key -> texto
  for (const code of bag.codes) {
    if (code && isReasonCode(code)) {
      const lbl = labelFromCode(code);
      if (lbl) return { code, key:null, text:null, label:lbl };
    }
  }
  for (const key of bag.keys) {
    if (!key) continue;
    const lbl = labelFromKey(key);
    if (lbl) return { code:null, key, text:null, label:lbl };
  }
  for (const txt of bag.texts) {
    if (!txt) continue;
    const lbl = labelFromText(txt) || String(txt);
    if (lbl) return { code:null, key:null, text:txt, label:lbl };
  }
  return { code:null, key:null, text:null, label:null };
}

/* ========== helpers de pedido/frete e claim extras ========== */
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

// Preenche campos derivados do motivo e retorna o melhor nome
function extractReasonFields(claim) {
  if (!claim) return null;
  const rid   = claim?.reason_id || claim?.reason?.id || null;
  const rname = claim?.reason_name || claim?.reason?.name || claim?.reason?.description || null;

  claim.reason_name = rname || rid || null;

  // prioridade: se vier do ML, usa; senão deriva do texto
  const providedKey  = claim?.reason_key || (claim?.reason && claim.reason.key) || null;
  claim.reason_key   = providedKey || null; // (label final será oferecido por reason_label)

  return claim.reason_name || claim.reason_key || claim.reason_id || null;
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

/* ======================= rota ======================= */
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

      // tentar descobrir claim pelo order_id
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

      // ORDER (produto e metadados)
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

      // CLAIM (motivo, hint e custo de devolução)
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
            reason_name: data?.reason_name || data?.reason?.name || data?.reason?.description || null,
            reason_key: data?.reason_key || data?.reason?.key || null
          };
          extractReasonFields(claim);
        } catch (e) {
          meta.errors.push({ where: 'claim(final)', message: e.message, status: e.status || null });
        }

        // return cost (frete da devolução)
        try {
          meta.steps.push({ op: 'GET /claims/return-cost', claimId });
          const { data } = await mgetWithAnyToken(pool, `/post-purchase/v1/claims/${encodeURIComponent(claimId)}/charges/return-cost`, meta, 'return-cost');
          const cand = [
            data?.amount,
            data?.value,
            data?.total,
            data?.charge?.amount,
            data?.amount?.amount
          ].map(n => Number(n)).find(n => Number.isFinite(n) && n >= 0);
          if (Number.isFinite(cand)) amounts.freight = cand;
        } catch (e) {
          meta.errors.push({ where: 'return-cost(final)', message: e.message, status: e.status || null });
        }
      }

      // FRETE fallback pelo order
      if ((amounts.freight == null || amounts.freight === 0) && order) {
        const f = pickFreightFromOrder(order);
        if (f != null) amounts.freight = f;
      }

      if (!Object.keys(amounts).length && !order && !claim) {
        return res.status(404).json({ error: 'Sem dados para esta devolução', meta });
      }

      // sugestão de log (pré/transporte/recebido)
      const logHint = claim ? mapClaimToLog(claim.status, claim.substatus) : null;

      // ----- Motivo (label + code/key/text) pronto pro front -----
      const reasonObj = deriveReason({ claim });

      return res.json({
        ok: true,
        order_id: notBlank(orderId) ? orderId : null,
        claim_id: notBlank(claimId) ? claimId : null,
        amounts,
        order,
        claim,
        // aliases amigáveis para o front:
        reason_label: reasonObj.label || null,                               // <- rótulo humano: "Cliente: arrependimento"
        reason_code:  (reasonObj.code  ?? claim?.reason_id) || null,         // ex.: PDD9939
        reason_key:   (reasonObj.key   ?? claim?.reason_key) || null,        // chave canônica (quando houver)
        reason_text:  (reasonObj.text  ?? claim?.reason_name) || null,       // texto cru (fallback)
        log_status_suggested: logHint,
        meta
      });
    } catch (e) {
      console.error('[ML AMOUNTS] erro geral:', e);
      return res.status(500).json({ error: 'Falha ao buscar valores', detail: e?.message || String(e) });
    }
  });
};
