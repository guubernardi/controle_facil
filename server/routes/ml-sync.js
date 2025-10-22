// server/routes/ml-sync.js
'use strict';

const express = require('express');
const dayjs = require('dayjs');
const { query } = require('../db');
const { getAuthedAxios } = require('../mlClient');

const isTrue = v => ['1','true','yes','on','y'].includes(String(v || '').toLowerCase());
const qOf = (req) => (req?.q || query);
// ML exige timezone com dois-pontos (ex: 2025-10-22T12:34:56.789-03:00)
const fmtML = (d) => dayjs(d).format('YYYY-MM-DDTHH:mm:ss.SSSZ');

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

  /* ----------------- ML: claims search + returns(v2) ------------------ */

  // faz 1 chamada ao /post-purchase/v1/claims/search com fallback de params (novos/antigos)
  async function oneClaimsPage(http, account, { status, fromIso, toIso, limit = 200, offset = 0 }) {
    const path = '/post-purchase/v1/claims/search';

    // params "novos" (funcionam hoje)
    const pNew = {
      player_role: 'seller',
      player_user_id: account.user_id,
      status,
      range: `date_created:after:${fmtML(fromIso)}:before:${fmtML(toIso)}`,
      sort: 'date_created:desc',
      limit,
      offset
    };

    try {
      const { data } = await http.get(path, { params: pNew });
      return { data, used: { path, label: 'v1:new', params: pNew } };
    } catch (e) {
      // tenta forma "antiga"
      const pOld = {
        'seller.id': account.user_id,
        status,
        'date_created.from': fmtML(fromIso),
        'date_created.to'  : fmtML(toIso),
        sort: 'date_created:desc',
        limit,
        offset
      };
      const { data } = await http.get(path, { params: pOld });
      return { data, used: { path, label: 'v1:old', params: pOld } };
    }
  }

  // pagina por todos os status pedidos, até um máximo de itens
  async function paginateClaims(http, account, { statuses, fromIso, toIso, limitPerPage = 200, max = 1000 }) {
    const out = [];
    const used = [];
    for (const status of statuses) {
      let offset = 0;
      while (out.length < max) {
        const { data, used: meta } = await oneClaimsPage(http, account, {
          status, fromIso, toIso, limit: limitPerPage, offset
        });
        used.push({ status, page: (offset/limitPerPage)+1, used: meta });

        const arr = Array.isArray(data?.data) ? data.data : [];
        if (!arr.length) break;

        out.push(...arr);
        if (arr.length < limitPerPage) break; // última página
        offset += limitPerPage;
      }
    }
    return { items: out.slice(0, max), used };
  }

  async function getClaimDetail(http, claimId) {
    const { data } = await http.get(`/post-purchase/v1/claims/${claimId}`);
    return data;
  }

  async function getReturnV2ByClaim(http, claimId) {
    const { data } = await http.get(`/post-purchase/v2/claims/${claimId}/returns`);
    return data;
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
      const limit   = Math.min(200, parseInt(req.query.limit || '5', 10) || 5);

      const { http, account } = await getAuthedAxios(req);
      const r = await oneClaimsPage(http, account, { status, fromIso, toIso, limit, offset: 0 });

      res.json({
        ok: true,
        account: { user_id: account.user_id },
        status,
        limit,
        paging: { total: Array.isArray(r.data?.data) ? r.data.data.length : 0, offset: 0, limit },
        used: r.used,
        sample: Array.isArray(r.data?.data) ? r.data.data.slice(0, limit) : []
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e?.response?.data || e?.message || String(e)) });
    }
  });

  // DEBUG — returns/search não existe no ML
  router.get('/api/ml/returns/search-debug', (_req, res) => {
    res.status(501).json({ ok: false, error: 'returns search is not provided by ML; use claims/search + /v2/claims/{claim_id}/returns' });
  });

  /**
   * Importa devoluções a partir dos claims
   * Query:
   *  - days=60  OU  from=YYYY-MM-DD&to=YYYY-MM-DD
   *  - statuses=opened,closed,in_progress  (default: opened,closed)
   *  - max=1000 (limite duro de itens)
   *  - dry=1 (não persiste), silent=1 (menos logs), debug=1 (erro bruto)
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

      const statuses = String(req.query.statuses || req.query.status || 'opened,closed')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);

      const max = Math.max(1, Math.min(5000, parseInt(req.query.max || '1000', 10) || 1000));
      const limitPerPage = 200;

      const { http, account } = await getAuthedAxios(req);

      // pagina claims de todos os status solicitados
      const pag = await paginateClaims(http, account, { statuses, fromIso, toIso, limitPerPage, max });
      const claims = pag.items;

      // de-dup por id (caso o mesmo claim apareça em >1 status)
      const map = new Map();
      for (const it of claims) {
        const id = it?.id || it?.claim_id;
        if (id && !map.has(id)) map.set(id, it);
      }

      let processed = 0, created = 0, updated = 0, events = 0, errors = 0;
      const errors_detail = [];

      for (const [claimId, it] of map.entries()) {
        try {
          const claimDet = await getClaimDetail(http, claimId);
          const hasReturn = Array.isArray(claimDet?.related_entities)
            ? (claimDet.related_entities.includes('return') || claimDet.related_entities.includes('returns'))
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

          const retStatus = String(ret?.status || '').toLowerCase();
          // mapeamento simples para nossos status
          let status = 'pendente';
          if (/delivered|closed|cancelled|canceled|finished/.test(retStatus)) status = 'encerrado';
          else if (/approved|authorized|accepted/.test(retStatus))          status = 'aprovado';
          else if (/rejected|denied|declined/.test(retStatus))               status = 'rejeitado';

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
          from: fromIso, to: toIso, total: map.size, processed, updated, events, errors,
          statuses, used: pag.used
        });
      }

      return res.json({
        ok: true,
        statuses,
        total: map.size,
        processed, created, updated, events, errors,
        paramsUsed: pag.used,
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
