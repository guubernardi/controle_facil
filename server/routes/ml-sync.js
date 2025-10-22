// server/routes/ml-sync.js
'use strict';

const express = require('express');
const dayjs = require('dayjs');
const { query } = require('../db');
const { getAuthedAxios } = require('../mlClient');

const isTrue = v => ['1','true','yes','on','y'].includes(String(v || '').toLowerCase());
const qOf = (req) => (req?.q || query);

module.exports = function registerMlSync(app, opts = {}) {
  const router = express.Router();
  const externalAddReturnEvent = opts.addReturnEvent;

  /* ----------------------------- helpers ----------------------------- */

  // cache em memória para saber se existe a coluna idemp_key
  let HAS_IDEMP_KEY_COL;

  async function hasIdempKeyColumn(req) {
    if (HAS_IDEMP_KEY_COL !== undefined) return HAS_IDEMP_KEY_COL;
    try {
      const r = await qOf(req)(`
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema='public'
           AND table_name='return_events'
           AND column_name='idemp_key'
         LIMIT 1
      `);
      HAS_IDEMP_KEY_COL = !!r.rows[0];
    } catch {
      HAS_IDEMP_KEY_COL = false;
    }
    return HAS_IDEMP_KEY_COL;
  }

  // Alguns payloads do ML podem trazer o "resource_id" como objeto (ex.: { id: 123 })
  function normalizeOrderId(v) {
    if (v == null) return null;
    if (typeof v === 'number' || typeof v === 'string') return String(v);
    if (typeof v === 'object') {
      if (v.id != null)         return String(v.id);
      if (v.order_id != null)   return String(v.order_id);
      if (v.resource_id != null)return String(v.resource_id);
      if (v.number != null)     return String(v.number);
    }
    return null;
  }

  function normalizeSku(it, det) {
    return (
      det?.item?.seller_sku ||
      det?.item?.sku ||
      it?.seller_sku ||
      it?.item?.seller_sku ||
      null
    );
  }

  async function addReturnEvent(req, {
    returnId, type, title = null, message = null, meta = null,
    created_by = 'ml-sync', idemp_key = null
  }) {
    // Se o server.js injetou a função oficial, usa ela
    if (typeof externalAddReturnEvent === 'function') {
      return externalAddReturnEvent({
        returnId, type, title, message, meta,
        createdBy: created_by, idempKey: idemp_key
      });
    }

    const q = qOf(req);
    const metaStr = meta ? JSON.stringify(meta) : null;
    const hasIdemp = await hasIdempKeyColumn(req);

    try {
      if (hasIdemp) {
        await q(`
          INSERT INTO return_events
            (return_id, type, title, message, meta, created_by, created_at, idemp_key)
          VALUES ($1,$2,$3,$4,$5,$6, now(), $7)
        `, [returnId, type, title, message, metaStr, created_by, idemp_key]);
      } else {
        await q(`
          INSERT INTO return_events
            (return_id, type, title, message, meta, created_by, created_at)
          VALUES ($1,$2,$3,$4,$5,$6, now())
        `, [returnId, type, title, message, metaStr, created_by]);
      }
    } catch (e) {
      // 23505 = conflito de unicidade (se existir unique em idemp_key)
      if (String(e?.code) !== '23505') throw e;
    }
  }

  // Garante a devolução pelo id_venda; id_venda pode ser BIGINT
  async function ensureReturnByOrder(req, { order_id, sku = null, created_by = 'ml-sync' }) {
    const q = qOf(req);
    const idTxt = String(order_id);

    const got = await q(
      `SELECT id FROM devolucoes WHERE id_venda::text = $1 LIMIT 1`,
      [idTxt]
    );
    if (got.rows[0]?.id) return got.rows[0].id;

    const ins = await q(`
      INSERT INTO devolucoes (id_venda, sku, loja_nome, created_by)
      VALUES ($1, $2, 'Mercado Livre', $3)
      RETURNING id
    `, [idTxt, sku || null, created_by]);

    const id = ins.rows[0].id;

    await addReturnEvent(req, {
      returnId: id,
      type: 'ml-sync',
      title: 'Criação por ML Sync',
      message: `Stub criado a partir da API do Mercado Livre (order ${idTxt})`,
      meta: { order_id: idTxt },
      idemp_key: `ml-sync:create:${idTxt}`
    });

    return id;
  }

  /* ------------------------------- rotas ------------------------------ */

  // Sanity-check: testa a conta ativa (ou a enviada em ?ml_account= / header x-ml-account)
  router.get('/api/ml/ping', async (req, res) => {
    try {
      const { http, account } = await getAuthedAxios(req);
      const { data: me } = await http.get('/users/me'); // endpoint simples autenticado
      return res.json({
        ok: true,
        account: { user_id: account.user_id, nickname: account.nickname, expires_at: account.expires_at },
        me
      });
    } catch (e) {
      const detail = e?.response?.data || e?.message || String(e);
      return res.status(500).json({ ok: false, error: detail });
    }
  });

  /**
   * Importa claims/devoluções do ML
   * Exemplos:
   *  GET /api/ml/claims/import
   *  GET /api/ml/claims/import?days=30
   *  GET /api/ml/claims/import?from=2025-10-01&to=2025-10-08
   *  GET /api/ml/claims/import?days=60&silent=1&debug=1
   *  GET /api/ml/claims/import?days=60&ml_account=1124956474
   */
  router.get('/api/ml/claims/import', async (req, res) => {
    const debug = isTrue(req.query.debug);
    try {
      const dry = isTrue(req.query.dry);
      const silent = isTrue(req.query.silent);

      // Janela temporal
      const now = dayjs();
      let fromIso, toIso;

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

      // Axios autenticado (conta ativa ou forçada por req)
      const { http, account } = await getAuthedAxios(req);

      // Busca claims do vendedor no intervalo
      const { data: search } = await http.get('/post-purchase/v1/claims/search', {
        params: {
          'seller.id': account.user_id,
          'date_created.from': fromIso,
          'date_created.to'  : toIso,
          limit: 100
        }
      });

      const raw = Array.isArray(search?.data || search?.results)
        ? (search.data || search.results)
        : [];

      let processed = 0, created = 0, updated = 0, events = 0, errors = 0;
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

          // Normaliza order_id (evita [object Object] no BIGINT)
          const order_id =
            normalizeOrderId(det?.resource_id) ||
            normalizeOrderId(det?.order_id)    ||
            normalizeOrderId(it?.resource_id)  ||
            normalizeOrderId(it?.order_id);

          if (!order_id) continue;

          const statusRaw = String(det?.status || it?.status || '').toLowerCase();
          const status =
            /closed|finalized/.test(statusRaw)             ? 'encerrado' :
            /approved|accepted|authorized/.test(statusRaw) ? 'aprovado'  :
            'pendente';

          const sku = normalizeSku(it, det);

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
            item: typeof it?.id !== 'undefined' ? it.id : it,
            error: String(e?.response?.data || e?.message || e)
          });
        }
      }

      if (!silent) {
        console.log('[ml-sync] import', {
          from: fromIso, to: toIso, total: raw.length, processed, updated, events, errors
        });
      }

      return res.json({
        ok: true,
        from: fromIso,
        to: toIso,
        total: raw.length,
        processed, created, updated, events, errors,
        errors_detail
      });

    } catch (e) {
      const detail = e?.response?.data || e?.message || String(e);
      if (debug) {
        return res.status(500).json({ ok: false, error: detail });
      }
      return res.status(500).json({ ok: false, error: 'Falha ao importar' });
    }
  });

  app.use(router);
};
