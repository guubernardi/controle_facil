// server/routes/mlChat.js
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const router = express.Router();

/**
 * === Storage para anexos de claim ===
 * (salva em /public/uploads/chat/)
 */
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'public', 'uploads', 'chat');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const base = (file.originalname || 'arquivo').replace(/\s+/g, '_');
    const ext  = path.extname(base);
    const name = path.basename(base, ext);
    cb(null, `${Date.now()}_${name}${ext}`);
  }
});
const upload = multer({ storage });

function nowIsoMinus(ms) { return new Date(Date.now() - ms).toISOString(); }
function ok(res, data = {}) { return res.json({ ok: true, ...data }); }

/**
 * GET /api/ml/communications/notices
 * Lista “avisos” (stub) só para popular a coluna esquerda com alguns claims.
 */
router.get('/communications/notices', (req, res) => {
  const limit  = Math.max(1, Math.min(parseInt(req.query.limit || '10', 10), 50));
  const offset = Math.max(0, parseInt(req.query.offset || '0', 10) || 0);

  // Stub simples — devolve 3 claims fake
  const results = [
    { id: 'n1', type: 'claim_notice', claim_id: '842199', created_at: nowIsoMinus(60_000) },
    { id: 'n2', type: 'claim_notice', claim_id: '553120', created_at: nowIsoMinus(5 * 60_000) },
    { id: 'n3', type: 'claim_notice', claim_id: '909833', created_at: nowIsoMinus(8 * 60_000) },
  ].slice(offset, offset + limit);

  res.json({ results, limit, offset, total: 3 });
});

/**
 * GET /api/ml/chat/messages?type=pack|claim&id=...
 * Mensagens do chat (stub – retorna alguns exemplos)
 */
router.get('/chat/messages', (req, res) => {
  const { type, id } = req.query;
  if (!type || !id) return res.status(400).json({ error: 'type e id são obrigatórios' });

  let messages = [];
  if (String(type) === 'pack') {
    messages = [
      { id: 'm1', author_role: 'buyer',  author_name: 'Comprador', text: 'Olá, tive um problema com o produto.', attachments: [], created_at: nowIsoMinus(6 * 60_000) },
      { id: 'm2', author_role: 'seller', author_name: 'Vendedor',  text: 'Claro! Vamos resolver.',                attachments: [], created_at: nowIsoMinus(5 * 60_000) },
    ];
  } else if (String(type) === 'claim') {
    messages = [
      { id: 'p1', author_role: 'platform', author_name: 'Mediador', text: 'Mensagem da mediação.', attachments: [], created_at: nowIsoMinus(60_000) },
      { id: 'p2', author_role: 'seller',   author_name: 'Vendedor', text: 'Enviarei evidências por aqui.', attachments: [], created_at: nowIsoMinus(30_000) },
    ];
  }

  res.json({ type, id, messages });
});

/**
 * POST /api/ml/chat/send
 * Body: { type: 'pack', id: '...', text: '...' }
 * (Stub: apenas confirma recebimento)
 */
router.post('/chat/send', express.json(), (req, res) => {
  const { type, id, text } = req.body || {};
  if (!type || !id || !text) return res.status(400).json({ error: 'type, id e text são obrigatórios' });
  return ok(res, { sent_id: `sent_${Date.now()}` });
});

/**
 * POST /api/ml/claims/:id/attachments
 * Upload de arquivo da mediação (salva no /public/uploads/chat)
 * Resposta: { filename, url }
 */
router.post('/claims/:id/attachments', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file é obrigatório' });
  const filename = req.file.filename;
  const url = `/uploads/chat/${filename}`; // servidos pelo express.static
  return ok(res, { filename, url });
});

/**
 * POST /api/ml/claims/:id/messages
 * Body: { receiver_role: 'mediator'|'buyer'|'seller', message: '...', attachments?: [filename] }
 * (Stub: apenas confirma recebimento)
 */
router.post('/claims/:id/messages', express.json(), (req, res) => {
  const { id } = req.params;
  const { receiver_role, message, attachments = [] } = req.body || {};
  if (!id || !receiver_role || !message) {
    return res.status(400).json({ error: 'id, receiver_role e message são obrigatórios' });
  }
  return ok(res, {
    claim_id: id,
    created_at: new Date().toISOString(),
    attachments
  });
});

module.exports = router;
