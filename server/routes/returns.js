// server/routes/ml-returns.js
'use strict';

const { query } = require('../db');

// ---- fetch helper (Node 18+ tem fetch nativo; senão cai no node-fetch) ----
const _fetch = (typeof fetch === 'function')
  ? fetch
  : (...a) => import('node-fetch').then(({ default: f }) => f(...a));

// ---- token helper ----
async function getMLToken(req) {
  if (req?.user?.ml?.access_token) return req.user.ml.access_token;
  if (process.env.ML_ACCESS_TOKEN) return process.env.ML_ACCESS_TOKEN;
  try {
    const { rows } = await query(
      `SELECT access_token
         FROM ml_tokens
        WHERE is_active IS TRUE
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 1`
    );
    return rows[0]?.access_token || null;
  } catch { return null; }
}

// ---- chamada genérica à API do ML ----
async function mlFetch(path, token, opts = {}) {
  const url = `https://api.mercadolibre.com${path}`;
  const r = await _fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) }
  });
  let j = null; try { j = await r.json(); } catch {}
  if (!r.ok) {
    const msg = (j && (j.message || j.error))
      ? `${j.error || ''} ${j.message || ''}`.trim()
      : `ML HTTP ${r.status}`;
    const err = new Error(msg); err.status = r.status; err.payload = j; throw err;
  }
  return j;
}

function bad(res, code, msg, extra) {
  return res.status(code).json({ error: msg, ...(extra || {}) });
}

/* ========================= Helpers de compatibilidade ========================= */

function coerceArr(j){
  if (Array.isArray(j)) return j;
  if (!j || typeof j !== 'object') return [];
  return j.results || j.items || j.data || j.returns || j.list || [];
}

function buildClaimsSearchURL({ sellerId, statuses, fromISO, limit=50, offset=0, role='seller' }) {
  const url = new URL('https://api.mercadolibre.com/post-purchase/v1/claims/search');
  if (sellerId) url.searchParams.set('seller', sellerId);
  if (statuses) url.searchParams.set('status', statuses);
  if (fromISO)  url.searchParams.set('date_created_from', fromISO);
  if (role)     url.searchParams.set('role', role);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('order', 'date_desc');
  return url;
}

