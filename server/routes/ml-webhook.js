// server/routes/ml-webhook.js
'use strict';
const express = require('express');
const { query } = require('../db');
const { getAuthedAxios } = require('../mlClient');
const events = require('../events'); // SSE

module.exports = function registerMlWebhook(app){
  const router = express.Router();

  // Aceita QUALQUER content-type e não quebra se o body não for JSON
  router.post('/webhooks/ml', express.raw({ type: '*/*', limit: '200kb' }), async (req, res) => {
    try {
      let payload = {};
      try {
        const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : (req.body || '');
        payload = (raw && raw.trim().startsWith('{')) ? JSON.parse(raw) : {};
      } catch {
        // Mantém payload = {}, não gera SyntaxError no log
      }

      // Processa apenas notificações de Claims
      if (payload.topic === 'claims' && payload.resource) {
        try {
          const claimId = String(payload.resource).replace(/.*\//,'').trim();
          if (claimId) {
            const { http } = await getAuthedAxios(); // exige conta conectada
            const { data: det } = await http.get(`/post-purchase/v1/claims/${claimId}`);

            const order_id = String(det?.resource_id || det?.order_id || det?.pack_id || '').trim();
            const idemp = `ml-claim:${claimId}:${det?.status || det?.stage || 'unknown'}`;

            await query(`
              insert into return_events (return_id, type, title, message, meta, created_by, created_at, idemp_key)
              select d.id, 'ml-webhook', 'Atualização de Claim', 'Webhook: claims', $1, 'ml-webhook', now(), $2
              from devolucoes d where d.id_venda::text = $3
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

            // Notifica front (SSE)
            events.broadcast('ml_claim_opened', {
              claim_id: claimId,
              order_id,
              buyer: det?.buyer?.nickname || det?.buyer?.id || null,
              status: det?.status || null,
              stage: det?.stage || null,
              created_at: new Date().toISOString()
            });
          }
        } catch (e) {
          console.warn('[ml-webhook] falha ao processar claim:', e?.message || e);
        }
      }

      return res.json({ ok: true });
    } catch (e) {
      console.error('[ml-webhook] erro:', e);
      return res.status(500).json({ ok:false, error:String(e.message || e) });
    }
  });

  app.use(router);
};
