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
      // 1) Validação opcional de segredo (header OU querystring)
      const expected = (process.env.ML_WEBHOOK_SECRET || '').trim();
      if (expected) {
        const headerSecret = req.get('x-webhook-secret') || '';
        const querySecret  = (req.query?.secret ?? '').toString();
        const match = headerSecret === expected || querySecret === expected;
        if (!match) {
          console.warn('[ml-webhook] invalid secret', {
            from: req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip,
            hasHeader: !!headerSecret,
            hasQuery: !!querySecret
          });
          return res.status(401).json({ ok: false, error: 'invalid_secret' });
        }
      }

      // 2) Parsing seguro do body (sem estourar SyntaxError)
      let payload = {};
      try {
        const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : (req.body || '');
        payload = (raw && raw.trim().startsWith('{')) ? JSON.parse(raw) : {};
      } catch {
        // Mantém payload = {}
      }

      // 3) Processa apenas notificações de Claims (como no seu código original)
      if (payload.topic === 'claims' && payload.resource) {
        try {
          const claimId = String(payload.resource).replace(/.*\//,'').trim();
          if (claimId) {
            const { http } = await getAuthedAxios(payload.user_id); // exige conta conectada
            const { data: det } = await http.get(`/post-purchase/v1/claims/${claimId}`);

            const order_id = String(det?.resource_id || det?.order_id || det?.pack_id || '').trim();
            const idemp = `ml-claim:${claimId}:${det?.status || det?.stage || 'unknown'}`;

            await query(`
              INSERT INTO return_events
                (return_id, type, title, message, meta, created_by, created_at, idemp_key)
              SELECT d.id, 'ml-webhook', 'Atualização de Claim', 'Webhook: claims', $1, 'ml-webhook', now(), $2
              FROM devolucoes d
              WHERE d.id_venda::text = $3
              ON CONFLICT (idemp_key) DO NOTHING
            `, [
              JSON.stringify({
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

      // 4) Sempre ACK rápido
      return res.json({ ok: true });
    } catch (e) {
      console.error('[ml-webhook] erro:', e);
      return res.status(500).json({ ok:false, error:String(e.message || e) });
    }
  });

  app.use(router);
};
