// server/routes/bling-webhook.js
'use strict';
const express = require('express');
const { query } = require('../db');

module.exports = function registerBlingWebhook(app) {
  const router = express.Router();

  // Ping de diagnóstico (GET)
  router.get('/webhooks/bling/ping', (_req, res) => {
    res.json({ ok: true, source: 'bling-webhook' });
  });

  // Webhook real (POST)
  router.post('/webhooks/bling', express.json({ limit: '500kb' }), async (req, res) => {
    try {
      const topic = req.get('x-bling-event') || req.query.topic || null;
      const payload = req.body || {};

      // Opcional: logar em tabela
      try {
        await query(
          `INSERT INTO bling_webhook_log (topic, payload) VALUES ($1,$2)`,
          [topic, JSON.stringify(payload)]
        );
      } catch (_) {}

      // responda rápido (200) para evitar retries
      res.status(200).json({ ok: true });
    } catch (e) {
      console.error('[Bling Webhook] erro:', e);
      res.status(200).json({ ok: true }); // ainda 200 para não gerar avalanche de retries
    }
  });

  app.use(router);
};
