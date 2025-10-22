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

  // tenta várias rotas e esquemas de parâmetros; devolve { data, pathUsed, paramsUsed }
  async function genericSearchWithFallback(http, paths, makeParamsList) {
    const lastErrors = [];
    for (const path of paths) {
      for (const { label, params } of makeParamsList) {
        try {
          const { data } = await http.get(path, { params });
          return { data, pathUsed: path, paramsUsed: label };
        } catch (e) {
          const st = e?.response?.status;
          const body = e?.response?.data;
          const txt = (body && JSON.stringify(body)) || e?.message || String(e);
          lastErrors.push({ path, label, status: st, error: txt });
          // tenta próximo par (path, params)
          continue;
        }
      }
    }
    const err = new Error('all_return_paths_failed');
    err.detail = lastErrors;
    throw err;
  }

  // CLAIMS: duas “gerações” de params
  async function searchClaims(http, account, { fromIso, toIso, limit }) {
    const paths = ['/post-purchase/v1/claims/search'];
    const makeParamsList = [
      { label: 'new', params: { player_role: 'seller', player_user_id: account.user_id, date_created: `${fromIso},${toIso}`, site_id: account.site_id || undefined, limit } },
      { label: 'old', params: { 'seller.id': account.user_id, 'date_created.from': fromIso, 'date_created.to': toIso, limit } },
    ];
    return genericSearchWithFallback(http, paths, makeParamsList);
  }

  // RETURNS: tenta múltiplas rotas conhecidas + duas gerações de params
  async function searchReturns(http, account, { fromIso, toIso, limit }) {
    const paths = [
      '/post-purchase/v1/returns/search', // algumas contas/sites
      '/returns/search'                   // outras contas/sites
    ];
    const makeParamsList = [
      { label: 'new', params: { player_role: 'seller', player_user_id: account.user_id, date_created: `${fromIso},${toIso}`, site_id: account.site_id || undefined, limit } },
      { label: 'oldA', params: { seller: account.user_id, 'date_created.from': fromIso, 'date_created.to': toIso, limit } },
      { label: 'oldB', params: { seller: account.user_id, 'creation_date.from': fromIso, 'creation_date.to': toIso, limit } },
    ];
    return genericSearchWithFallback(http, paths, makeParamsList);
  }

  // Detalhe de return: tenta duas rotas
  async function getReturnDetail(http, id) {
    const paths = [
      `/post-purchase/v1/returns/${id}`,
      `/returns/${id}`
    ];
    for (const p of paths) {
      try {
        const { data } = await http.get(p);
        return { data, pathUsed: p };
      } catch (_) { /* tenta próxima */ }
    }
    throw new Error(`return_detail_not_found:${id}`);
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

  // DEBUG — claims
  router.get('/api/ml/claims/search-debug', async (req, res) => {
    try {
      const now = dayjs();
      const days = Math.max(1, parseInt(req.query.days || '7', 10) || 7);
      const fromIso = req.query.from ? dayjs(req.query.from).toISOString() : now.subtract(days, 'day').toISOString();
      const toIso   = req.query.to   ? dayjs(req.query.to).toISOString()   : now.toISOString();

      const { http, account } = await getAuthedAxios(req);
      const r = await searchClaims(http, account, { fromIso, toIso, limit: 100 });

      res.json({ ok: true, kind: 'claims', account: { user_id: account.user_id }, ...r, from: fromIso, to: toIso });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e?.response?.data || e?.message || String(e)), detail: e?.detail });
    }
  });

  // DEBUG — returns
  router.get('/api/ml/returns/search-debug', async (req, res) => {
    try {
      const now = dayjs();
      const days = Math.max(1, parseInt(req.query.days || '7', 10) || 7);
      const fromIso = req.query.from ? dayjs(req.query.from).toISOString() : now.subtract(days, 'day').toISOString();
      const toIso   = req.query.to   ? dayjs(req.query.to).toISOString()   : now.toISOString();

      const { http, account } = await getAuthedAxios(req);
      const r = await searchReturns(http, account, { fromIso, toIso, limit: 100 });

      res.json({ ok: true, kind: 'returns', account: { user_id: account.user_id }, ...r, from: fromIso, to: toIso });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e?.response?.data || e?.message || String(e)), detail: e?.detail });
    }
  });

  /**
   * Importador unificado (claims + returns)
   *  - ?source=claims|returns|both  (padrão: both)
   *  - ?days=60  OU  ?from=YYYY-MM-DD&to=YYYY-MM-DD
   *  - ?silent=1 suprime logs no server
   *  - ?debug=1 retorna erro bruto do ML
   */
  router.get('/api/ml/claims/import', async (req, res) => {
    const debug = isTrue(req.query.debug);
    try {
      const dry = isTrue(req.query.dry);
      const silent = isTrue(req.query.silent);
      const source = (req.query.source || 'both').toLowerCase(); // claims | returns | both
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

      const { http, account } = await getAuthedAxios(req);

      const buckets = [];
      const usedParams = {};

      if (source === 'claims' || source === 'both') {
        const r = await searchClaims(http, account, { fromIso, toIso, limit: 100 });
        buckets.push({ kind: 'claims', payload: r.data });
        usedParams.claims = { path: r.pathUsed, params: r.paramsUsed };
      }
      if (source === 'returns' || source === 'both') {
        const r = await searchReturns(http, account, { fromIso, toIso, limit: 100 });
        buckets.push({ kind: 'returns', payload: r.data });
        usedParams.returns = { path: r.pathUsed, params: r.paramsUsed };
      }

      let processed = 0, created = 0, updated = 0, events = 0, errors = 0, total = 0;
      const errors_detail = [];

      for (const b of buckets) {
        const arr = Array.isArray(b.payload?.data || b.payload?.results)
          ? (b.payload.data || b.payload.results)
          : [];

        total += arr.length;

        for (const it of arr) {
          try {
            const claimId = it?.id || it?.claim_id || it?.return_id;
            if (!claimId) continue;

            let det, detPathUsed;
            if (b.kind === 'returns') {
              const d = await getReturnDetail(http, claimId);
              det = d.data; detPathUsed = d.pathUsed;
            } else {
              const { data } = await http.get(`/post-purchase/v1/claims/${claimId}`);
              det = data; detPathUsed = '/post-purchase/v1/claims/:id';
            }

            const order_id =
              normalizeOrderId(det?.resource_id) ||
              normalizeOrderId(det?.order_id)    ||
              normalizeOrderId(it?.resource_id)  ||
              normalizeOrderId(it?.order_id);

            if (!order_id) continue;

            const rawStatus = String(det?.status || it?.status || '').toLowerCase();
            let status;
            if (/rej|neg|cancel/.test(rawStatus)) status = 'rejeitado';
            else if (/approved|accept|authoriz/.test(rawStatus)) status = 'aprovado';
            else if (/closed|finaliz/.test(rawStatus)) status = 'encerrado';
            else status = 'pendente';

            const sku = normalizeSku(it, det);

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

            const idemp = `ml-${b.kind}:${claimId}:${order_id}`;
            if (!dry) {
              await addReturnEvent(req, {
                returnId,
                type: `ml-${b.kind}`,
                title: `${b.kind.slice(0,1).toUpperCase()+b.kind.slice(1)} ${claimId} (${status})`,
                message: 'Sincronizado pelo import',
                meta: { id: claimId, order_id, status_raw: rawStatus, kind: b.kind, detail_path: detPathUsed, usedParams },
                idemp_key: idemp
              });
              events++;
            }

            processed++;
          } catch (e) {
            errors++;
            errors_detail.push({
              kind: b.kind,
              item: typeof it?.id !== 'undefined' ? it.id : it,
              error: String(e?.response?.data || e?.message || e)
            });
          }
        }
      }

      if (!silent) {
        console.log('[ml-sync] import',
          { usedParams, from: fromIso, to: toIso, total, processed, updated, events, errors });
      }

      return res.json({
        ok: true,
        usedParams,
        from: fromIso,
        to: toIso,
        total,
        processed, created, updated, events, errors,
        errors_detail
      });

    } catch (e) {
      const detail = e?.response?.data || e?.message || String(e);
      if (debug) return res.status(500).json({ ok: false, error: detail, detail: e?.detail });
      return res.status(500).json({ ok: false, error: 'Falha ao importar' });
    }
  });

  app.use(router);
};
