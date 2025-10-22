// server/routes/ml-sync.js
'use strict';

const express = require('express');
const dayjs = require('dayjs');
const { query } = require('../db');
const { getAuthedAxios } = require('../mlClient');

const isTrue = v => ['1','true','yes','on','y'].includes(String(v || '').toLowerCase());
const qOf = (req) => (req?.q || query);
const fmtML = d => dayjs(d).format('YYYY-MM-DDTHH:mm:ss.SSSZZ'); // ex: 2025-10-22T12:34:56.789-0300

module.exports = function registerMlSync(app, opts = {}) {
  const router = express.Router();
  const externalAddReturnEvent = opts.addReturnEvent;

  /* ----------------------------- helpers ----------------------------- */

  function normalizeOrderId(v) {
    if (v == null) return null;
    if (typeof v === 'number' || typeof v === 'string') return String(v);
    if (typeof v === 'object') {
      if (v.id != null)          return String(v.id);
      if (v.number != null)      return String(v.number);
      if (v.order_id != null)    return String(v.order_id);
      if (v.resource_id != null) return String(v.resource_id);
      return null;
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
    if (typeof externalAddReturnEvent === 'function') {
      return externalAddReturnEvent({
        returnId, type, title, message, meta,
        createdBy: created_by, idempKey: idemp_key
      });
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
      if (String(e?.code) !== '23505') throw e; // ignora idempotência
    }
  }

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

  // Busca claims com filtros corretos (range + status + player)
  async function searchClaims(http, { user_id }, { fromIso, toIso, status = 'opened', limit = 100 }) {
    const params = {
      status,
      range: `date_created:after:${fmtML(fromIso)}:before:${fmtML(toIso)}`,
      player_role: 'seller',
      player_user_id: user_id,
      sort: 'date_created:desc',
      limit
    };
    const { data } = await http.get('/post-purchase/v1/claims/search', { params });
    return { data, paramsUsed: params };
  }

  // Detalhe do claim
  async function getClaimDetail(http, claimId) {
    const { data } = await http.get(`/post-purchase/v1/claims/${claimId}`);
    return data;
  }

  // Detalhe de returns (v2) por claim_id
  async function getReturnV2ByClaim(http, claimId) {
    const { data } = await http.get(`/post-purchase/v2/claims/${claimId}/returns`);
    return data; // contém id (return_id), status, resource_id, orders[], shipments[], etc.
  }

  /* ------------------------------- rotas ------------------------------ */

  router.get('/api/ml/ping', async (req, res) => {
    try {
      const { http, account } = await getAuthedAxios(req);
      const { data: me } = await http.get('/users/me');
      return res.json({
        ok: true,
        account: { user_id: account.user_id, nickname: account.nickname, site_id: account.site_id, expires_at: account.expires_at },
        me
      });
    } catch (e) {
      const detail = e?.response?.data || e?.message || String(e);
      return res.status(500).json({ ok: false, error: detail });
    }
  });

  // DEBUG — claims (mostra params usados e 1ª página)
  router.get('/api/ml/claims/search-debug', async (req, res) => {
    try {
      const now = dayjs();
      const days = Math.max(1, parseInt(req.query.days || '7', 10) || 7);
      const fromIso = req.query.from ? dayjs(req.query.from).toISOString() : now.subtract(days, 'day').toISOString();
      const toIso   = req.query.to   ? dayjs(req.query.to).toISOString()   : now.toISOString();
      const status  = (req.query.status || 'opened').toLowerCase();

      const { http, account } = await getAuthedAxios(req);
      const r = await searchClaims(http, account, { fromIso, toIso, status, limit: 100 });

      res.json({ ok: true, account: { user_id: account.user_id }, from: fromIso, to: toIso, paramsUsed: r.paramsUsed, total: Array.isArray(r.data?.data) ? r.data.data.length : 0, raw: r.data });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e?.response?.data || e?.message || String(e)) });
    }
  });

  // DEBUG — returns/search não é suportado: devolve aviso em vez de 500
  router.get('/api/ml/returns/search-debug', (req, res) => {
    res.status(501).json({ ok: false, error: 'returns search is not provided by ML; use claims/search + /v2/claims/{claim_id}/returns' });
  });

  /**
   * Importa devoluções a partir dos claims
   * Params:
   *  - ?days=60  OU  ?from=YYYY-MM-DD&to=YYYY-MM-DD
   *  - ?status=opened,closed  (default ambos)
   *  - ?silent=1  (menos logs)
   *  - ?dry=1     (não persiste)
   *  - ?debug=1   (revela erro bruto no body)
   */
  router.get('/api/ml/claims/import', async (req, res) => {
    const debug = isTrue(req.query.debug);
    try {
      const dry = isTrue(req.query.dry);
      const silent = isTrue(req.query.silent);

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

      const statusList = String(req.query.status || 'opened,closed')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);

      const { http, account } = await getAuthedAxios(req);

      // busca claims para cada status e de-duplica por claim id
      const claimMap = new Map();
      const paramsUsed = [];
      for (const st of statusList) {
        try {
          const r = await searchClaims(http, account, { fromIso, toIso, status: st, limit: 100 });
          paramsUsed.push({ status: st, params: r.paramsUsed });
          const arr = Array.isArray(r.data?.data) ? r.data.data : [];
          for (const it of arr) {
            const id = it?.id || it?.claim_id;
            if (!id) continue;
            if (!claimMap.has(id)) claimMap.set(id, it);
          }
        } catch (e) {
          // segue com os outros status
          paramsUsed.push({ status: st, error: e?.response?.data || e?.message || String(e) });
        }
      }

      let processed = 0, created = 0, updated = 0, events = 0, errors = 0, total = claimMap.size;
      const errors_detail = [];

      for (const [claimId, it] of claimMap.entries()) {
        try {
          // detalhe do claim para checar related_entities
          const claimDet = await getClaimDetail(http, claimId);
          const hasReturn = Array.isArray(claimDet?.related_entities)
            ? claimDet.related_entities.includes('return') || claimDet.related_entities.includes('returns')
            : false;

          if (!hasReturn) continue; // sem devolução

          // detalhe da devolução (v2) atrelada ao claim
          let ret;
          try {
            ret = await getReturnV2ByClaim(http, claimId);
          } catch (e) {
            // se não encontrar o v2, apenas sinaliza e segue
            errors++;
            errors_detail.push({ kind: 'return_v2', item: claimId, error: String(e?.response?.data || e?.message || e) });
            continue;
          }

          const order_id =
            normalizeOrderId(ret?.resource_id) ||
            normalizeOrderId(claimDet?.resource_id) ||
            normalizeOrderId(it?.resource_id) ||
            normalizeOrderId(it?.order_id);

          if (!order_id) continue;

          // status simplificado para nossa tabela (mantendo compat c/ valores antigos)
          const retStatus = String(ret?.status || '').toLowerCase();
          const status =
            /delivered|cancelled/.test(retStatus) ? 'encerrado' : 'pendente';

          const sku = normalizeSku(it, claimDet);

          // garante a devolução local
          const returnId = await ensureReturnByOrder(req, { order_id, sku, created_by: 'ml-sync' });

          if (!dry) {
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

          // evento idempotente
          const idemp = `ml-claim:${claimId}:${order_id}`;
          if (!dry) {
            await addReturnEvent(req, {
              returnId,
              type: 'ml-claim',
              title: `Claim ${claimId} (${status})`,
              message: 'Sincronizado pelo import',
              meta: {
                claim_id: claimId,
                order_id,
                return_id: ret?.id || null,
                return_status: retStatus,
                status_money: ret?.status_money || null
              },
              idemp_key: idemp
            });
            events++;
          }

          processed++;
        } catch (e) {
          errors++;
          errors_detail.push({
            kind: 'claim',
            item: claimId,
            error: String(e?.response?.data || e?.message || e)
          });
        }
      }

      if (!silent) {
        console.log('[ml-sync] import', {
          from: fromIso, to: toIso, total, processed, updated, events, errors, paramsUsed
        });
      }

      return res.json({
        ok: true,
        from: fromIso,
        to: toIso,
        total,
        processed, created, updated, events, errors,
        paramsUsed,
        errors_detail
      });

    } catch (e) {
      const detail = e?.response?.data || e?.message || String(e);
      if (debug) return res.status(500).json({ ok: false, error: detail });
      return res.status(500).json({ ok: false, error: 'Falha ao importar' });
    }
  });

  app.use(router);
};
