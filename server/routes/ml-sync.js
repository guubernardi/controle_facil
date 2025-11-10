// server/routes/ml-sync.js
'use strict';

const express = require('express');
const dayjs = require('dayjs');
const { query } = require('../db');
const { getAuthedAxios } = require('../mlClient');

const isTrue = (v) => ['1','true','yes','on','y'].includes(String(v || '').toLowerCase());
const qOf = (req) => (req?.q || query);
const fmtML = (d) => dayjs(d).format('YYYY-MM-DDTHH:mm:ss.SSSZZ');

module.exports = function registerMlSync(app, opts = {}) {
  const router = express.Router();
  const externalAddReturnEvent = opts.addReturnEvent;

  async function resolveMlAccounts(req) {
    if (typeof opts.listMlAccounts === 'function') return await opts.listMlAccounts(req);
    if (typeof getAuthedAxios.listAccounts === 'function') return await getAuthedAxios.listAccounts(req);
    const one = await getAuthedAxios(req);
    return [one];
  }

  /* ----------------------------- helpers ----------------------------- */

  // Normaliza IDs de claim (só dígitos; descarta inválidos)
  function normalizeClaimId(v) {
    if (v == null) return null;
    const m = String(v).match(/\d+/g);
    if (!m) return null;
    const id = m.join('');
    return id.length >= 6 ? id : null;
  }

  function normalizeOrderId(v) {
    if (v == null) return null;
    if (typeof v === 'number' || typeof v === 'string') return String(v);
    if (typeof v === 'object') {
      if (v.id != null)          return String(v.id);
      if (v.number != null)      return String(v.number);
      if (v.order_id != null)    return String(v.order_id);
      if (v.resource_id != null) return String(v.resource_id);
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

  // --------- NOVO: mapeamento correto de status logístico do retorno ---------
  function mapReturnStatus(ret) {
    const s = String(ret?.status || '').toLowerCase();

    // etiqueta gerada / aguardando postagem / pronto pra enviar → "preparou devolução"
    if (['to_be_sent', 'ready_to_ship', 'label_generated', 'label-generated'].includes(s)) {
      return 'pronto_envio';
    }

    // em trânsito / a caminho do CD
    if (['shipped', 'in_transit', 'to_be_received', 'on_the_way'].includes(s)) {
      return 'em_transito';
    }

    // chegou no CD
    if (['received', 'arrived'].includes(s)) return 'recebido_cd';

    // triagem/inspeção
    if (['in_review', 'under_review', 'inspection'].includes(s)) return 'em_inspecao';

    // encerrado/entregue/cancelado/reembolsado
    if (['cancelled', 'refunded', 'closed', 'delivered', 'finished'].includes(s)) return 'encerrado';

    return 'pendente';
  }

  // --------- NOVO: mapeamento do fluxo do claim para log_status ----------
  function mapClaimFlow(claim) {
    const t = String(claim?.type || '').toLowerCase();      // "mediations" ou "claim"
    const st = String(claim?.status || '').toLowerCase();   // opened | in_progress | closed
    const stage = String(claim?.stage || '').toLowerCase(); // claim | dispute | mediation

    if (t === 'mediations') {
      if (st === 'closed') return 'fechado';
      if (stage.includes('dispute')) return 'disputa';
      return 'mediacao';
    }

    if (st === 'opened')      return 'abriu_devolucao';
    if (st === 'in_progress') return 'em_analise';
    if (st === 'closed')      return 'fechado';

    return null;
  }

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
      if (String(e?.code) !== '23505') throw e; // ignora idempotência
    }
  }

  async function ensureReturnByOrder(req, { order_id, sku = null, loja_nome = null, created_by = 'ml-sync' }) {
    const q = qOf(req);
    const { rows } = await q(
      `SELECT id FROM devolucoes WHERE id_venda::text = $1 LIMIT 1`,
      [String(order_id)]
    );
    if (rows[0]?.id) return rows[0].id;

    const ins = await q(`
      INSERT INTO devolucoes (id_venda, sku, loja_nome, created_by)
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `, [String(order_id), sku || null, loja_nome || 'Mercado Livre', created_by]);

    const id = ins.rows[0].id;

    await addReturnEvent(req, {
      returnId: id,
      type: 'ml-sync',
      title: 'Criação por ML Sync',
      message: `Stub criado a partir da API do Mercado Livre (order ${order_id})`,
      meta: { order_id, loja_nome: loja_nome || 'Mercado Livre' },
      idemp_key: `ml-sync:create:${order_id}`
    });

    return id;
  }

  // -------- Claims Search robusto (com fallback + paginação) ----------
  async function fetchClaimsPaged(http, account, {
    fromIso, toIso, status, siteId, limitPerPage = 200, max = 2000
  }) {
    const used = [];
    const collect = [];
    let totalFetched = 0;

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
            // Sanitiza o claim id já na busca
            const raw = it?.id ?? it?.claim_id ?? it;
            const cid = normalizeClaimId(raw);
            if (!cid) continue;
            collect.push({ ...it, _norm_claim_id: cid });
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
      if (anyThisStrategy && collect.length) break;
    }

    return { items: collect, used };
  }

  async function getClaimDetail(http, claimId) {
    const { data } = await http.get(`/post-purchase/v1/claims/${claimId}`);
    return data;
  }

  async function getReturnV2ByClaim(http, claimId) {
    const { data } = await http.get(`/post-purchase/v2/claims/${claimId}/returns`);
    return data;
  }

  // --------- NOVO: detalhes de trocas (changes/replace) ----------
  async function getChangesByClaim(http, claimId) {
    const { data } = await http.get(`/post-purchase/v1/claims/${claimId}/changes`);
    const arr = Array.isArray(data?.data) ? data.data : [];
    return arr[0] || null;
  }

  async function getOrderDetail(http, orderId) {
    const { data } = await http.get(`/orders/${orderId}`);
    return data;
  }

  async function enrichReturnFromML(req, returnId) {
    const q = qOf(req);
    const { rows } = await q(
      `SELECT id, id_venda, loja_nome FROM devolucoes WHERE id = $1 LIMIT 1`,
      [returnId]
    );
    if (!rows[0]) throw new Error('Devolução não encontrada');

    const orderId = normalizeOrderId(rows[0].id_venda);
    if (!orderId) throw new Error('Devolução não possui número do pedido');

    const { http } = await getAuthedAxios(req);
    const order = await getOrderDetail(http, orderId);

    const buyer = order?.buyer || {};
    const buyerName =
      [buyer.first_name, buyer.last_name].filter(Boolean).join(' ').trim() ||
      buyer.nickname || null;

    const dataCompraIso = order?.date_created ? dayjs(order.date_created).toISOString() : null;

    let sku = null;
    const items = Array.isArray(order?.order_items) ? order.order_items : [];
    for (const it of items) {
      sku = normalizeSku(it, { item: it?.item }) || sku;
      if (sku) break;
    }

    await q(`
      UPDATE devolucoes
         SET cliente_nome = COALESCE($1, cliente_nome),
             data_compra  = COALESCE($2, data_compra),
             loja_nome    = COALESCE($3, loja_nome),
             sku          = COALESCE($4, sku),
             updated_at   = now()
       WHERE id = $5
    `, [buyerName, dataCompraIso, 'Mercado Livre', sku, returnId]);

    await addReturnEvent(req, {
      returnId,
      type: 'ml-sync',
      title: 'Enriquecido via ML',
      message: `Dados trazidos do pedido ${orderId}`,
      meta: { order_id: orderId },
      idemp_key: `ml-enrich:${returnId}:${orderId}`
    });

    return { ok: true, order_id: orderId };
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

      const accounts = await resolveMlAccounts(req);
      const { http, account } = accounts[0];

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

  // Stubs para evitar 404 no front enquanto não implementa
  router.get('/api/ml/shipping/sync', (_req, res) => {
    res.json({ ok: true, implemented: false, processed: 0, note: 'shipping sync not implemented yet' });
  });
  router.get('/api/ml/messages/sync', (_req, res) => {
    res.json({ ok: true, implemented: false, processed: 0, note: 'messages sync not implemented yet' });
  });

  /**
   * Importa devoluções por meio dos claims (com fallback e paginação)
   * Query:
   *  - statuses=opened,in_progress   (padrão)
   *  - days=90  ou  from=YYYY-MM-DD&to=YYYY-MM-DD
   *  - max=2000
   *  - dry=1, silent=1, debug=1
   *  - all=1  ← roda para todas as contas disponíveis
   */
  router.get('/api/ml/claims/import', async (req, res) => {
    const debug = isTrue(req.query.debug);
    try {
      const dry = isTrue(req.query.dry);
      const silent = isTrue(req.query.silent);
      const max = Math.max(1, parseInt(req.query.max || '2000', 10) || 2000);
      const wantAll = isTrue(req.query.all) || String(req.query.scope || 'all') === 'all';

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

      const accounts = wantAll ? await resolveMlAccounts(req) : [await getAuthedAxios(req)];

      let processed = 0, updated = 0, events = 0, errors = 0;
      const paramsUsed = [];
      const errors_detail = [];

      for (const acc of accounts) {
        const { http, account } = acc;
        const lojaNome = account?.nickname ? `Mercado Livre · ${account.nickname}` : 'Mercado Livre';

        const claimMap = new Map();
        for (const st of statusList) {
          const r = await fetchClaimsPaged(http, account, {
            fromIso, toIso, status: st, siteId: account.site_id, limitPerPage: 200, max
          });
          paramsUsed.push(...r.used.map(u => ({ ...u, account: account.user_id })));
          for (const it of r.items) {
            const cid = it._norm_claim_id || normalizeClaimId(it?.id || it?.claim_id);
            if (!cid) continue;
            if (!claimMap.has(cid)) claimMap.set(cid, it);
            if (claimMap.size >= max) break;
          }
          if (claimMap.size >= max) break;
        }

        for (const [claimId, it] of claimMap.entries()) {
          try {
            // Proteção contra "invalid_claim_id"
            if (!normalizeClaimId(claimId)) {
              errors++; errors_detail.push({ account: account.user_id, kind: 'claim', item: claimId, error: 'invalid_claim_id (normalized empty)' });
              continue;
            }

            let claimDet;
            try {
              claimDet = await getClaimDetail(http, claimId);
            } catch (e) {
              const errStr = e?.response?.data || e?.message || String(e);
              // se o ML devolveu invalid_claim_id, apenas registra e segue
              errors++; errors_detail.push({ account: account.user_id, kind: 'claim_detail', item: claimId, error: errStr });
              continue;
            }

            // somente processa se houver returns relacionados
            const hasReturn = Array.isArray(claimDet?.related_entities)
              ? (claimDet.related_entities.includes('return') || claimDet.related_entities.includes('returns'))
              : false;
            if (!hasReturn) continue;

            // Detecção de trocas (changes/replace) — quando houver a tag 'change'
            let troca = null;
            try {
              const hasChangeTag = Array.isArray(claimDet?.related_entities) && claimDet.related_entities.includes('change');
              if (hasChangeTag) {
                troca = await getChangesByClaim(http, claimId);
              }
            } catch (_) { /* ignora erros de changes */ }

            let ret;
            try {
              ret = await getReturnV2ByClaim(http, claimId);
            } catch (e) {
              errors++;
              errors_detail.push({ account: account.user_id, kind: 'return_v2', item: claimId, error: String(e?.response?.data || e?.message || e) });
              continue;
            }

            const order_id =
              normalizeOrderId(ret?.resource_id) ||
              normalizeOrderId(claimDet?.resource_id) ||
              normalizeOrderId(it?.resource_id) ||
              normalizeOrderId(it?.order_id);

            if (!order_id) continue;

            const statusDev = mapReturnStatus(ret);
            const statusLog = mapClaimFlow(claimDet);
            const sku = normalizeSku(it, claimDet);

            const returnId = await ensureReturnByOrder(req, {
              order_id,
              sku,
              loja_nome: lojaNome,
              created_by: 'ml-sync'
            });

            if (!dry) {
              await qOf(req)(
                `UPDATE devolucoes
                   SET status     = COALESCE($1, status),
                       log_status = COALESCE($2, log_status),
                       sku        = COALESCE($3, sku),
                       loja_nome  = CASE
                         WHEN (loja_nome IS NULL OR loja_nome = '' OR loja_nome = 'Mercado Livre')
                           THEN COALESCE($4, loja_nome)
                         ELSE loja_nome END,
                       updated_at = now()
                 WHERE id = $5`,
                [statusDev, statusLog, sku, lojaNome, returnId]
              );
              updated++;
            }

            const idemp = `ml-claim:${account.user_id}:${claimId}:${order_id}`;
            if (!dry) {
              const metaEv = {
                account_id: account.user_id,
                nickname: account.nickname,
                claim_id: claimId,
                order_id,
                return_id: ret?.id || null,
                return_status: String(ret?.status || ''),
                loja_nome: lojaNome
              };
              if (troca) {
                metaEv.change = {
                  status: troca.status,
                  type: troca.type,
                  new_orders_ids: Array.isArray(troca.new_orders_ids) ? troca.new_orders_ids : [],
                  new_shipments: Array.isArray(troca.new_orders_shipments) ? troca.new_orders_shipments.map(s => s.id) : []
                };
              }

              await addReturnEvent(req, {
                returnId,
                type: 'ml-claim',
                title: `Claim ${claimId} (${statusDev}${statusLog ? ` · ${statusLog}` : ''})`,
                message: troca ? 'Sincronizado (troca detectada)' : 'Sincronizado pelo import',
                meta: metaEv,
                idemp_key: idemp
              });
              events++;
            }

            processed++;
          } catch (e) {
            errors++;
            errors_detail.push({
              account: acc?.account?.user_id,
              kind: 'claim_loop',
              item: String(claimId),
              error: String(e?.response?.data || e?.message || e)
            });
          }
        }
      }

      if (!silent) {
        console.log('[ml-sync] import', {
          from: fromIso, to: toIso, statuses: statusList, processed, updated, events, errors
        });
      }

      // Sempre responde 200 (mesmo com erros parciais)
      return res.json({
        ok: true,
        from: fromIso,
        to: toIso,
        statuses: statusList,
        processed, updated, events, errors,
        paramsUsed,
        errors_detail
      });

    } catch (e) {
      const detail = e?.response?.data || e?.message || String(e);
      // Ainda assim, evita 400 no cliente — usa 200 com ok:false
      return res.json({ ok: false, error: detail });
    }
  });

  // Enriquecer uma devolução específica com dados do pedido do ML
  router.post('/api/ml/returns/:id/enrich', async (req, res) => {
    try {
      const { id } = req.params;
      const out = await enrichReturnFromML(req, id);
      return res.json({ ok: true, ...out });
    } catch (e) {
      const detail = e?.response?.data || e?.message || String(e);
      return res.status(500).json({ ok: false, error: detail });
    }
  });

  app.use(router);
};
