// server/routes/ml-amounts.js
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

// tenta achar o nickname no "loja_nome" (ex.: "Mercado Livre · BUSCOU")
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

// melhoramos o nome do motivo para português que “bate” com suas regras do dashboard
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

module.exports = function registerMlAmounts(app) {
  // GET /api/ml/returns/:id/fetch-amounts[?order_id=...&claim_id=...]
  app.get('/api/ml/returns/:id/fetch-amounts', async (req, res) => {
    const meta = { steps: [], errors: [], tokenFrom: null, sellerNick: null };

    const fail = (where, err) => {
      meta.errors.push({ where, message: err?.message || String(err), status: err?.status || null, payload: err?.payload || null });
      console.warn('[ML AMOUNTS]', where, err?.message || err);
    };

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

      const { token, tokenFrom, sellerNick } = await getTokenForReturn(dev);
      meta.tokenFrom = tokenFrom; meta.sellerNick = sellerNick;
      if (!token) return res.status(400).json({ error: 'Access token ausente para esta loja', meta });

      let order = null, claim = null;
      const amounts = {};

      if (notBlank(orderId)) {
        try {
          meta.steps.push({ op: 'GET /orders', orderId });
          order = await mget(token, `/orders/${encodeURIComponent(orderId)}`);
          const prod = sumOrderProducts(order);
          if (prod != null) amounts.product = prod;
        } catch (e) { fail('orders', e); }
      }

      if (notBlank(claimId)) {
        try {
          meta.steps.push({ op: 'GET /claims', claimId });
          const c = await mget(token, `/post-purchase/v1/claims/${encodeURIComponent(claimId)}`);
          // Estruturas possíveis de reason variam por conta; cobrimos alguns formatos
          const rid   = c?.reason_id || c?.reason?.id || null;
          const rname = c?.reason_name || c?.reason?.name || c?.reason?.description || null;
          claim = {
            id: c?.id || claimId,
            status: c?.status || null,
            substatus: c?.substatus || null,
            reason_id: rid || null,
            reason_name: rname || null,
            reason_name_normalized: normalizeReason(rid, rname)
          };
        } catch (e) { fail('claim', e); }

        try {
          meta.steps.push({ op: 'GET /claims/return-cost', claimId });
          const rc = await mget(token, `/post-purchase/v1/claims/${encodeURIComponent(claimId)}/charges/return-cost`);
          if (rc && rc.amount != null) amounts.freight = toNumber(rc.amount);
        } catch (e) { fail('return-cost', e); }
      }

      if (!Object.keys(amounts).length && !order && !claim) {
        return res.status(404).json({ error: 'Sem dados para esta devolução' });
      }

      return res.json({
        ok: true,
        order_id: notBlank(orderId) ? orderId : null,
        claim_id: notBlank(claimId) ? claimId : null,
        amounts,
        order,
        claim,
        reason_name: claim?.reason_name || claim?.reason_name_normalized || null,
        meta
      });
    } catch (e) {
      console.error('[ML AMOUNTS] erro geral:', e);
      return res.status(500).json({ error: 'Falha ao buscar valores', detail: e?.message || String(e) });
    }
  });
};
