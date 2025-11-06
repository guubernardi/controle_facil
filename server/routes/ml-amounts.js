// server/routes/ml-amounts.js
// amounts + claim + frete + reason_label + preferência por seller_nick
// + proxy de reasons (para o front descobrir motivo por ID)
// + endpoint /enrich (no-op com log opcional)
// ----------------------------------------------------------------------------
'use strict';

const { query } = require('../db');

// ===== Utils básicos ========================================================
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

// ===== Pool de tokens (ENV + DB) ============================================
async function listDbTokens() {
  try {
    const { rows } = await query(
      `SELECT COALESCE(nickname,'') AS nickname, access_token
         FROM ml_accounts
        WHERE access_token IS NOT NULL AND access_token <> ''`
    );
    if (rows.length) {
      return rows.map(r => ({
        token: r.access_token,
        source: r.nickname ? `db:ml_accounts.nickname(${r.nickname})` : 'db:ml_accounts',
        nickname: r.nickname || null
      }));
    }
  } catch {}
  // fallback: ml_tokens (sem nickname)
  try {
    const { rows } = await query(
      `SELECT user_id, access_token
         FROM ml_tokens
        WHERE access_token IS NOT NULL AND access_token <> ''
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 5`
    );
    return rows.map(r => ({
      token: r.access_token,
      source: `db:ml_tokens(user_id:${r.user_id})`,
      nickname: null
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

  // 2) tokens de ml_accounts (ou fallback ml_tokens)
  for (const t of await listDbTokens()) {
    if (!seen.has(t.token)) { pool.push(t); seen.add(t.token); }
  }

  // 3) todos MELI_TOKEN_* do ambiente + owner
  for (const t of listEnvTokens()) {
    if (!seen.has(t.token)) { pool.push(t); seen.add(t.token); }
  }

  return { pool, guessedNick: nick || null };
}

// Reordena pool dando prioridade a um seller_nick específico
function preferNick(pool, sellerNick) {
  if (!sellerNick) return pool;
  const wanted = String(sellerNick).toLowerCase().trim();
  const a = [], b = [];
  for (const t of pool) {
    const nick = (t.nickname || '').toLowerCase().trim();
    (nick === wanted || nick.includes(wanted)) ? a.push(t) : b.push(t);
  }
  return [...a, ...b];
}

// ===== HTTP ML com fallback e timeout =======================================
async function mget(token, path, { timeout = 12000 } = {}) {
  const base = 'https://api.mercadolibre.com';
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(base + path, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      },
      signal: ctrl.signal
    });
    const ct = r.headers.get('content-type') || '';
    const body = ct.includes('application/json')
      ? await r.json().catch(() => null)
      : await r.text().catch(() => '');

    if (!r.ok) {
      const e = new Error(`${r.status} ${(body && (body.message || body.error)) || r.statusText}`);
      e.status = r.status;
      e.payload = body;
      throw e;
    }
    return body;
  } finally {
    clearTimeout(to);
  }
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
    }
  }
  if (lastErr) throw lastErr;
  throw new Error('no_token_available');
}

