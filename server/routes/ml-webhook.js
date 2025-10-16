// server/routes/ml-webhook.js
'use strict';
const express = require('express');
const { query } = require('../db');
const { getAuthedAxios } = require('../mlClient');
const events = require('../events');

/**
 * Tenta criar (ou achar) um stub de devolução por order_id.
 * Só cria quando ML_CREATE_STUB_RETURNS === 'true'.
 * Retorna { returnId|null, created:boolean }.
 */
async function ensureStubReturn(orderId) {
  if (!orderId) return { returnId: null, created: false };
  if (process.env.ML_CREATE_STUB_RETURNS !== 'true') {
    // apenas tenta achar existente
    const sel = await query(
      'SELECT id FROM devolucoes WHERE id_venda::text = $1 LIMIT 1',
      [String(orderId)]
    );
    return { returnId: sel.rows[0]?.id || null, created: false };
  }

  // 1) existe?
  const sel = await query(
    'SELECT id FROM devolucoes WHERE id_venda::text = $1 LIMIT 1',
    [String(orderId)]
  );
  if (sel.rows[0]?.id) {
    return { returnId: sel.rows[0].id, created: false };
  }

  // 2) cria stub mínimo
  const store = process.env.ML_STUB_DEFAULT_STORE || 'Mercado Livre';
  try {
    const ins = await query(
      `
      INSERT INTO devolucoes (id_venda, loja_nome, status, created_at)
      VALUES ($1, $2, 'pendente', now())
      RETURNING id
      `,
      [String(orderId), store]
    );
    return { returnId: ins.rows[0]?.id || null, created: true };
  } catch (e) {
    // Se a tabela/colunas não existirem, não bloqueia o webhook
    console.warn('[ml-webhook] falha ao criar stub:', e?.message || e);
    return { returnId: null, created: false };
  }
}

/** Parse do corpo raw com tolerância a content-type */
function safeParseBody(req) {
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : (req.body || '');
    if (raw && raw.trim().startsWith('{')) return JSON.parse(raw);
  } catch (_) { /* ignore */ }
  return {};
}

module.exports = function registerMlWebhook(app) {
  const router = express.Router();

  router.post(
    ['/webhooks/ml', '/webhooks/ml/:secret'],
    // aceita qualquer content-type sem quebrar
    express.raw({ type: '*/*', limit: '200kb' }),
    async (req, res) => {
      try {
        /* 1) Segurança opcional por segredo */
        if (process.env.ML_WEBHOOK_SECRET) {
          const want = process.env.ML_WEBHOOK_SECRET;
          const okPath = req.params?.secret === want;
          const okHead = req.headers['x-webhook-secret'] === want;
          const okQuery = req.query?.secret === want;
          if (!okPath && !okHead && !okQuery) {
            return res.status(401).json({ ok: false, error: 'unauthorized' });
          }
        }

        /* 2) Parse body seguro */
        const payload = safeParseBody(req);

        /* 3) Log bruto de auditoria (não quebra se tabela não existir) */
        try {
          await query(
            `INSERT INTO ml_webhook_log (topic, resource, user_id, headers, payload)
             VALUES ($1,$2,$3,$4,$5)`,
            [
              payload?.topic || null,
              payload?.resource || null,
              payload?.user_id || null,
              JSON.stringify(req.headers || {}),
              JSON.stringify(payload || {})
            ]
          );
        } catch (e) {
          console.warn('[ml-webhook] log falhou:', e?.message || e);
        }

        /* 4) Processamento – focamos em "claims" */
        if (payload.topic === 'claims' && payload.resource) {
          try {
            const claimId = String(payload.resource).replace(/.*\//, '').trim();
            if (claimId) {
              // precisa de conta ML conectada
              const { http } = await getAuthedAxios(payload.user_id);

              // detalhes da claim
              const { data: det } = await http.get(`/post-purchase/v1/claims/${claimId}`);

              // tenta extrair pedido/pack associado
              const order_id = String(det?.resource_id || det?.order_id || det?.pack_id || '').trim();

              // cria/acha stub (se habilitado via env)
              const { returnId } = await ensureStubReturn(order_id);

              // grava evento somente se temos um return_id (stub ou real)
              if (returnId) {
                const idemp = `ml-claim:${claimId}:${det?.status || det?.stage || 'unknown'}`;
                await query(
                  `
                  INSERT INTO return_events
                    (return_id, type, title, message, meta, created_by, created_at, idemp_key)
                  VALUES ($1, 'ml-webhook', 'Atualização de Claim', 'Webhook: claims', $2, 'ml-webhook', now(), $3)
                  ON CONFLICT (idemp_key) DO NOTHING
                  `,
                  [
                    JSON.stringify({
                      claim_id: claimId,
                      status: det?.status || null,
                      stage: det?.stage || null,
                      subtype: det?.subtype || null
                    }),
                    idemp
                  ].splice(0, 0, returnId) // insere returnId como primeiro arg
                );
              }

              // avisa o front por SSE (independe de ter returnId)
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
            console.warn('[ml-webhook] erro processando claim:', e?.message || e);
          }
        }

        /* 5) Resposta padrão */
        return res.json({ ok: true });
      } catch (e) {
        console.error('[ml-webhook] erro geral:', e);
        return res.status(500).json({ ok: false, error: String(e?.message || e) });
      }
    }
  );

  app.use(router);
};
