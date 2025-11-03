// server/routes/mlChat.js
'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const router = express.Router();

// ---- helpers -------------------------------------------------
const ML_BASE = 'https://api.mercadolibre.com/post-purchase/v1';

function getSellerToken(req) {
  // prioridade: header -> sessão (se você salvar lá)
  return req.get('x-seller-token') || req.session?.ml?.access_token || '';
}
async function mlFetch(req, url, opts = {}) {
  const token = getSellerToken(req);
  if (!token) {
    const e = new Error('missing_seller_token');
    e.status = 401;
    throw e;
  }
  const r = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(opts.headers || {})
    }
  });
  // repassa corpo
  const ct = r.headers.get('content-type') || '';
  const body = ct.includes('application/json') ? await r.json().catch(() => null)
                                               : await r.text().catch(() => '');
  if (!r.ok) {
    const err = new Error(body?.message || r.statusText);
    err.status = r.status;
    err.body = body;
    throw err;
  }
  return body;
}
const ok = (res, data = {}) => res.json({ ok: true, ...data });

// ---- notices (apenas para popular a lista à esquerda; vazio por padrão) ----
router.get('/communications/notices', (req, res) => {
  res.json({ results: [], limit: 10, offset: 0, total: 0 });
});

// ---- GET mensagens (pack/claim) -------------------------------------------
router.get('/chat/messages', async (req, res) => {
  const { type, id } = req.query;
  if (!type || !id) return res.status(400).json({ error: 'type e id são obrigatórios' });

  try {
    if (String(type) === 'claim') {
      const data = await mlFetch(req, `${ML_BASE}/claims/${encodeURIComponent(id)}/messages`);
      // adapta para o shape que o front espera
      const messages = (Array.isArray(data) ? data : []).map((m, i) => ({
        id: `ml_${i}`,
        author_role: m.sender_role,          // complainant | respondent | mediator
        author_name: m.sender_role,
        text: m.message || '',
        created_at: m.message_date || m.date_created,
        attachments: (m.attachments || []).map(a => ({
          id: a.filename,
          name: a.original_filename || a.filename,
          url: null // download exige endpoint ML específico; podemos montar depois
        }))
      }));
      return res.json({ type, id, messages });
    }

    if (String(type) === 'pack') {
      // ainda não mapeado (sua fonte é outra). Retorna vazio.
      return res.json({ type, id, messages: [] });
    }

    return res.status(400).json({ error: 'type inválido' });
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({ error: e.message || 'fail', detail: e.body || null });
  }
});

// ---- POST upload de anexo (envia para o ML) -------------------------------
const TMP_DIR = path.join(__dirname, '..', '..', 'tmp-upload');
fs.mkdirSync(TMP_DIR, { recursive: true });
const upload = multer({ dest: TMP_DIR });

router.post('/claims/:id/attachments', upload.single('file'), async (req, res) => {
  const claimId = req.params.id;
  if (!req.file) return res.status(400).json({ error: 'file é obrigatório' });

  try {
    // monta form-data nativa do fetch do Node 18+
    const buf = fs.readFileSync(req.file.path);
    const blob = new Blob([buf], { type: req.file.mimetype || 'application/octet-stream' });
    const form = new FormData();
    form.append('file', blob, req.file.originalname || req.file.filename);

    const out = await mlFetch(req, `${ML_BASE}/claims/${encodeURIComponent(claimId)}/attachments`, {
      method: 'POST',
      body: form
    });

    // limpa tmp
    fs.unlink(req.file.path, () => {});
    // o ML retorna { user_id, filename } (ou file_name)
    const filename = out?.filename || out?.file_name;
    return ok(res, { filename });
  } catch (e) {
    fs.unlink(req.file?.path || '', () => {});
    const status = e.status || 500;
    return res.status(status).json({ error: e.message || 'upload_fail', detail: e.body || null });
  }
});

// ---- POST enviar mensagem (usa actions/send-message) ----------------------
router.post('/claims/:id/messages', express.json(), async (req, res) => {
  const claimId = req.params.id;
  const { receiver_role, message, attachments } = req.body || {};
  if (!receiver_role || !message) {
    return res.status(400).json({ error: 'receiver_role e message são obrigatórios' });
  }
  try {
    // corpo aceito pela API do ML
    const body = { receiver_role, message };
    if (Array.isArray(attachments) && attachments.length) body.attachments = attachments;

    await mlFetch(req, `${ML_BASE}/claims/${encodeURIComponent(claimId)}/actions/send-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    return ok(res, { claim_id: claimId, sent: true });
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({ error: e.message || 'send_fail', detail: e.body || null });
  }
});

module.exports = router;