// ===== Motivo (normalização e label humano) =================================
const CODE_TO_LABEL = {
  'PDD9939': 'Pedido incorreto',
  'PDD9904': 'Produto com defeito',
  'PDD9905': 'Avaria no transporte',
  'PDD9906': 'Cliente: arrependimento',
  'PDD9907': 'Cliente: endereço errado',
  'PDD9944': 'Defeito de produção'
};
function labelFromCode(code){
  const k = String(code || '').toUpperCase();
  return CODE_TO_LABEL[k] || null;
}
function normalizeKey(s='') {
  try {
    return String(s).normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase();
  } catch {
    return String(s).toLowerCase();
  }
}
function labelFromReasonKey(key){
  const k = String(key||'').toLowerCase();
  // cliente
  if (['cliente_arrependimento','buyer_remorse','changed_mind','doesnt_fit','size_issue'].includes(k))
    return 'Cliente: arrependimento';
  if (['cliente_endereco_errado','wrong_address_buyer','recipient_absent','absent_receiver','didnt_pickup'].includes(k))
    return 'Cliente: endereço errado';
  // produto
  if (['produto_defeito','product_defective','broken','damaged','incomplete','missing_parts','quality_issue'].includes(k))
    return 'Produto com defeito';
  // transporte
  if (['avaria_transporte','damaged_in_transit','shipping_damage','carrier_damage'].includes(k))
    return 'Avaria no transporte';
  // pedido incorreto / não corresponde
  if ([
    'pedido_incorreto','wrong_item','different_from_publication','not_as_described','mixed_order',
    'different_product','different_variant','different_color','wrong_color','color_mismatch','variant_mismatch'
  ].includes(k))
    return 'Pedido incorreto';
  return null;
}
function labelFromReasonName(name='') {
  const s = normalizeKey(name);
  const has = (kw)=> s.includes(kw);
  if (has('arrepend') || has('tamanho') || has('size') || has('changed mind') || has('didn t like'))
    return 'Cliente: arrependimento';
  if (has('endereco errado') || has('endereco incorreto') || has('ausencia') || has('destinatario ausente') || has('wrong address') || has('absent'))
    return 'Cliente: endereço errado';
  if (has('defeit') || has('avari') || has('danific') || has('quebrad') || has('faltando') || has('incomplet') || has('missing') || has('broken') || has('damaged'))
    return 'Produto com defeito';
  if (has('transporte') || has('shipping damage') || has('carrier damage'))
    return 'Avaria no transporte';

  // Não corresponde / produto ou cor diferente / errado / trocado
  if (
    has('pedido incorreto') || has('produto errado') || has('wrong item') || has('not as described') ||
    has('produto diferente') || has('modelo diferente') || has('tamanho diferente') ||
    has('cor diferente') || has('produto ou cor diferente') || has('produto trocado')
  )
    return 'Pedido incorreto';

  return null;
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
    const unit = toNumber(
      it?.unit_price ?? it?.full_unit_price ?? it?.sale_price ?? it?.price
    );
    const qty  = toNumber(it?.quantity ?? 1);
    sum += unit * (qty || 1);
  }
  return sum > 0 ? sum : null;
};

// ===== helpers extras =======================================================
function pickFreightFromOrder(order) {
  if (!order) return null;
  const cands = [
    order?.shipping_cost,
    order?.total_shipping,
    order?.shipping?.cost?.amount,
    order?.shipping?.cost,
    order?.shipping?.shipping_option?.cost,
    order?.shipping?.shipping_option?.list_cost,
    order?.shipping?.shipping_option?.base_cost,
  ]
    .map(n => Number(n))
    .filter(n => Number.isFinite(n) && n > 0);
  return cands.length ? cands[0] : null;
}

// Preenche campos derivados e devolve reason_label
function computeReasonExtras(claim) {
  if (!claim) return { reason_label: null };
  const reasonId   = claim?.reason_id || claim?.reason?.id || null;
  const reasonName = claim?.reason_name || claim?.reason?.name || claim?.reason?.description || null;
  const reasonKey  = claim?.reason_key || claim?.reason?.key || null;

  let reason_label =
    (reasonKey  && labelFromReasonKey(reasonKey)) ||
    (reasonId   && labelFromCode(reasonId)) ||
    (reasonName && labelFromReasonName(reasonName)) ||
    null;

  return { reason_label };
}

