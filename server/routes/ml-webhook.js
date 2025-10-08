// server/routes/ml-webhook.js
'use strict';
const express = require('express');
const { query } = require('../db');
const { getAuthedAxios } = require('../mlClient');

module.exports = function registerMlWebhook(app){
  const router = express.Router();

  // Mercado Livre envia POST com notificações (resource, topic, user_id, etc.)
  router.post('/webhooks/ml', express.json({ limit: '200kb' }), async (req, res) => {
    try {
      const payload = req.body || {};

      // Ex.: quando topic === "claims", resource pode ter o id do claim
      if (payload.topic === 'claims' && payload.resource) {
        try {
          const claimId = String(payload.resource).replace(/.*\//,''); // extrai o ID se vier como path
          const { http } = await getAuthedAxios();
          const { data: det } = await http.get(`/post-purchase/v1/claims/${claimId}`);

          const order_id = det?.resource_id || det?.order_id;
          if (order_id) {
            // atualizar status básico e logar evento (reaproveitar helpers do import)
            await query(`insert into return_events (return_id, type, title, message, meta, created_by, created_at, idemp_key)
                         select d.id, 'ml-webhook', 'Atualização Claim', 'Webhook claims', $1, 'ml-webhook', now(), $2
                         from devolucoes d where d.id_venda::text = $3
                         on conflict (idemp_key) do nothing`,
              [JSON.stringify({ claim_id: claimId, status: det?.status }), `ml-webhook:${claimId}`, String(order_id)]);
          }
        } catch (e) {
          console.warn('[ml-webhook] falha ao processar claim:', e.message);
        }
      }

      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok:false, error:String(e.message || e) });
    }
  });

  app.use(router);
};
