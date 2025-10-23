// server/routes/ml-resolutions.js
'use strict';

const express = require('express');
const multer  = require('multer');
const { meliGet, meliPost } = require('../mlClient'); // já usado no mlChat
const upload  = multer(); // memoria, multipart leve

function ctxFromReq(req) {
  // Usa sellerId opcional da sessão/RLS se tiver
  const sellerId = req.session?.user?.ml_user_id || req.session?.user?.seller_id || undefined;
  return { sellerId };
}

module.exports = function registerMlResolutions(app) {
  const router = express.Router();

  // ========= Affects reputation =========
  // GET /api/ml/claims/:claimId/affects-reputation
  router.get('/claims/:claimId/affects-reputation', async (req, res) => {
    try {
      const { claimId } = req.params;
      const data = await meliGet(`/post-purchase/v1/claims/${claimId}/affects-reputation`, ctxFromReq(req));
      res.json({ ok: true, data });
    } catch (e) {
      res.status(+(e.status || 500)).json({ ok:false, error: e.message || String(e) });
    }
  });

  // ========= Return cost =========
  // GET /api/ml/claims/:claimId/charges/return-cost?calculate_amount_usd=true|false
  router.get('/claims/:claimId/charges/return-cost', async (req, res) => {
    try {
      const { claimId } = req.params;
      const { calculate_amount_usd } = req.query;
      const data = await meliGet(`/post-purchase/v1/claims/${claimId}/charges/return-cost`, ctxFromReq(req), {
        params: { calculate_amount_usd }
      });
      res.json({ ok: true, data });
    } catch (e) {
      res.status(+(e.status || 500)).json({ ok:false, error: e.message || String(e) });
    }
  });

  // ========= Partial refund: ofertas =========
  // GET /api/ml/claims/:claimId/partial-refund/available-offers
  router.get('/claims/:claimId/partial-refund/available-offers', async (req, res) => {
    try {
      const { claimId } = req.params;
      const data = await meliGet(`/post-purchase/v1/claims/${claimId}/partial-refund/available-offers`, ctxFromReq(req));
      res.json({ ok: true, data });
    } catch (e) {
      res.status(+(e.status || 500)).json({ ok:false, error: e.message || String(e) });
    }
  });

  // ========= Partial refund: efetivar =========
  // POST /api/ml/claims/:claimId/expected-resolutions/partial-refund  { percentage: 50 }
  router.post('/claims/:claimId/expected-resolutions/partial-refund', async (req, res) => {
    try {
      const { claimId } = req.params;
      const { percentage } = req.body || {};
      if (percentage === undefined) return res.status(400).json({ ok:false, error:'percentage required' });
      const payload = { percentage: Number(percentage) };
      const data = await meliPost(`/post-purchase/v1/claims/${claimId}/expected-resolutions/partial-refund`, payload, ctxFromReq(req));
      res.json({ ok: true, data });
    } catch (e) {
      res.status(+(e.status || 500)).json({ ok:false, error: e.message || String(e) });
    }
  });

  // ========= Refund total =========
  // POST /api/ml/claims/:claimId/expected-resolutions/refund
  router.post('/claims/:claimId/expected-resolutions/refund', async (req, res) => {
    try {
      const { claimId } = req.params;
      const data = await meliPost(`/post-purchase/v1/claims/${claimId}/expected-resolutions/refund`, {}, ctxFromReq(req));
      res.json({ ok: true, data });
    } catch (e) {
      res.status(+(e.status || 500)).json({ ok:false, error: e.message || String(e) });
    }
  });

  // ========= Allow return (gera etiqueta quando aplicável) =========
  // POST /api/ml/claims/:claimId/expected-resolutions/allow-return
  router.post('/claims/:claimId/expected-resolutions/allow-return', async (req, res) => {
    try {
      const { claimId } = req.params;
      const data = await meliPost(`/post-purchase/v1/claims/${claimId}/expected-resolutions/allow-return`, {}, ctxFromReq(req));
      res.json({ ok: true, data });
    } catch (e) {
      res.status(+(e.status || 500)).json({ ok:false, error: e.message || String(e) });
    }
  });

  // ========= Abrir disputa (mediação) =========
  // POST /api/ml/claims/:claimId/actions/open-dispute
  router.post('/claims/:claimId/actions/open-dispute', async (req, res) => {
    try {
      const { claimId } = req.params;
      const data = await meliPost(`/post-purchase/v1/claims/${claimId}/actions/open-dispute`, {}, ctxFromReq(req));
      res.json({ ok: true, data });
    } catch (e) {
      res.status(+(e.status || 500)).json({ ok:false, error: e.message || String(e) });
    }
  });

  // ========= Evidences =========
  // GET /api/ml/claims/:claimId/evidences
  router.get('/claims/:claimId/evidences', async (req, res) => {
    try {
      const { claimId } = req.params;
      const data = await meliGet(`/post-purchase/v1/claims/${claimId}/evidences`, ctxFromReq(req));
      res.json({ ok: true, data });
    } catch (e) {
      res.status(+(e.status || 500)).json({ ok:false, error: e.message || String(e) });
    }
  });

  // POST /api/ml/claims/:claimId/attachments-evidences (multipart: file)
  router.post('/claims/:claimId/attachments-evidences', upload.single('file'), async (req, res) => {
    try {
      const { claimId } = req.params;
      if (!req.file) return res.status(400).json({ ok:false, error:'file required (multipart/form-data)' });

      // usa meliPost com form-data
      const formData = { file: { buffer: req.file.buffer, filename: req.file.originalname } };
      const data = await meliPost(`/post-purchase/v1/claims/${claimId}/attachments-evidences`, { formData }, ctxFromReq(req), { asFormData: true });
      res.json({ ok: true, data });
    } catch (e) {
      res.status(+(e.status || 500)).json({ ok:false, error: e.message || String(e) });
    }
  });

  // GET info do anexo
  router.get('/claims/:claimId/attachments-evidences/:attachmentId', async (req, res) => {
    try {
      const { claimId, attachmentId } = req.params;
      const data = await meliGet(`/post-purchase/v1/claims/${claimId}/attachments-evidences/${encodeURIComponent(attachmentId)}`, ctxFromReq(req));
      res.json({ ok: true, data });
    } catch (e) {
      res.status(+(e.status || 500)).json({ ok:false, error: e.message || String(e) });
    }
  });

  // GET download do anexo (retorna JSON com url assinada quando disponível ou redireciona/stream)
  router.get('/claims/:claimId/attachments-evidences/:attachmentId/download', async (req, res) => {
    try {
      const { claimId, attachmentId } = req.params;
      // se seu meliGet suporta stream, dá pra fazer proxy; aqui retornamos o JSON puro
      const data = await meliGet(`/post-purchase/v1/claims/${claimId}/attachments-evidences/${encodeURIComponent(attachmentId)}/download`, ctxFromReq(req));
      res.json({ ok: true, data });
    } catch (e) {
      res.status(+(e.status || 500)).json({ ok:false, error: e.message || String(e) });
    }
  });

  // POST evidences (shipping_evidence | handling_shipping_evidence)
  // body esperado conforme doc
  router.post('/claims/:claimId/actions/evidences', async (req, res) => {
    try {
      const { claimId } = req.params;
      const payload = req.body || {};
      const data = await meliPost(`/post-purchase/v1/claims/${claimId}/actions/evidences`, payload, ctxFromReq(req));
      res.json({ ok: true, data });
    } catch (e) {
      res.status(+(e.status || 500)).json({ ok:false, error: e.message || String(e) });
    }
  });

  app.use('/api/ml', router);
};
