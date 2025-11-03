// server/routes/ml-claims.js
'use strict';
/**
 * Proxy de rotas oficiais do Mercado Livre (Claims):
 * - messages/attachments (já coberto em mlChat.js; aqui focamos em resoluções, mediação e evidences)
 * - open-dispute, expected-resolutions (GET/POST), partial-refund (GET/POST), refund total,
 *   allow-return, evidences (GET/POST), attachments-evidences (POST/GET/download).
 *
 * Requer:
 * - Header: x-seller-token: <ACCESS_TOKEN> (ou token em req.session.ml.access_token)
 *
 * Respostas de erro propagam status e corpo do ML quando possível.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const router = express.Router();

const ML_BASE = 'https://api.mercadolibre.com/post-purchase/v1';

function getSellerToken(req) {
  return req.get('x-seller-token') || req.session?.ml?.access_token || '';
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj?.[k] !== undefined) out[k] = obj[k];
  return out;
}

/** Fetch JSON/text (levanta erro com .status e .body) */
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
  const ct = r.headers.get('content-type') || '';
  const body = ct.includes('application/json') ? await r.json().catch(() => null)
                                               : await r.text().catch(() => '');
  if (!r.ok) {
    const err = new Error((body && (body.message || body.error)) || r.statusText);
    err.status = r.status;
    err.body = body;
    err.metadata = r.headers.get('metadata') || null; // header especial do ML
    throw err;
  }
  return body;
}

/** Fetch bruto (para download/stream) */
async function mlFetchRaw(req, url, opts = {}) {
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
      ...(opts.headers || {})
    }
  });
  if (!r.ok) {
    const ct = r.headers.get('content-type') || '';
    const body = ct.includes('application/json') ? await r.json().catch(() => null)
                                                 : await r.text().catch(() => '');
    const err = new Error((body && (body.message || body.error)) || r.statusText);
    err.status = r.status;
    err.body = body;
    err.metadata = r.headers.get('metadata') || null;
    throw err;
  }
  return r;
}

const ok = (res, data = {}) => res.json({ ok: true, ...data });

/* =========================================================================
 *  1) MEDIAÇÃO
 * ========================================================================= */

