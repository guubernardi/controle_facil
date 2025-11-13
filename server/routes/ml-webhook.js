// server/routes/ml-webhook.js
'use strict';
const express = require('express');
const { query } = require('../db');
const { getAuthedAxios } = require('../mlClient');
const events = require('../events');

// ===== Motivo derivation helpers (local) =====
function normalizeKey(s=''){
  try{ return String(s||'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase(); }catch{ return String(s||'').toLowerCase(); }
}
const REASONKEY_TO_CANON = {
  product_defective:'produto_defeituoso',not_working:'produto_defeituoso',broken:'produto_defeituoso',
  damaged:'produto_danificado',damaged_in_transit:'produto_danificado',
  different_from_publication:'nao_corresponde',not_as_described:'nao_corresponde',wrong_item:'nao_corresponde',different_item:'nao_corresponde',missing_parts:'nao_corresponde',incomplete:'nao_corresponde',
  buyer_remorse:'arrependimento_cliente',changed_mind:'arrependimento_cliente',doesnt_fit:'arrependimento_cliente',size_issue:'arrependimento_cliente',
  not_delivered:'entrega_atrasada',shipment_delayed:'entrega_atrasada'
};
function canonFromCode(code){
  const c = String(code||'').toUpperCase(); if(!c) return null;
  const SPEC = { PDD9939:'arrependimento_cliente', PDD9904:'produto_defeituoso', PDD9905:'produto_danificado', PDD9906:'arrependimento_cliente', PDD9907:'entrega_atrasada', PDD9944:'produto_defeituoso' };
  if (SPEC[c]) return SPEC[c]; if (c === 'PNR') return 'entrega_atrasada'; if (c === 'CS') return 'arrependimento_cliente'; return null;
}
function canonFromText(text){
  if (!text) return null; const s = normalizeKey(String(text));
  if (/faltam\s+partes\s+ou\s+acess[oó]rios/.test(s)) return 'nao_corresponde';
  if (/(nao\s*(o\s*)?quer\s*mais|mudou\s*de\s*ideia|changed\s*mind|buyer\s*remorse|repentant|no\s*longer)/.test(s)) return 'arrependimento_cliente';
  if (/(tamanho|size|doesn.?t\s*fit|size\s*issue)/.test(s)) return 'arrependimento_cliente';
  if (/(defeit|nao\s*funciona|not\s*working|broken|quebrad|danific|avariad)/.test(s)) return 'produto_defeituoso';
  if (/(transporte|shipping\s*damage|carrier\s*damage)/.test(s)) return 'produto_danificado';
  if (/(diferent|descri[cç]ao|nao\s*correspond|wrong\s*item|not\s*as\s*described|different\s*from|produto\s*trocad|incomplet|faltando)/.test(s)) return 'nao_corresponde';
  if (/(nao\s*entreg|delayed|not\s*delivered|undelivered)/.test(s)) return 'entrega_atrasada';
  return null;
}

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

              // tenta localizar uma devolução já existente vinculada a esse claim
              let { returnId } = await (async () => ({ returnId: null }))();
              try {
                const { rows: found } = await query(
                  `SELECT id, tipo_reclamacao FROM devolucoes WHERE ml_claim_id = $1 OR claim_id = $1 ORDER BY id DESC LIMIT 1`,
                  [claimId]
                );
                if (found && found[0] && found[0].id) {
                  returnId = found[0].id;
                }
              } catch (e) { /* ignore */ }

              // cria/acha stub por order_id (se ainda não encontramos devolução)
              if (!returnId) {
                const stub = await ensureStubReturn(order_id);
                returnId = stub.returnId;
              }

              // tenta derivar um motivo canônico a partir do claim/retorno
              let tipoSug = null;
              try {
                const reasonKey = det?.reason_key || det?.reason?.key || null;
                const reasonId  = det?.reason_id || det?.reason?.id || null;
                const reasonName = det?.reason_name || det?.reason?.name || det?.reason?.description || null;
                if (reasonKey && REASONKEY_TO_CANON[reasonKey]) tipoSug = REASONKEY_TO_CANON[reasonKey];
                if (!tipoSug && reasonId) tipoSug = canonFromCode(reasonId);
                if (!tipoSug && reasonName) tipoSug = canonFromText(reasonName);
                if (!tipoSug && det?.problem_description) tipoSug = canonFromText(det.problem_description);
              } catch (e) { /* ignore */ }

              // grava evento somente se temos um return_id (stub ou real)
              if (returnId) {
                // se temos sugestão de tipo e a coluna existe, persiste (somente se vazio)
                try {
                  const col = await query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='devolucoes' AND column_name='tipo_reclamacao'");
                  if (col.rows.length && tipoSug) {
                    try {
                      await query(`UPDATE devolucoes SET tipo_reclamacao = $1 WHERE id = $2 AND (COALESCE(tipo_reclamacao,'') = '')`, [tipoSug, returnId]);
                    } catch (e) { /* ignore persistence errors */ }
                  }
                } catch (e) { /* ignore */ }

                // também garante ml_claim_id se ausente
                try {
                  await query(`UPDATE devolucoes SET ml_claim_id = COALESCE(NULLIF(ml_claim_id,''), $1) WHERE id = $2`, [claimId, returnId]);
                } catch (e) { /* ignore */ }

                const idemp = `ml-claim:${claimId}:${det?.status || det?.stage || 'unknown'}`;
                await query(
                  `
                  INSERT INTO return_events
                    (return_id, type, title, message, meta, created_by, created_at, idemp_key)
                  VALUES ($1, 'ml-webhook', 'Atualização de Claim', 'Webhook: claims', $2, 'ml-webhook', now(), $3)
                  ON CONFLICT (idemp_key) DO NOTHING
                  `,
                  [
                    returnId,
                    JSON.stringify({
                      claim_id: claimId,
                      status: det?.status || null,
                      stage: det?.stage || null,
                      subtype: det?.subtype || null
                    }),
                    idemp
                  ]
                );
              }

              // avisa o front por SSE (independe de ter returnId)
              events.broadcast('ml_claim_opened', {
                claim_id: claimId,
                order_id,
                return_id: returnId || null,
                tipo_reclamacao: typeof tipoSug !== 'undefined' ? tipoSug : null,
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
