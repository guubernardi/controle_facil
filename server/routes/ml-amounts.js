// server/routes/ml-amounts.js
'use strict';

const { query } = require('../db');

/* ----------------- Helpers ----------------- */
function toNumber(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }
function notBlank(v) { return v !== null && v !== undefined && String(v).trim() !== ''; }

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

/** Normaliza pedaços de string para formar nomes de variáveis de ambiente */
function normalizeKeyPart(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/[^A-Za-z0-9]+/g, '_')                  // espaços e pontuações -> _
    .replace(/^_+|_+$/g, '')                         // trim _
    .toUpperCase();
}

/** "Mercado Livre · BUSCOU PNEUS" -> "BUSCOU PNEUS" */
function guessNickFromLoja(lojaNome) {
  if (!lojaNome) return null;
  const s = String(lojaNome).trim();
  const parts = s.split('·');
  // pega o último segmento após "·", senão a string toda
  const raw = (parts[parts.length - 1] || s).trim();
  return raw || null;
}

/** Seleciona o token correto para a devolução/loja */
async function getTokenForReturn(dev, nickHint) {
  // prioridade: parâmetro enviado, depois loja_nome
  const nickRaw = (nickHint && String(nickHint).trim()) || guessNickFromLoja(dev?.loja_nome) || dev?.loja_nome || '';

  // candidatos de ENV: MELI_TOKEN_BUSCOU_PNEUS, MELI_TOKEN_BUSCOUPNEUS, MELI_TOKEN_BUSCOU
  const full      = normalizeKeyPart(nickRaw);                    // BUSCOU_PNEUS
  const compact   = normalizeKeyPart(String(nickRaw).replace(/\s+/g, '')); // BUSCOUPNEUS
  const firstWord = normalizeKeyPart(String(nickRaw).split(/\s+/)[0]);     // BUSCOU

  const envCandidates = [
    `MELI_TOKEN_${full}`,
    `MELI_TOKEN_${compact}`,
    `MELI_TOKEN_${firstWord}`,
  ];

  for (const k of envCandidates) {
    if (process.env[k]) {
      return { token: process.env[k], tokenFrom: `env:${k}`, sellerNick: nickRaw };
    }
  }

  // tenta tabela ml_accounts por nickname (case-insensitive)
  try {
    const { rows } = await query(
      `SELECT access_token
         FROM ml_accounts
        WHERE LOWER(nickname) = LOWER($1)
           OR LOWER(REPLACE(nickname,' ','')) = LOWER(REPLACE($1,' ',''))
        LIMIT 1`,
      [nickRaw]
    );
    if (rows[0]?.access_token) {
      return { token: rows[0].access_token, tokenFrom: 'db:ml_accounts.nickname', sellerNick: nickRaw };
    }
  } catch (_) { /* silencioso */ }

  // fallback global (último recurso)
  const fallback = process.env.MELI_OWNER_TOKEN || process.env.ML_ACCESS_TOKEN || null;
  return { token: fallback, tokenFrom: 'env:MELI_OWNER_TOKEN', sellerNick: nickRaw || null };
}

/* --------------- Rota --------------- */
/**
 * GET /api/ml/returns/:id/fetch-amounts
 * Aceita hints:
 *   ?order_id=...       (força order)
 *   ?claim_id=...       (força claim)
 *   ?store=... | ?nick=... | ?seller=... (força nick para escolher o token)
 */
