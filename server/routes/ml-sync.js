// server/routes/ml-sync.js
'use strict';

const express = require('express');
const dayjs = require('dayjs');
const { query } = require('../db');
const { getAuthedAxios } = require('../mlClient');

const isTrue = v => ['1','true','yes','on'].includes(String(v || '').toLowerCase());
const qOf = (req) => (req?.q || query);

module.exports = function registerMlSync(app, opts = {}) {
  const router = express.Router();
  const externalAddReturnEvent = opts.addReturnEvent;

  // addReturnEvent com fallback (usa o injetado pelo server.js, senão insere local)
  async function addReturnEvent(req, {
    returnId, type, title = null, message = null, meta = null,
    created_by = 'ml-sync', idemp_key = null
  }) {
    if (typeof externalAddReturnEvent === 'function') {
      return externalAddReturnEvent({ returnId, type, title, message, meta, createdBy: created_by, idempKey: idemp_key });
    }
    const q = qOf(req);
    const metaStr = meta ? JSON.stringify(meta) : null;
    try {
      await q(`
        INSERT INTO return_events
          (return_id, type, title, message, meta, created_by, created_at, idemp_key)
        VALUES ($1,$2,$3,$4,$5,$6, now(), $7)
      `, [returnId, type, title, message, metaStr, created_by, idemp_key]);
    } catch (e) {
      // Se existir unique em idemp_key, ignoramos violação (23505)
      if (String(e?.code) !== '23505') throw e;
    }
  }

  // Garante uma devolução pelo id do pedido (order_id)
  async function ensureReturnByOrder(req, { order_id, sku = null, created_by = 'ml-sync' }) {
    const q = qOf(req);
    const { rows } = await q(
      `SELECT id FROM devolucoes WHERE id_venda::text = $1 LIMIT 1`,
      [String(order_id)]
    );
    if (rows[0]?.id) return rows[0].id;

    const ins = await q(`
      INSERT INTO devolucoes (id_venda, sku, loja_nome, created_by)
      VALUES ($1, $2, 'Mercado Livre', $3)
      RETURNING id
    `, [String(order_id), sku || null, created_by]);

    const id = ins.rows[0].id;

    await addReturnEvent(req, {
      returnId: id,
      type: 'ml-sync',
      title: 'Criação por ML Sync',
      message: `Stub criado a partir da API do Mercado Livre (order ${order_id})`,
      meta: { order_id },
      idemp_key: `ml-sync:create:${order_id}`
    });

    return id;
  }

  /**
   * Importa claims/devoluções do ML
   * Exemplos:
   *  GET /api/ml/claims/import
   *  GET /api/ml/claims/import?days=30
   *  GET /api/ml/claims/import?from=2025-10-01&to=2025-10-08
   *  GET /api/ml/claims/import?days=60&silent=1
   */
  router.get('/api/ml/claims/import', async (req, res) => {
    try {
      const dry = isTrue(req.query.dry);
      const silent = isTrue(req.query.silent);

      // Janela temporal
      let fromIso, toIso;
      const now = dayjs();

      if (req.query.from || req.query.to) {
        fromIso = req.query.from ? dayjs(req.query.from).toISOString() : now.subtract(7, 'day').toISOString();
        toIso   = req.query.to   ? dayjs(req.query.to).toISOString()   : now.toISOString();
      } else if (req.query.days) {
        const days = Math.max(1, parseInt(req.query.days, 10) || 7);
        fromIso = now.subtract(days, 'day').toISOString();
        toIso   = now.toISOString();
      } else {
        fromIso = now.subtract(7, 'day').toISOString();
        toIso   = now.toISOString();
      }

      // Axios autenticado scoped ao tenant/usuário atual
      // (getAuthedAxios aceita req para escolher a conta correta)
      const { http, account } = await getAuthedAxios(req);

      if (!account?.user_id) {
        throw new Error('Conta ML não encontrada ou sem user_id.');
      }

      // Busca claims do vendedor no intervalo
      const { data: search } = await http.get('/post-purchase/v1/claims/search', {
        params: {
          'seller.id': account.user_id,
          'date_created.from': fromIso,
          'date_created.to': toIso,
          limit: 100
        }
      });

      const raw = Array.isArray(search?.data || search?.results)
        ? (search.data || search.results)
        : [];

      let processed = 0, updated = 0, created = 0, events = 0, errors = 0;
      const errors_detail = [];

      for (const it of raw) {
        try {
          // Tipo do claim — mantemos só retornos
          const type = String(it?.type || it?.claim_type || '').toLowerCase();
          if (type && !type.includes('return')) continue;

          const claimId = it?.id || it?.claim_id;
          if (!claimId) continue;

          // Detalhes do claim
          const { data: det } = await http.get(`/post-purchase/v1/claims/${claimId}`);

          const order_id = det?.resource_id || det?.order_id || it?.resource_id || it?.order_id;
          if (!order_id) continue;

          const statusRaw = String(det?.status || it?.status || '').toLowerCase();
          const status =
            /closed|finalized/.test(statusRaw) ? 'encerrado'
            : /approved|accepted|authorized/.test(statusRaw) ? 'aprovado'
            : 'pendente';

          const sku =
            det?.item?.seller_sku ||
            det?.item?.sku ||
            it?.seller_sku ||
            null;

          // Garante existência da devolução
          const returnId = await ensureReturnByOrder(req, { order_id, sku, created_by: 'ml-sync' });

          if (!dry) {
            // Atualiza campos mínimos
            await qOf(req)(
              `UPDATE devolucoes
                 SET status = COALESCE($1, status),
                     sku    = COALESCE($2, sku),
                     updated_at = now()
               WHERE id = $3`,
              [status, sku, returnId]
            );
            updated++;
          }

          // Evento idempotente por claim
          const idemp = `ml-claim:${claimId}:${order_id}`;
          if (!dry) {
            await addReturnEvent(req, {
              returnId,
              type: 'ml-claim',
              title: `Claim ${claimId} (${status})`,
              message: 'Sincronizado pelo import',
              meta: { claim_id: claimId, order_id, status_raw: statusRaw },
              idemp_key: idemp
            });
            events++;
          }

          processed++;
        } catch (e) {
          errors++;
          errors_detail.push({
            item: it?.id || it,
            error: String(e?.response?.data || e?.message || e)
          });
        }
      }

      if (!silent) {
        console.log('[ml-sync] import',
          { from: fromIso, to: toIso, count: raw.length, processed, updated, events, errors });
      }

      return res.json({
        ok: true,
        from: fromIso,
        to: toIso,
        total: raw.length,
        processed,
        created,
        updated,
        events,
        errors,
        errors_detail
      });

    } catch (e) {
      console.error('[ml-sync] import error:', e);
      const reveal = String(process.env.REVEAL_ERRORS ?? 'false').toLowerCase() === 'true';
      const msg = reveal
        ? (e?.response?.data || e?.message || String(e))
        : 'Falha ao importar';
      return res.status(500).json({ ok: false, error: msg });
    }
  });

  app.use(router);
};
