// server/routes/ml-sync.js
'use strict';

const express = require('express');
const dayjs = require('dayjs');
const { query } = require('../db');
const { getAuthedAxios } = require('../mlClient');

const isTrue = (v) => ['1','true','yes','on','y'].includes(String(v || '').toLowerCase());
const qOf = (req) => (req?.q || query);
// formato aceito pelo ML nos filtros de range: 2025-10-22T12:34:56.789-0300
const fmtML = (d) => dayjs(d).format('YYYY-MM-DDTHH:mm:ss.SSSZZ');

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

  // -------- Claims Search robusto (com fallback + paginação) ----------

  // Tenta "v1:new" (range) e "v1:old" (date_created.from/to).
  // Se não retornar nada com date_created, tenta last_updated no mesmo range.
  async function fetchClaimsPaged(http, account, {
    fromIso, toIso, status, siteId, limitPerPage = 200, max = 2000
  }) {
    const used = [];

    const collect = [];
    let totalFetched = 0;

    // Estratégias a tentar em ordem:
    const strategies = [
      {
        label: 'v1:new/date_created',
        path: '/post-purchase/v1/claims/search',
        makeParams: (off) => ({
          player_role: 'seller',
          player_user_id: account.user_id,
          status,
          site_id: siteId || undefined,
          sort: 'date_created:desc',
          range: `date_created:after:${fmtML(fromIso)}:before:${fmtML(toIso)}`,
          limit: Math.min(limitPerPage, 200),
          offset: off
        })
      },
      {
        label: 'v1:old/date_created',
        path: '/post-purchase/v1/claims/search',
        makeParams: (off) => ({
          'seller.id': account.user_id,
          'date_created.from': fmtML(fromIso),
          'date_created.to': fmtML(toIso),
          status,
          site_id: siteId || undefined,
          sort: 'date_created:desc',
          limit: Math.min(limitPerPage, 200),
          offset: off
        })
      },
      {
        label: 'v1:new/last_updated',
        path: '/post-purchase/v1/claims/search',
        makeParams: (off) => ({
          player_role: 'seller',
          player_user_id: account.user_id,
          status,
          site_id: siteId || undefined,
          sort: 'last_updated:desc',
          range: `last_updated:after:${fmtML(fromIso)}:before:${fmtML(toIso)}`,
          limit: Math.min(limitPerPage, 200),
          offset: off
        })
      }
    ];

    for (const strat of strategies) {
      let offset = 0;
      let page = 0;
      let anyThisStrategy = false;
      try {
        while (totalFetched < max) {
          const params = strat.makeParams(offset);
          const { data } = await http.get(strat.path, { params });
          const arr = Array.isArray(data?.data) ? data.data : [];
          used.push({ status, page: page + 1, used: { path: strat.path, label: strat.label, params } });

          if (!arr.length) break;

          for (const it of arr) {
            collect.push(it);
            totalFetched++;
            if (totalFetched >= max) break;
          }

          anyThisStrategy = true;
          page++;
          offset += params.limit || arr.length;
        }
      } catch (e) {
        used.push({ status, page: page + 1, used: { path: strat.path, label: strat.label }, error: e?.response?.data || e?.message || String(e) });
      }

      // Se já trouxe algo com a estratégia atual, não precisa tentar as demais
      if (anyThisStrategy && collect.length) break;
    }

    return { items: collect, used };
  }

  // Detalhe do claim
  async function getClaimDetail(http, claimId) {
    const { data } = await http.get(`/post-purchase/v1/claims/${claimId}`);
    return data;
  }

  // Return (v2) vinculado ao claim
  async function getReturnV2ByClaim(http, claimId) {
    const { data } = await http.get(`/post-purchase/v2/claims/${claimId}/returns`);
    return data; // { id, status, resource_id, ... }
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

  // DEBUG — claims (amostra + params usados)
  router.get('/api/ml/claims/search-debug', async (req, res) => {
    try {
      const now = dayjs();
      const days = Math.max(1, parseInt(req.query.days || '7', 10) || 7);
      const fromIso = req.query.from ? dayjs(req.query.from).toISOString() : now.subtract(days, 'day').toISOString();
      const toIso   = req.query.to   ? dayjs(req.query.to).toISOString()   : now.toISOString();
      const status  = (req.query.status || 'opened').toLowerCase();
      const limit   = Math.min(parseInt(req.query.limit || '5', 10) || 5, 200);

      const { http, account } = await getAuthedAxios(req);
      const r = await fetchClaimsPaged(http, account, {
        fromIso, toIso, status, siteId: account.site_id, limitPerPage: limit, max: limit
      });

      res.json({
        ok: true,
        account: { user_id: account.user_id },
        status,
        limit,
        paging: { total: r.items.length, offset: 0, limit },
        used: r.used,
        sample: r.items.slice(0, limit)
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e?.response?.data || e?.message || String(e)) });
    }
  });

  // DEBUG — returns/search não existe
  router.get('/api/ml/returns/search-debug', (req, res) => {
    res.status(501).json({ ok: false, error: 'returns search is not provided by ML; use claims/search + /v2/claims/{claim_id}/returns' });
    return;
  });

  /**
   * Importa devoluções por meio dos claims (com fallback e paginação)
   * Query:
   *  - statuses=opened,in_progress   (padrão)
   *  - days=90  ou  from=YYYY-MM-DD&to=YYYY-MM-DD
   *  - max=2000                       (limite de itens para processar)
   *  - dry=1                          (não grava)
   *  - silent=1                       (menos logs)
   *  - debug=1                        (retorna erro bruto)
   */
  router.get('/api/ml/claims/import', async (req, res) => {
    const debug = isTrue(req.query.debug);
    try {
      const dry = isTrue(req.query.dry);
      const silent = isTrue(req.query.silent);
      const max = Math.max(1, parseInt(req.query.max || '2000', 10) || 2000);

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

      const statusList = String(req.query.statuses || req.query.status || 'opened,in_progress')
        .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

      const { http, account } = await getAuthedAxios(req);

      const paramsUsed = [];
      const claimMap = new Map();

      // Busca paginada por status
      for (const st of statusList) {
        const r = await fetchClaimsPaged(http, account, {
          fromIso, toIso, status: st, siteId: account.site_id, limitPerPage: 200, max
        });
        paramsUsed.push(...r.used);
        for (const it of r.items) {
          const id = it?.id || it?.claim_id;
          if (id && !claimMap.has(id)) claimMap.set(id, it);
          if (claimMap.size >= max) break;
        }
        if (claimMap.size >= max) break;
      }

      let processed = 0, created = 0, updated = 0, events = 0, errors = 0;
      const errors_detail = [];
      const total = claimMap.size;

      for (const [claimId, it] of claimMap.entries()) {
        try {
          const claimDet = await getClaimDetail(http, claimId);

          const hasReturn = Array.isArray(claimDet?.related_entities)
            ? claimDet.related_entities.includes('return') || claimDet.related_entities.includes('returns')
            : false;

          if (!hasReturn) continue;

          let ret;
          try {
            ret = await getReturnV2ByClaim(http, claimId);
          } catch (e) {
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

          const rawStatus = String(ret?.status || '').toLowerCase();
          const status = /delivered|cancelled|closed|finaliz/.test(rawStatus) ? 'encerrado' : 'pendente';

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
                return_status: rawStatus,
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
          from: fromIso, to: toIso, statuses: statusList, total, processed, updated, events, errors
        });
      }

      return res.json({
        ok: true,
        statuses: statusList,
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
