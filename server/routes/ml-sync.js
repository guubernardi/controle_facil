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

  function jserr(e) {
    return JSON.stringify(e?.response?.data ?? e?.toJSON?.() ?? e?.message ?? String(e));
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

  /* ---------------------- buscas com fallback ------------------------ */

  // Extrai lista de claims em diferentes formatos
  function extractClaimsList(data) {
    if (Array.isArray(data?.results)) return data.results;
    if (Array.isArray(data?.data))    return data.data;
    if (Array.isArray(data))          return data;
    return [];
  }

  // Tenta várias rotas/params p/ claims.search (SEM range de datas)
  async function searchClaimsWithFallback(http, account, { status, limit = 200, offset = 0 }) {
    const tries = [
      {
        path: '/post-purchase/v1/claims/search',
        label: 'v1:new',
        params: {
          player_role: 'seller',
          player_user_id: account.user_id,
          status,
          site_id: account.site_id || undefined,
          sort: 'date_created:desc',
          limit, offset
        }
      },
      {
        path: '/post-purchase/v1/claims/search',
        label: 'v1:oldA',
        params: {
          'seller.id': account.user_id,
          status,
          sort: 'date_created:desc',
          limit, offset
        }
      },
      {
        path: '/post-purchase/v1/claims/search',
        label: 'v1:oldB',
        params: {
          seller: account.user_id,
          status,
          sort: 'date_created:desc',
          limit, offset
        }
      },
      {
        path: '/v2/claims/search',
        label: 'v2',
        params: {
          'seller.id': account.user_id,
          status,
          sort: 'date_created:desc',
          limit, offset
        }
      }
    ];

    const errors = [];
    for (const t of tries) {
      try {
        const { data } = await http.get(t.path, { params: t.params });
        const list = extractClaimsList(data);
        const paging = data?.paging || { total: list.length, limit, offset };
        return { list, paging, used: { path: t.path, label: t.label, params: t.params }, raw: data };
      } catch (e) {
        errors.push({ try: { path: t.path, label: t.label }, error: e?.response?.status, body: e?.response?.data || e?.message });
      }
    }
    const err = new Error('claims_search_failed');
    err.detail = errors;
    throw err;
  }

  // Detalhe do claim (v1)
  async function getClaimDetail(http, claimId) {
    const { data } = await http.get(`/post-purchase/v1/claims/${claimId}`);
    return data;
  }

  // Detalhe do return por claim — tenta múltiplas rotas
  async function getReturnByClaim(http, claimId) {
    const paths = [
      `/post-purchase/v2/claims/${claimId}/returns`,
      `/v2/claims/${claimId}/returns`,
      `/post-purchase/v1/claims/${claimId}/returns`
    ];
    const errs = [];
    for (const p of paths) {
      try {
        const { data } = await http.get(p);
        if (!data) continue;
        return { data: Array.isArray(data) ? (data[0] || null) : data, pathUsed: p };
      } catch (e) {
        errs.push({ path: p, status: e?.response?.status, body: e?.response?.data || e?.message });
      }
    }
    const err = new Error('return_by_claim_not_found');
    err.detail = errs;
    throw err;
  }

  function mapReturnStatus(s = '') {
    const v = String(s).toLowerCase();
    if (/delivered|returned|cancelled|closed|finaliz/.test(v)) return 'encerrado';
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
      return res.status(500).json({ ok: false, error: e?.response?.data || e?.message || String(e) });
    }
  });

  // DEBUG — claims.search com fallback
  router.get('/api/ml/claims/search-debug', async (req, res) => {
    try {
      const status = (req.query.status || 'opened').toLowerCase();
      const limit  = Math.min(200, parseInt(req.query.limit || '50', 10) || 50);
      const offset = Math.max(0, parseInt(req.query.offset || '0', 10) || 0);

      const { http, account } = await getAuthedAxios(req);
      const r = await searchClaimsWithFallback(http, account, { status, limit, offset });

      res.json({
        ok: true,
        account: { user_id: account.user_id },
        status, limit, offset,
        pageCount: r.list.length,
        paging: r.paging,
        used: r.used,
        sample: r.list.slice(0, 3)
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: jserr(e), detail: e?.detail });
    }
  });

  // DEBUG — returns/search não existe
  router.get('/api/ml/returns/search-debug', (req, res) => {
    res.status(501).json({ ok: false, error: 'returns search is not provided by ML; use claims/search + /claims/{claim_id}/returns' });
  });

  /**
   * Importa devoluções a partir dos claims (paginação por status)
   * Query:
   *  - ?statuses=opened,in_progress (default)
   *  - ?max=1000  (máx. por status)
   *  - ?silent=1  (menos logs)
   *  - ?dry=1     (não grava)
   *  - ?debug=1   (retorna erro bruto)
   */
  router.get('/api/ml/claims/import', async (req, res) => {
    const debug = isTrue(req.query.debug);
    try {
      const dry    = isTrue(req.query.dry);
      const silent = isTrue(req.query.silent);

      const statuses = String(req.query.statuses || 'opened,in_progress')
        .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

      const maxPerStatus = Math.max(1, parseInt(req.query.max || '1000', 10) || 1000);
      const pageLimit = 200;

      const { http, account } = await getAuthedAxios(req);

      let processed = 0, updated = 0, events = 0, errors = 0, total = 0;
      const errors_detail = [];
      const paramsUsed = [];

      for (const st of statuses) {
        let offset = 0, fetched = 0;

        while (fetched < maxPerStatus) {
          let list = [], used = null;
          try {
            const r = await searchClaimsWithFallback(http, account, { status: st, limit: pageLimit, offset });
            list = r.list; used = r.used;
            paramsUsed.push({ status: st, page: (offset / pageLimit) + 1, used });
          } catch (e) {
            errors++;
            errors_detail.push({ kind: 'claims_search', status: st, error: jserr(e), detail: e?.detail });
            break;
          }

          if (!Array.isArray(list) || list.length === 0) break;
          total += list.length;

          for (const it of list) {
            try {
              const claimId = it?.id || it?.claim_id;
              if (!claimId) continue;

              // tenta obter o return vinculado ao claim
              let ret, retPath;
              try {
                const r = await getReturnByClaim(http, claimId);
                ret = r.data; retPath = r.pathUsed;
                if (!ret) continue;
              } catch (e) {
                // sem return para esse claim — segue
                continue;
              }

              // SKU + order
              let claimDet = null;
              if (!normalizeOrderId(ret?.resource_id)) {
                try { claimDet = await getClaimDetail(http, claimId); } catch (_) {}
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
                  meta: { claim_id: claimId, order_id, return_id: ret?.id || null, return_status: ret?.status || null, ret_path: retPath, used },
                  idemp_key: idemp
                });
                events++;
              }

              processed++;
            } catch (e) {
              errors++;
              errors_detail.push({ kind: 'claim_item', error: jserr(e), item: it?.id || it });
            }
          }

          fetched += list.length;
          if (list.length < pageLimit) break;
          offset += pageLimit;
          if (fetched >= maxPerStatus) break;
        }
      }

      if (!silent) {
        console.log('[ml-sync] import (claims→returns)', { statuses, total, processed, updated, events, errors });
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