async function mlPaged(url, token, wantAll) {
  const out = [];
  while (true) {
    const r  = await _fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` }});
    const j  = await r.json().catch(()=>({}));
    if (r.status === 401) throw Object.assign(new Error('ml_unauthorized'), { status: 401, payload: j });
    if (r.status === 403) throw Object.assign(new Error('ml_forbidden'),    { status: 403, payload: j });
    if (!r.ok)            throw Object.assign(new Error('ml_error'),        { status: r.status, payload: j });

    const arr = coerceArr(j);
    out.push(...arr);

    const { total = out.length, offset = 0, limit = 50 } = j.paging || {};
    if (!wantAll || (Number(offset) + Number(limit) >= Number(total))) break;

    const next = (Number(offset) || 0) + (Number(limit) || 50);
    url.searchParams.set('offset', String(next));
  }
  return out;
}

async function searchClaims(token, { sellerId, statuses, fromISO, limit=50, offset=0, all=false }) {
  const url = buildClaimsSearchURL({ sellerId, statuses, fromISO, limit, offset, role: 'seller' });
  return mlPaged(url, token, all);
}

async function returnsForClaimIds(token, claimIds) {
  const items = [];
  for (const id of claimIds) {
    try {
      const ret = await mlFetch(`/post-purchase/v2/claims/${encodeURIComponent(id)}/returns`, token);
      items.push({ claim_id: id, return: ret });
    } catch (e) {
      // Sem retorno associado ou erro de upstream — mantém no payload para debug
      items.push({ claim_id: id, error: true, status: e.status, upstream: e.payload });
    }
  }
  return items;
}

/* ========================= Rotas ========================= */

module.exports = function registerMlReturns(app) {
  /* ---- NOVAS ROTAS OFICIAIS ---- */

  // Devolução a partir do claim_id
  app.get('/api/ml/claims/:claim_id/returns', async (req, res) => {
    try {
      const token = await getMLToken(req);
      if (!token) return bad(res, 501, 'Token do ML ausente (defina ML_ACCESS_TOKEN ou configure integração).');
      const claimId = String(req.params.claim_id).trim();
      const data = await mlFetch(`/post-purchase/v2/claims/${encodeURIComponent(claimId)}/returns`, token);
      res.json(data);
    } catch (e) {
      res.status(e.status || 502).json({ error: 'Falha ao consultar returns por claim', detail: e.message, upstream: e.payload });
    }
  });

  // Reviews de uma devolução
  app.get('/api/ml/returns/:return_id/reviews', async (req, res) => {
    try {
      const token = await getMLToken(req);
      if (!token) return bad(res, 501, 'Token do ML ausente.');
      const returnId = String(req.params.return_id).trim();
      const data = await mlFetch(`/post-purchase/v1/returns/${encodeURIComponent(returnId)}/reviews`, token);
      res.json(data);
    } catch (e) {
      res.status(e.status || 502).json({ error: 'Falha ao consultar reviews da devolução', detail: e.message, upstream: e.payload });
    }
  });

  // Reasons (flow=seller_return_failed)
  app.get('/api/ml/returns/reasons', async (req, res) => {
    try {
      const token = await getMLToken(req);
      if (!token) return bad(res, 501, 'Token do ML ausente.');
      const flow = req.query.flow || 'seller_return_failed';
      const claimId = req.query.claim_id;
      if (!claimId) return bad(res, 400, 'Parâmetro claim_id é obrigatório.');
      const q = new URLSearchParams({ flow, claim_id: String(claimId) }).toString();
      const data = await mlFetch(`/post-purchase/v1/returns/reasons?${q}`, token);
      res.json(data);
    } catch (e) {
      res.status(e.status || 502).json({ error: 'Falha ao obter reasons', detail: e.message, upstream: e.payload });
    }
  });

  // Upload de evidência (front envia base64)
  // Body: { file_base64: "<sem prefixo data:>", filename?: "img.png", content_type?: "image/png" }
  app.post('/api/ml/claims/:claim_id/returns/attachments', async (req, res) => {
    try {
      const token = await getMLToken(req);
      if (!token) return bad(res, 501, 'Token do ML ausente.');
      const claimId = String(req.params.claim_id).trim();

      const b64 = req.body?.file_base64;
      if (!b64) return bad(res, 400, 'Envie file_base64 no body (sem prefixo data:).');

      const filename = req.body?.filename || 'evidencia.png';
      const mime = req.body?.content_type || 'image/png';

      const { Blob, FormData } = globalThis;
      if (!Blob || !FormData) return bad(res, 501, 'Runtime sem Blob/FormData nativos (Node 18+).');

      const buffer = Buffer.from(b64, 'base64');
      const blob = new Blob([buffer], { type: mime });

      const form = new FormData();
      form.append('file', blob, filename);

      const data = await mlFetch(`/post-purchase/v1/claims/${encodeURIComponent(claimId)}/returns/attachments`, token, {
        method: 'POST',
        body: form
      });
      res.json(data);
    } catch (e) {
      res.status(e.status || 502).json({ error: 'Falha ao enviar evidência', detail: e.message, upstream: e.payload });
    }
  });

  // Return-review unificado (OK = body vazio; Fail = array de reviews)
  app.post('/api/ml/returns/:return_id/return-review', async (req, res) => {
    try {
      const token = await getMLToken(req);
      if (!token) return bad(res, 501, 'Token do ML ausente.');
      const returnId = String(req.params.return_id).trim();
      const hasBody = req.body && Object.keys(req.body).length;
      const body = hasBody ? JSON.stringify(req.body) : null;
      const data = await mlFetch(`/post-purchase/v1/returns/${encodeURIComponent(returnId)}/return-review`, token, {
        method: 'POST',
        headers: { 'Content-Type': hasBody ? 'application/json' : undefined },
        body
      });
      res.json(data);
    } catch (e) {
      res.status(e.status || 502).json({ error: 'Falha ao registrar return-review', detail: e.message, upstream: e.payload });
    }
  });

  // Custo do envio da devolução
  app.get('/api/ml/claims/:claim_id/charges/return-cost', async (req, res) => {
    try {
      const token = await getMLToken(req);
      if (!token) return bad(res, 501, 'Token do ML ausente.');
      const claimId = String(req.params.claim_id).trim();
      const q = new URLSearchParams();
      if (String(req.query.calculate_amount_usd || '') === 'true') q.set('calculate_amount_usd', 'true');
      const path = `/post-purchase/v1/claims/${encodeURIComponent(claimId)}/charges/return-cost` + (q.toString() ? `?${q}` : '');
      const data = await mlFetch(path, token);
      res.json(data);
    } catch (e) {
      res.status(e.status || 502).json({ error: 'Falha ao consultar custo de devolução', detail: e.message, upstream: e.payload });
    }
  });

  // Batch helper: recebe claim_ids e traz os returns associados
  app.post('/api/ml/returns/batch-by-claims', async (req, res) => {
    try {
      const token = await getMLToken(req);
      if (!token) return bad(res, 501, 'Token do ML ausente.');
      const claimIds = Array.isArray(req.body?.claim_ids) ? req.body.claim_ids.map(String) : [];
      if (!claimIds.length) return bad(res, 400, 'Envie claim_ids (array).');
      const items = await returnsForClaimIds(token, claimIds);
      res.json({ items });
    } catch (e) {
      res.status(500).json({ error: 'Falha no batch de returns', detail: e.message });
    }
  });

  /* ---- COMPATIBILIDADE: reexpõe /open|/search|/list para o front legado ---- */
  async function handleLegacyOpen(req, res) {
    try {
      const token = await getMLToken(req);
      if (!token) return bad(res, 501, 'Token do ML ausente.');

      const sellerId = req.get('x-seller-id') || req.query.seller || process.env.ML_SELLER_ID || '';
      const statuses = String(req.query.status || 'opened,in_progress');
      const days     = Math.max(1, Math.min(60, Number(req.query.days || 7)));
      const fromISO  = new Date(Date.now() - days*24*60*60*1000).toISOString();
      const wantAll  = String(req.query.all || '1') === '1';

      // 1) pega claims recentes
      const claims = await searchClaims(token, { sellerId, statuses, fromISO, limit: 50, offset: 0, all: wantAll });
      const claimIds = claims.map(c => c.id || c.claim_id).filter(Boolean);

      // 2) para cada claim, tenta recuperar o return associado
      const items = await returnsForClaimIds(token, claimIds);

      res.json({
        items,
        meta: {
          claims_found: claimIds.length,
          sellerId: sellerId || null,
          statuses, fromISO, all: wantAll
        }
      });
    } catch (e) {
      res.status(e.status || 502).json({ error: e.message || 'ml_error', upstream: e.payload || null });
    }
  }
  app.get('/api/ml/returns/open',   handleLegacyOpen);
  app.get('/api/ml/returns/search', handleLegacyOpen);
  app.get('/api/ml/returns/list',   handleLegacyOpen);
};