module.exports = function registerMlAmounts(app) {
  app.get('/api/ml/returns/:id/fetch-amounts', async (req, res) => {
    const meta = { steps: [], errors: [], tokenFrom: null, sellerNick: null };

    const pushErr = (where, err) => {
      const info = {
        where,
        message: err?.message || String(err),
        status: err?.status || null,
        payload: err?.payload || null
      };
      meta.errors.push(info);
      console.error('[ML AMOUNTS]', where, info);
    };

    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID inválido' });

      // carrega devolução para obter loja/apelido
      const hasCols = await tableHasColumns('devolucoes', ['id_venda','order_id','claim_id','ml_claim_id','loja_nome']);
      const { rows: devRows } = await query('SELECT * FROM devolucoes WHERE id=$1', [id]);
      if (!devRows.length) return res.status(404).json({ error: 'Devolução não encontrada' });
      const dev = devRows[0];

      // prioriza ids da querystring
      let orderId = (req.query.order_id || '').trim();
      let claimId = (req.query.claim_id || '').trim();
      if (!orderId) orderId = (hasCols.id_venda && dev.id_venda) || (hasCols.order_id && dev.order_id) || '';
      if (!claimId) claimId = (hasCols.claim_id && dev.claim_id) || (hasCols.ml_claim_id && dev.ml_claim_id) || '';

      // escolha do token (aceita ?store= / ?nick= / ?seller= como hint)
      const nickHint = req.query.store || req.query.nick || req.query.seller || null;
      const { token, tokenFrom, sellerNick } = await getTokenForReturn(dev, nickHint);
      meta.tokenFrom  = tokenFrom;
      meta.sellerNick = sellerNick;

      if (!token) {
        return res.status(400).json({ error: 'Access token ausente para esta loja', meta });
      }

      const base = 'https://api.mercadolibre.com';
      const mget = async (path) => {
        const r = await fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
        let j = {};
        try { j = await r.json(); } catch (_) {}
        if (!r.ok) {
          const e = new Error(`${r.status} ${j?.message || j?.error || r.statusText}`);
          e.status = r.status;
          e.payload = j;
          throw e;
        }
        return j;
      };

      /* ----- ORDER -> valor do produto ----- */
      let orderInfo = null;
      let productAmount = null;

      if (notBlank(orderId)) {
        try {
          meta.steps.push({ op: 'GET /orders', orderId });
          const o = await mget(`/orders/${encodeURIComponent(orderId)}`);
          orderInfo = o;

          const items = Array.isArray(o?.order_items) ? o.order_items : (Array.isArray(o?.items) ? o.items : []);
          let sum = 0;
          for (const it of items) {
            const unit = toNumber(it?.unit_price ?? it?.sale_price ?? it?.price);
            const qty  = toNumber(it?.quantity ?? 1);
            sum += unit * (qty || 1);
          }
          productAmount = sum > 0 ? sum : null;
        } catch (e) {
          pushErr('orders', e);
        }
      }

      /* ----- CLAIM -> custo de devolução (frete) ----- */
      let returnCost = null;
      if (notBlank(claimId)) {
        try {
          meta.steps.push({ op: 'GET /claims/return-cost', claimId });
          const rc = await mget(`/post-purchase/v1/claims/${encodeURIComponent(claimId)}/charges/return-cost`);
          if (rc && rc.amount != null) returnCost = toNumber(rc.amount);
        } catch (e) {
          pushErr('return-cost', e);
        }
      }

      // Se absolutamente nada veio e houve erro de auth, responde 404 sem dados (tratamento leve no front)
      if (productAmount == null && returnCost == null && meta.errors.length && !orderInfo) {
        return res.status(404).json({ error: 'Sem dados para esta devolução', meta });
      }

      return res.json({
        ok: true,
        order_id: notBlank(orderId) ? String(orderId) : null,
        claim_id: notBlank(claimId) ? String(claimId) : null,
        amounts: { product: productAmount, freight: returnCost },
        order: orderInfo || null,
        return_cost: returnCost != null ? { amount: returnCost } : null,
        meta
      });
    } catch (e) {
      console.error('[ML AMOUNTS] erro geral:', e);
      return res.status(500).json({
        error: 'Falha ao buscar valores',
        detail: e?.message || String(e),
        status: e?.status || null,
        payload: e?.payload || null
      });
    }
  });
};
