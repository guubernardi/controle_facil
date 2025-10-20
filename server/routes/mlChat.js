// routes/mlChat.js
const express = require('express');
const multer  = require('multer');
const { meliGet, meliPost, meliDownload, FormData } = require('../services/meliApi');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const router = express.Router();

/** Helper: monta ctx com token do seller da requisição atual.
 *  Troque para ler do seu auth (req.user.sellerToken, etc.).
 */
function ctxFromReq(req) {
  return {
    sellerToken: req.headers['x-seller-token'] // ou pegue do req.user
  };
}

/* =========================
 * MENSAGENS (CHAT)
 * ========================= */

/** GET mensagens da reclamação (somente mensagens moderadas próprias + contraparte filtrada pelo ML)
 *  GET /api/ml/claims/:claimId/messages
 */
router.get('/claims/:claimId/messages', async (req, res) => {
  try {
    const { claimId } = req.params;
    const data = await meliGet(`/post-purchase/v1/claims/${claimId}/messages`, ctxFromReq(req));
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

/** POST upload de anexo para mensagens
 *  Retorna { filename } para usar no send-message
 *  POST /api/ml/claims/:claimId/attachments (multipart form: file)
 */
router.post('/claims/:claimId/attachments', upload.single('file'), async (req, res) => {
  try {
    const { claimId } = req.params;
    if (!req.file) return res.status(400).json({ error: 'file é obrigatório' });

    const fd = new FormData();
    fd.append('file', req.file.buffer, { filename: req.file.originalname });

    const data = await meliPost(`/post-purchase/v1/claims/${claimId}/attachments`, { formData: fd }, ctxFromReq(req), { asFormData: true });
    // docs retornam { user_id, filename }
    res.json({ filename: data.filename || data.file_name, user_id: data.user_id });
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

/** POST enviar mensagem
 *  body: { receiver_role: "complainant|respondent|mediator", message: "texto", attachments?: [ "filename1", ... ] }
 *  POST /api/ml/claims/:claimId/actions/send-message
 */
router.post('/claims/:claimId/messages', async (req, res) => {
  try {
    const { claimId } = req.params;
    const { receiver_role, message, attachments } = req.body || {};
    if (!receiver_role || !message) return res.status(400).json({ error: 'receiver_role e message são obrigatórios' });

    const payload = { receiver_role, message };
    if (attachments?.length) payload.attachments = attachments;

    const data = await meliPost(`/post-purchase/v1/claims/${claimId}/actions/send-message`, payload, ctxFromReq(req));
    // status 201 created (ML responde vazio). Enviamos OK explícito:
    res.status(201).json({ ok: true });
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

/** GET download de anexo de mensagem
 *  /api/ml/claims/:claimId/attachments/:attachmentId/download
 */
router.get('/claims/:claimId/attachments/:attId/download', async (req, res) => {
  try {
    const { claimId, attId } = req.params;
    const { buf, headers } = await meliDownload(`/post-purchase/v1/claims/${claimId}/attachments/${encodeURIComponent(attId)}/download`, ctxFromReq(req));
    res.setHeader('Content-Type', headers['content-type'] || 'application/octet-stream');
    res.setHeader('Content-Disposition', headers['content-disposition'] || `attachment; filename="${attId}"`);
    res.send(buf);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

/* =========================
 * RETURNS (v2) + REVIEWS
 * ========================= */

/** GET detalhes da devolução por claimId (v2)
 *  GET /api/ml/returns/by-claim/:claimId
 */
router.get('/returns/by-claim/:claimId', async (req, res) => {
  try {
    const { claimId } = req.params;
    const data = await meliGet(`/post-purchase/v2/claims/${claimId}/returns`, ctxFromReq(req));
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

/** GET reviews de uma devolução por return_id
 *  GET /api/ml/returns/:returnId/reviews
 */
router.get('/returns/:returnId/reviews', async (req, res) => {
  try {
    const { returnId } = req.params;
    const data = await meliGet(`/post-purchase/v1/returns/${returnId}/reviews`, ctxFromReq(req));
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

/** POST review da devolução (endpoint unificado)
 *  - body vazio  -> review OK (todas as ordens)
 *  - body = [ { order_id, reason_id, message?, attachments? }, ... ] -> review FAIL
 *  POST /api/ml/returns/:returnId/return-review
 */
router.post('/returns/:returnId/return-review', async (req, res) => {
  try {
    const { returnId } = req.params;
    const body = req.body && Object.keys(req.body).length ? req.body : []; // pode ser [] (OK) ou array de reviews (FAIL)
    const data = await meliPost(`/post-purchase/v1/returns/${returnId}/return-review`, body, ctxFromReq(req));
    res.status(201).json({ ok: true, data: data || null });
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

/** GET reasons para review falha
 *  GET /api/ml/returns/reasons?seller_return_failed&claim_id=...
 */
router.get('/returns/reasons', async (req, res) => {
  try {
    const { flow = 'seller_return_failed', claim_id } = req.query;
    if (!claim_id) return res.status(400).json({ error: 'claim_id é obrigatório' });

    const data = await meliGet(`/post-purchase/v1/returns/reasons`, ctxFromReq(req), { params: { flow, claim_id } });
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

/** POST anexo (upload) para usar em review falha de RETURN
 *  Retorna { file_name } para enviar no body do return-review (attachments)
 *  POST /api/ml/claims/:claimId/returns/attachments (multipart: file)
 */
router.post('/claims/:claimId/returns/attachments', upload.single('file'), async (req, res) => {
  try {
    const { claimId } = req.params;
    if (!req.file) return res.status(400).json({ error: 'file é obrigatório' });

    const fd = new FormData();
    fd.append('file', req.file.buffer, { filename: req.file.originalname });
    const data = await meliPost(`/post-purchase/v1/claims/${claimId}/returns/attachments`, { formData: fd }, ctxFromReq(req), { asFormData: true });

    res.json({ file_name: data.file_name || data.filename, user_id: data.user_id });
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

/** GET custo de envio da devolução
 *  /api/ml/claims/:claimId/charges/return-cost?usd=true|false
 */
router.get('/claims/:claimId/charges/return-cost', async (req, res) => {
  try {
    const { claimId } = req.params;
    const { usd } = req.query;
    const params = usd ? { calculate_amount_usd: String(usd) === 'true' } : undefined;
    const data = await meliGet(`/post-purchase/v1/claims/${claimId}/charges/return-cost`, ctxFromReq(req), { params });
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

/* =========================
 * COMMUNICATIONS /notices
 * ========================= */

/** GET communications/notices
 *  - Para seller: token do seller
 *  - Para integrador: usar token do owner (passe header x-owner=true)
 */
router.get('/communications/notices', async (req, res) => {
  try {
    const owner = String(req.headers['x-owner'] || '') === 'true';
    const ctx = owner ? { owner: true } : ctxFromReq(req);
    const { limit = 10, offset = 0 } = req.query;
    const data = await meliGet(`/communications/notices`, ctx, { params: { limit, offset } });
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

module.exports = router;