/** Abrir disputa (mediação) */
router.post('/claims/:id/actions/open-dispute', async (req, res) => {
  try {
    const claimId = encodeURIComponent(req.params.id);
    const out = await mlFetch(req, `${ML_BASE}/claims/${claimId}/actions/open-dispute`, {
      method: 'POST'
    });
    return res.status(200).json(out);
  } catch (e) {
    const s = e.status || 500;
    return res.status(s).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

/* =========================================================================
 *  2) EXPECTED RESOLUTIONS
 * ========================================================================= */

/** Listar resoluções esperadas da claim */
router.get('/claims/:id/expected-resolutions', async (req, res) => {
  try {
    const claimId = encodeURIComponent(req.params.id);
    const out = await mlFetch(req, `${ML_BASE}/claims/${claimId}/expected-resolutions`);
    return res.json(Array.isArray(out) ? out : (out || []));
  } catch (e) {
    const s = e.status || 500;
    return res.status(s).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

/** Ofertas disponíveis para reembolso parcial */
router.get('/claims/:id/partial-refund/available-offers', async (req, res) => {
  try {
    const claimId = encodeURIComponent(req.params.id);
    const out = await mlFetch(req, `${ML_BASE}/claims/${claimId}/partial-refund/available-offers`);
    return res.json(out || {});
  } catch (e) {
    const s = e.status || 500;
    return res.status(s).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

/** Criar expected-resolution: partial_refund (percentage obrigatório) */
router.post('/claims/:id/expected-resolutions/partial-refund', express.json(), async (req, res) => {
  try {
    const claimId = encodeURIComponent(req.params.id);
    const body = pick(req.body || {}, ['percentage']);
    if (typeof body.percentage !== 'number') {
      return res.status(400).json({ error: 'percentage numérico é obrigatório' });
    }
    const out = await mlFetch(req, `${ML_BASE}/claims/${claimId}/expected-resolutions/partial-refund`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return res.json(out || { ok: true });
  } catch (e) {
    const s = e.status || 500;
    return res.status(s).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

/** Criar expected-resolution: refund (devolução total) */
router.post('/claims/:id/expected-resolutions/refund', async (req, res) => {
  try {
    const claimId = encodeURIComponent(req.params.id);
    const out = await mlFetch(req, `${ML_BASE}/claims/${claimId}/expected-resolutions/refund`, {
      method: 'POST'
    });
    return res.json(out || { ok: true });
  } catch (e) {
    const s = e.status || 500;
    return res.status(s).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

/** Criar expected-resolution: allow-return (devolução do produto) */
router.post('/claims/:id/expected-resolutions/allow-return', async (req, res) => {
  try {
    const claimId = encodeURIComponent(req.params.id);
    const out = await mlFetch(req, `${ML_BASE}/claims/${claimId}/expected-resolutions/allow-return`, {
      method: 'POST'
    });
    return res.json(out || { ok: true });
  } catch (e) {
    const s = e.status || 500;
    return res.status(s).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

/* =========================================================================
 *  3) EVIDENCES
 * ========================================================================= */

/** Listar evidences da claim */
router.get('/claims/:id/evidences', async (req, res) => {
  try {
    const claimId = encodeURIComponent(req.params.id);
    const out = await mlFetch(req, `${ML_BASE}/claims/${claimId}/evidences`);
    return res.json(Array.isArray(out) ? out : (out || []));
  } catch (e) {
    const s = e.status || 500;
    return res.status(s).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

/** Enviar evidences (shipping_evidence / handling_shipping_evidence, etc) */
router.post('/claims/:id/actions/evidences', express.json(), async (req, res) => {
  try {
    const claimId = encodeURIComponent(req.params.id);
    const body = req.body || {};
    const out = await mlFetch(req, `${ML_BASE}/claims/${claimId}/actions/evidences`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return res.json(out || { ok: true });
  } catch (e) {
    const s = e.status || 500;
    return res.status(s).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

/* =========================================================================
 *  4) ATTACHMENTS - EVIDENCES (upload/info/download)
 * ========================================================================= */

const TMP_DIR = path.join(__dirname, '..', '..', 'tmp-upload');
fs.mkdirSync(TMP_DIR, { recursive: true });
const upload = multer({ dest: TMP_DIR });

/** Upload de anexo para evidences */
router.post('/claims/:id/attachments-evidences', upload.single('file'), async (req, res) => {
  const claimId = encodeURIComponent(req.params.id);
  if (!req.file) return res.status(400).json({ error: 'file é obrigatório (multipart/form-data)' });

  try {
    const buf = fs.readFileSync(req.file.path);
    const blob = new Blob([buf], { type: req.file.mimetype || 'application/octet-stream' });
    const form = new FormData();
    form.append('file', blob, req.file.originalname || req.file.filename);

    // opcional: o ML aceita x-public: true; repassa se vier do cliente
    const extraHeaders = {};
    const xPublic = req.get('x-public');
    if (xPublic) extraHeaders['x-public'] = xPublic;

    const out = await mlFetch(req, `${ML_BASE}/claims/${claimId}/attachments-evidences`, {
      method: 'POST',
      headers: { ...extraHeaders },
      body: form
    });

    fs.unlink(req.file.path, () => {});
    // Resposta: { user_id, file_name }
    const file_name = out?.file_name || out?.filename;
    return ok(res, { file_name });
  } catch (e) {
    fs.unlink(req.file?.path || '', () => {});
    const s = e.status || 500;
    return res.status(s).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

/** Info do anexo de evidences */
router.get('/claims/:id/attachments-evidences/:attachmentId', async (req, res) => {
  try {
    const claimId = encodeURIComponent(req.params.id);
    const att = encodeURIComponent(req.params.attachmentId);
    const out = await mlFetch(req, `${ML_BASE}/claims/${claimId}/attachments-evidences/${att}`);
    return res.json(out || {});
  } catch (e) {
    const s = e.status || 500;
    return res.status(s).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

/** Download do anexo de evidences */
router.get('/claims/:id/attachments-evidences/:attachmentId/download', async (req, res) => {
  try {
    const claimId = encodeURIComponent(req.params.id);
    const att = encodeURIComponent(req.params.attachmentId);
    const r = await mlFetchRaw(req, `${ML_BASE}/claims/${claimId}/attachments-evidences/${att}/download`);
    // Propaga headers principais
    const ct = r.headers.get('content-type') || 'application/octet-stream';
    const disp = r.headers.get('content-disposition') || `inline; filename="${att}"`;
    res.set('Content-Type', ct);
    res.set('Content-Disposition', disp);
    const ab = await r.arrayBuffer();
    return res.send(Buffer.from(ab));
  } catch (e) {
    const s = e.status || 500;
    return res.status(s).json({ error: e.message, detail: e.body || null, metadata: e.metadata || null });
  }
});

module.exports = router;
