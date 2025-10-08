// server/routes/bling-webhook.js
'use strict';
const express = require('express');
const crypto = require('crypto');
const { query } = require('../db');

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

module.exports = function registerBlingWebhook(app) {
  const router = express.Router();

  // Diagnóstico rápido
  router.get('/webhooks/bling/ping', (_req, res) => {
    res.json({ ok: true, source: 'bling-webhook' });
  });

  // Webhook real (POST)
  router.post('/webhooks/bling', express.json({ limit: '500kb' }), async (req, res) => {
    // ⚠️ SEMPRE responda rápido com 200 para não gerar avalanche de retries
    try {
      const headers = Object.fromEntries(Object.entries(req.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
      const topic =
        headers['x-bling-event'] ||   // se o Bling enviar um header com o tipo do evento
        req.query.topic ||            // fallback via querystring (tests)
        null;

      const payload = req.body || {};

      // ---- IDEMPOTÊNCIA ----
      // Usa (header de evento, se houver) + payload serializado de forma estável
      const stableJson = JSON.stringify(payload);
      const rawKey = `${topic || ''}|${stableJson}`;
      const idempKey = sha256(rawKey);

      // Log bonitinho no console pra auditoria rápida
      console.log('[BLING WH]', {
        topic,
        size: stableJson.length,
        idempKey: idempKey.slice(0, 12),
      });

      // Insere com ON CONFLICT (idempotência)
      await query(
        `INSERT INTO public.bling_webhook_log (topic, payload, idemp_key)
         VALUES ($1, $2, $3)
         ON CONFLICT (idemp_key) DO NOTHING`,
        [topic, stableJson, idempKey]
      );

      // ---- ROTEAMENTO POR "MÓDULO" (simples) ----
      // Se seu payload trouxer um campo indicativo do módulo/entidade, trate aqui.
      // Ex.: payload.modulo === 'produtos' | 'pedidos' (ajuste conforme o formato real).
      const modulo = (payload.modulo || payload.module || '').toString().toLowerCase();
      switch (modulo) {
        case 'produtos':
        case 'produto':
          // TODO: chamar um handler de produtos (ex.: sincronizar dados do produto no seu cache local)
          // await handleProduto(payload)
          break;
        case 'pedidos':
        case 'pedido':
          // TODO: chamar um handler de pedidos (ex.: buscar pedido no Bling e relacionar com devoluções)
          // await handlePedido(payload)
          break;
        default:
          // deixe quieto: muitos webhooks servem só pra acordar um "sync" posterior
          break;
      }

      res.status(200).json({ ok: true });
    } catch (e) {
      console.error('[Bling Webhook] erro:', e);
      // Mesmo com erro, responde 200 p/ evitar reenvio em loop
      res.status(200).json({ ok: true });
    }
  });

  app.use(router);
};
