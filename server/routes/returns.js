// server/routes/ml-returns.js
'use strict';

const { query } = require('../db');

// ---- fetch helper (Node 18+ tem fetch nativo; senão cai no node-fetch) ----
const _fetch = (typeof fetch === 'function')
  ? fetch
  : (...a) => import('node-fetch').then(({ default: f }) => f(...a));

// ---- token helper (ajuste aqui se for multi-loja / multi-token) ----
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
  } catch {
    return null;
  }
}

// ---- chamada genérica à API do ML com tratamento de erro ----
async function mlFetch(path, token, opts = {}) {
  const url = `https://api.mercadolibre.com${path}`;
  const r = await _fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opts.headers || {})
    }
  });
  let j = null;
  try { j = await r.json(); } catch {}
  if (!r.ok) {
    const msg = (j && (j.message || j.error))
      ? `${j.error || ''} ${j.message || ''}`.trim()
      : `ML HTTP ${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    err.payload = j;
    throw err;
  }
  return j;
}

function bad(res, code, msg, extra) {
  return res.status(code).json({ error: msg, ...(extra || {}) });
}

module.exports = function registerMlReturns(app) {
  /**
   * ========================= ROTAS NOVAS (DOC OFICIAL) =========================
   * - GET  /post-purchase/v2/claims/{claim_id}/returns
   * - GET  /post-purchase/v1/returns/{return_id}/reviews
   * - GET  /post-purchase/v1/returns/reasons?flow=seller_return_failed&claim_id={id}
   * - POST /post-purchase/v1/claims/{claim_id}/returns/attachments   (multipart)
   * - POST /post-purchase/v1/returns/{return_id}/return-review       (body vazio = OK)
   * - GET  /post-purchase/v1/claims/{claim_id}/charges/return-cost[?calculate_amount_usd=true]
   * - POST /api/ml/returns/batch-by-claims (helper interno)
   */

  // 1) Devolução a partir do claim_id
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

  // 2) Reviews da devolução (warehouse/seller/apelações finalizadas)
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

  // 3) Reasons para revisão falha do vendedor (flow=seller_return_failed)
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

  // 4) Upload de evidência (aceita base64 do front)
  // Body esperado: { file_base64: "<sem prefixo data:>", filename?: "img.png", content_type?: "image/png" }
  app.post('/api/ml/claims/:claim_id/returns/attachments', async (req, res) => {
    try {
      const token = await getMLToken(req);
      if (!token) return bad(res, 501, 'Token do ML ausente.');
      const claimId = String(req.params.claim_id).trim();

      const b64 = req.body?.file_base64;
      if (!b64) return bad(res, 400, 'Envie file_base64 no body (sem prefixo data:).');

      const filename = req.body?.filename || 'evidencia.png';
      const mime = req.body?.content_type || 'image/png';

      // Node 18+ tem Blob/FormData globais (undici)
      const { Blob, FormData } = globalThis;
      if (!Blob || !FormData) return bad(res, 501, 'Runtime sem Blob/FormData nativos. Use Node 18+ ou adicione um polyfill.');

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

  // 5) Return review unificado (OK/Fail).
  //  - Body vazio => revisão OK para todas as ordens
  //  - Body array => revisão FALHA por ordem (reason_id, message, attachments[], order_id quando aplicável)
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

  // 6) Custo de envio da devolução (return-cost por claim)
  app.get('/api/ml/claims/:claim_id/charges/return-cost', async (req, res) => {
    try {
      const token = await getMLToken(req);
      if (!token) return bad(res, 501, 'Token do ML ausente.');
      const claimId = String(req.params.claim_id).trim();

      const q = new URLSearchParams();
      if (String(req.query.calculate_amount_usd || '') === 'true') {
        q.set('calculate_amount_usd', 'true');
      }
      const path = `/post-purchase/v1/claims/${encodeURIComponent(claimId)}/charges/return-cost` + (q.toString() ? `?${q}` : '');
      const data = await mlFetch(path, token);
      res.json(data);
    } catch (e) {
      res.status(e.status || 502).json({ error: 'Falha ao consultar custo de devolução', detail: e.message, upstream: e.payload });
    }
  });

  // 7) Helper: batch por lista de claims (para seu importador)
  // Body: { claim_ids: ["5298178312", "..."] }
  app.post('/api/ml/returns/batch-by-claims', async (req, res) => {
    try {
      const token = await getMLToken(req);
      if (!token) return bad(res, 501, 'Token do ML ausente.');
      const claimIds = Array.isArray(req.body?.claim_ids) ? req.body.claim_ids.map(String) : [];
      if (!claimIds.length) return bad(res, 400, 'Envie claim_ids (array).');

      const out = [];
      for (const id of claimIds) {
        try {
          const ret = await mlFetch(`/post-purchase/v2/claims/${encodeURIComponent(id)}/returns`, token);
          out.push({ claim_id: id, ok: true, data: ret });
        } catch (e) {
          out.push({ claim_id: id, ok: false, error: e.message, upstream: e.payload });
        }
      }
      res.json({ items: out });
    } catch (e) {
      res.status(500).json({ error: 'Falha no batch de returns', detail: e.message });
    }
  });
};
