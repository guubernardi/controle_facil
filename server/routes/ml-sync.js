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

  // --------- ML helpers (v2 claims search + return por claim) ----------

  // /v2/claims/search — busca por status com paginação
  async function searchClaimsV2(http, { user_id }, { status, limit = 200, offset = 0 }) {
    const params = {
      'seller.id': user_id,
      status,
      limit,
      offset,
      sort: 'date_created:desc'
    };
    const { data } = await http.get('/v2/claims/search', { params });
    const list = Array.isArray(data?.results) ? data.results
              : Array.isArray(data?.data)    ? data.data
              : [];
    const paging = data?.paging || { total: list.length, limit, offset };
    return { list, paging, paramsUsed: params, raw: data };
  }

  // Detalhe do claim (v1) — útil para pegar item/sku e resource_id quando faltar
  async function getClaimDetail(http, claimId) {
    try {
      const { data } = await http.get(`/post-purchase/v1/claims/${claimId}`);
      return data;
    } catch {
      return null;
    }
  }

  // /post-purchase/v2/claims/{id}/returns
  async function getReturnByClaimV2(http, claimId) {
    const { data } = await http.get(`/post-purchase/v2/claims/${claimId}/returns`);
    if (!data) return null;
    if (Array.isArray(data)) return data[0] || null;
    return data;
  }

  // Mapeia status do return (ML) para status local
  function mapReturnStatus(retStatus = '') {
    const s = String(retStatus).toLowerCase();
    // Encerrado quando finalizado/cancelado/entregue
    if (/delivered|returned|cancelled|closed|finaliz/.test(s)) return 'encerrado';
    // Pendente para demais (em trânsito, postagem, etc.)
    return 'pendente';
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

  // DEBUG — claims v2 (sem range de datas; usa status + paginação)
  router.get('/api/ml/claims/search-debug', async (req, res) => {
    try {
      const status = (req.query.status || 'opened').toLowerCase();
      const limit  = Math.min(200, parseInt(req.query.limit || '50', 10) || 50);
      const offset = Math.max(0, parseInt(req.query.offset || '0', 10) || 0);

      const { http, account } = await getAuthedAxios(req);
      const r = await searchClaimsV2(http, account, { status, limit, offset });

      res.json({
        ok: true,
        account: { user_id: account.user_id },
        status, limit, offset,
        pageTotal: r.list.length,
        paging: r.paging,
        paramsUsed: r.paramsUsed,
        sample: r.list.slice(0, 3)
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e?.response?.data || e?.message || String(e)) });
    }
  });

  // DEBUG — returns/search não é suportado
  router.get('/api/ml/returns/search-debug', (req, res) => {
    res.status(501).json({ ok: false, error: 'returns search is not provided by ML; use claims/search + /v2/claims/{claim_id}/returns' });
    return;
  });

  /**
   * Importa devoluções a partir dos claims (v2)
   * Params:
   *  - ?statuses=opened,in_progress,closed   (default: opened,in_progress)
   *  - ?max=1000   (máximo de registros por status; default 1000)
   *  - ?silent=1   (menos logs)
   *  - ?dry=1      (não persiste)
   *  - ?debug=1    (retorna erro bruto)
   */
  router.get('/api/ml/claims/import', async (req, res) => {
    const debug = isTrue(req.query.debug);
    try {
      const dry    = isTrue(req.query.dry);
      const silent = isTrue(req.query.silent);

      const statuses = String(req.query.statuses || 'opened,in_progress')
        .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

      const maxPerStatus = Math.max(1, parseInt(req.query.max || '1000', 10) || 1000);
      const pageLimit = 200; // limite máximo da API
      const { http, account } = await getAuthedAxios(req);

      let processed = 0, updated = 0, events = 0, errors = 0, total = 0;
      const errors_detail = [];
      const paramsUsed = [];

      for (const st of statuses) {
        let offset = 0;
        let fetched = 0;

        while (fetched < maxPerStatus) {
          let list = [], paging = {};
          try {
            const r = await searchClaimsV2(http, account, { status: st, limit: pageLimit, offset });
            paramsUsed.push({ status: st, page: (offset / pageLimit) + 1, params: r.paramsUsed, paging: r.paging });
            list = r.list; paging = r.paging || {};
          } catch (e) {
            errors++;
            errors_detail.push({ kind: 'claims_search', status: st, error: String(e?.response?.data || e?.message || e) });
            break;
          }

          if (!Array.isArray(list) || list.length === 0) break;
          total += list.length;

          for (const it of list) {
            try {
              const claimId = it?.id || it?.claim_id;
              if (!claimId) continue;

              // busca o return vinculado ao claim
              const ret = await getReturnByClaimV2(http, claimId).catch(() => null);
              if (!ret) continue; // claim sem return

              // detalhe do claim só se necessário (para SKU/resource_id)
              let claimDet = null;
              if (!normalizeOrderId(ret?.resource_id) && !normalizeSku(it, null)) {
                claimDet = await getClaimDetail(http, claimId);
              }

              const order_id =
                normalizeOrderId(ret?.resource_id) ||
                normalizeOrderId(ret?.order_id)    ||
                normalizeOrderId(it?.resource_id)  ||
                normalizeOrderId(it?.order_id)     ||
                normalizeOrderId(claimDet?.resource_id);

              if (!order_id) continue;

              const status = mapReturnStatus(ret?.status);
              const sku = normalizeSku(it, claimDet);

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

              const idemp = `ml-returns:${claimId}:${order_id}`;
              if (!dry) {
                await addReturnEvent(req, {
                  returnId,
                  type: 'ml-returns',
                  title: `Return via Claim ${claimId} (${status})`,
                  message: 'Sincronizado pelo import (claims→returns)',
                  meta: { claim_id: claimId, order_id, return_id: ret?.id || null, return_status: ret?.status || null },
                  idemp_key: idemp
                });
                events++;
              }

              processed++;
            } catch (e) {
              errors++;
              errors_detail.push({
                kind: 'claim_item',
                error: String(e?.response?.data || e?.message || e),
                item: it?.id || it
              });
            }
          }

          fetched += list.length;
          if (list.length < pageLimit) break; // última página
          offset += pageLimit;
          if (fetched >= maxPerStatus) break;
        }
      }

      if (!silent) {
        console.log('[ml-sync] import (returns via claims v2)', { statuses, total, processed, updated, events, errors });
      }

      return res.json({
        ok: true,
        statuses,
        total,
        processed,
        updated,
        events,
        errors,
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
