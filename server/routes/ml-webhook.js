// server/routes/ml-webhook.js
'use strict';
const express = require('express');
const { query } = require('../db');
const { getAuthedAxios } = require('../mlClient');
const events = require('../events'); 

module.exports = function registerMlWebhook(app){
  const router = express.Router();

  // Mercado Livre -> Webhook
  router.post('/webhooks/ml', express.json({ limit: '200kb' }), async (req, res) => {
    try {
      const payload = req.body || {};

      // Processa apenas notificações de Claims
      if (payload.topic === 'claims' && payload.resource) {
        try {
          // resource pode vir como path: "/post-purchase/.../claims/123456"
          const claimId = String(payload.resource).replace(/.*\//,'').trim();
          if (!claimId) throw new Error('claimId vazio');

          const { http } = await getAuthedAxios();
          const { data: det } = await http.get(`/post-purchase/v1/claims/${claimId}`);

          // alguns apps usam resource_id, outros order_id/pack_id
          const order_id = String(det?.resource_id || det?.order_id || det?.pack_id || '').trim();
          const idemp = `ml-claim:${claimId}:${det?.status || det?.stage || 'unknown'}`;

          // Loga evento ligado à devolução (se existir o pedido na tabela)
          await query(`
            insert into return_events (return_id, type, title, message, meta, created_by, created_at, idemp_key)
            select d.id, 'ml-webhook', 'Atualização de Claim', 'Webhook: claims', $1, 'ml-webhook', now(), $2
            from devolucoes d
            where d.id_venda::text = $3
            on conflict (idemp_key) do nothing
          `, [JSON.stringify({
                claim_id: claimId,
                status: det?.status || null,
                stage: det?.stage || null,
                subtype: det?.subtype || null
              }),
              idemp,
              order_id
          ]);

          // Notifica front em tempo real (toast + refresh)
          events.broadcast('ml_claim_opened', {
            claim_id: claimId,
            order_id,
            buyer: det?.buyer?.nickname || det?.buyer?.id || null,
            status: det?.status || null,
            stage: det?.stage || null,
            created_at: new Date().toISOString()
          });
        } catch (e) {
          console.warn('[ml-webhook] falha ao processar claim:', e?.message || e);
        }
      }

      res.json({ ok: true });
    } catch (e) {
      console.error('[ml-webhook] erro:', e);
      res.status(500).json({ ok:false, error:String(e.message || e) });
    }
  });

  app.use(router);
};