// ===== Rotas ================================================================
module.exports = function registerMlAmounts(app) {
  // GET /api/ml/returns/:id/fetch-amounts[?order_id=...&claim_id=...&seller_nick=...]
  app.get('/api/ml/returns/:id/fetch-amounts', async (req, res) => {
    const meta = { steps: [], errors: [], tried: [], tokenFrom: null, sellerNick: null, preferredNick: null };

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

      // monta pool de tokens automáticamente e prioriza seller_nick (se vier na query)
      const { pool: basePool, guessedNick } = await buildTokenPool(dev);
      const sellerNick = String(req.query.seller_nick || '').trim() || guessedNick || null;
      const pool = preferNick(basePool, sellerNick);
      meta.sellerNick = guessedNick || null;
      meta.preferredNick = sellerNick;

      if (!pool.length) {
        return res.status(400).json({ error: 'Nenhum access token disponível (verifique ml_accounts/ml_tokens ou variáveis MELI_TOKEN_*)', meta });
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

      // reason_label calculado no servidor
      const { reason_label } = computeReasonExtras(claim);

      return res.json({
        ok: true,
        order_id: notBlank(orderId) ? orderId : null,
        claim_id: notBlank(claimId) ? claimId : null,
        amounts,
        order,
        claim,
        // aliases amigáveis + label humano
        reason_code: (claim && claim.reason_id) || null, // ex.: PDD9939
        reason_name: (claim && claim.reason_name) || null,
        reason_key:  (claim && claim.reason_key) || null, // chave canônica
        reason_label,                                     // ex.: "Pedido incorreto"
        log_status_suggested: logHint,
        meta
      });
    } catch (e) {
      console.error('[ML AMOUNTS] erro geral:', e);
      return res.status(500).json({ error: 'Falha ao buscar valores', detail: e?.message || String(e) });
    }
  });

  // === Proxy de REASONS para o front descobrir o canônico por ID =============
  // O front tenta: /api/ml/claims/reasons/:id, /api/ml/reasons/:id, /api/ml/claim-reasons/:id
  async function proxyReasonById(req, res) {
    const meta = { steps: [], errors: [], tried: [] };
    try {
      const rid = String(req.params.id || '').trim();
      if (!rid) return res.status(400).json({ error: 'reason_id ausente' });

      // escolhe qualquer devolução para montar pool (ou faz um pool "global")
      let dev = { loja_nome: null };
      try {
        const { rows } = await query('SELECT loja_nome FROM devolucoes ORDER BY id DESC LIMIT 1');
        if (rows.length) dev = rows[0];
      } catch {}

      const { pool } = await buildTokenPool(dev);
      if (!pool.length) return res.status(400).json({ error: 'Nenhum token disponível' });

      const idEnc = encodeURIComponent(rid);
      const candidates = [
        `/post-purchase/v1/claims/reasons/${idEnc}`,
        `/post-purchase/v1/reasons/${idEnc}`,
        `/claims/reasons/${idEnc}`
      ];

      let lastErr = null;
      for (const p of candidates) {
        try {
          meta.steps.push({ try: p });
          const { data } = await mgetWithAnyToken(pool, p, meta, 'reasons');
          return res.json({ ok: true, data, meta });
        } catch (e) {
          lastErr = e;
          meta.errors.push({ where: p, message: e.message, status: e.status || null, payload: e.payload || null });
        }
      }
      if (lastErr) return res.status(lastErr.status || 404).json({ error: 'reason não encontrado', meta });
      return res.status(404).json({ error: 'reason não encontrado', meta });
    } catch (e) {
      return res.status(500).json({ error: 'Falha ao consultar reason', detail: e?.message || String(e), meta });
    }
  }
  app.get('/api/ml/claims/reasons/:id', proxyReasonById);
  app.get('/api/ml/reasons/:id', proxyReasonById);
  app.get('/api/ml/claim-reasons/:id', proxyReasonById);

  // === Endpoint “enrich” (no-op com log opcional) ============================
  app.post('/api/ml/returns/:id/enrich', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID inválido' });

      // se existir tabela de eventos, registra um log simples; senão, 204
      const hasDevEv = await tableHasColumns('devolucoes_events', ['devolucao_id','type','title','message','meta']);
      if (hasDevEv.devolucao_id) {
        const metaObj = { source: 'ml-enrich', at: new Date().toISOString() };
        await query(
          `INSERT INTO devolucoes_events (devolucao_id, type, title, message, meta)
           VALUES ($1,$2,$3,$4,$5::jsonb)`,
          [id, 'status', 'Enriquecimento ML', 'Amounts/claim atualizados via ML', JSON.stringify(metaObj)]
        );
        return res.status(201).json({ ok: true });
      }
      return res.status(204).end();
    } catch (e) {
      return res.status(200).json({ ok: true }); // não falha o fluxo do front
    }
  });
};
