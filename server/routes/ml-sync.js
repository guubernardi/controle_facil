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

  // Tenta buscar claims com o "modelo novo"; se falhar 400, tenta o "modelo antigo".
  async function fetchClaims(http, account, { fromIso, toIso, limit = 100 }) {
    const paramsNew = {
      player_role: 'seller',
      player_user_id: account.user_id,
      // alguns datacenters exigem um único parâmetro 'date_created' com intervalo
      date_created: `${fromIso},${toIso}`,
      site_id: account.site_id || undefined,
      limit
    };

    try {
      const { data } = await http.get('/post-purchase/v1/claims/search', { params: paramsNew });
      return { data, paramsUsed: 'new' };
    } catch (e) {
      const status = e?.response?.status;
      const msg = (e?.response?.data && JSON.stringify(e.response.data)) || e?.message || String(e);
      const isParamsError = status === 400 || /at least any of these filters/i.test(msg);
      if (!isParamsError) throw e;

      // fallback para o modelo antigo
      const paramsOld = {
        'seller.id': account.user_id,
        'date_created.from': fromIso,
        'date_created.to': toIso,
        limit
      };
      const { data } = await http.get('/post-purchase/v1/claims/search', { params: paramsOld });
      return { data, paramsUsed: 'old' };
    }
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

  // DEBUG: dump cru da busca (com fallback interno)
  router.get('/api/ml/claims/search-debug', async (req, res) => {
    try {
      const now = dayjs();
      const days = Math.max(1, parseInt(req.query.days || '7', 10) || 7);
      const fromIso = req.query.from ? dayjs(req.query.from).toISOString() : now.subtract(days, 'day').toISOString();
      const toIso   = req.query.to   ? dayjs(req.query.to).toISOString()   : now.toISOString();

      const { http, account } = await getAuthedAxios(req);
      const { data, paramsUsed } = await fetchClaims(http, account, { fromIso, toIso, limit: 100 });

      res.json({ ok: true, account: { user_id: account.user_id, site_id: account.site_id }, paramsUsed, from: fromIso, to: toIso, raw: data });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e?.response?.data || e?.message || String(e)) });
    }
  });

  router.get('/api/ml/claims/claim-debug', async (req, res) => {
    try {
      const id = req.query.id;
      if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
      const { http } = await getAuthedAxios(req);
      const { data } = await http.get(`/post-purchase/v1/claims/${id}`);
      res.json({ ok: true, raw: data });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e?.response?.data || e?.message || String(e)) });
    }
  });

  router.get('/api/ml/claims/import', async (req, res) => {
    const debug = isTrue(req.query.debug);
    try {
      const dry = isTrue(req.query.dry);
      const silent = isTrue(req.query.silent);
      const now = dayjs();

      // janela
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
      const { data: search, paramsUsed } = await fetchClaims(http, account, { fromIso, toIso, limit: 100 });

      const raw = Array.isArray(search?.data || search?.results)
        ? (search.data || search.results)
        : [];

      let processed = 0, created = 0, updated = 0, events = 0, errors = 0;
      const errors_detail = [];

      for (const it of raw) {
        try {
          const t = String(it?.type || it?.claim_type || '').toLowerCase();
          if (t && !t.includes('return')) continue;

          const claimId = it?.id || it?.claim_id;
          if (!claimId) continue;

          const { data: det } = await http.get(`/post-purchase/v1/claims/${claimId}`);

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
              meta: { claim_id: claimId, order_id, status_raw: statusRaw, paramsUsed },
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
          paramsUsed, from: fromIso, to: toIso, total: raw.length, processed, updated, events, errors
        });
      }

      return res.json({
        ok: true,
        paramsUsed,
        from: fromIso,
        to: toIso,
        total: raw.length,
        processed, created, updated, events, errors,
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
