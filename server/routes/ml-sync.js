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

  /* ============================ introspecção ============================ */
  async function tableExists(tbl) {
    const { rows } = await query(
      `SELECT 1 FROM information_schema.tables
        WHERE table_schema='public' AND table_name=$1`,
      [tbl]
    );
    return rows.length > 0;
  }

  async function tableHasColumns(table, cols) {
    const { rows } = await query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1`,
      [table]
    );
    const set = new Set(rows.map(r => r.column_name));
    const out = {}; cols.forEach(c => out[c] = set.has(c));
    return out;
  }

  async function resolveMlAccounts(req) {
    if (typeof opts.listMlAccounts === 'function') return await opts.listMlAccounts(req);
    if (typeof getAuthedAxios.listAccounts === 'function') return await getAuthedAxios.listAccounts(req);
    const one = await getAuthedAxios(req);
    return [one];
  }

  /* ============================== helpers ============================== */
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

  /* ---- rank de estágios para não “voltar” o log_status ---- */
  const STAGE_RANK = new Map([
    ['nao_recebido', 0],
    ['aguardando_postagem', 1],
    ['postado', 2],
    ['em_transito', 3],           // (sinônimo do seu "em_transporte" na UI)
    ['recebido_cd', 4],
    ['em_inspecao', 5],
    ['devolvido', 6],
    ['fechado', 7]
  ]);

  function betterStage(a, b) {
    const ra = STAGE_RANK.has(a) ? STAGE_RANK.get(a) : -1;
    const rb = STAGE_RANK.has(b) ? STAGE_RANK.get(b) : -1;
    return rb > ra; // true se b é mais avançado que a
  }

  /* ---------- claim/return -> log_status (como antes) ---------- */
  function mapReturnToLogStatus(retStatus, claimStatus, claimSub) {
    const rs  = String(retStatus || '').toLowerCase();
    const cs  = String(claimStatus || '').toLowerCase();
    const css = String(claimSub   || '').toLowerCase();

    if (['to_be_sent','shipped','to_be_received','in_transit'].includes(rs)) return 'em_transito';
    if (['received','arrived'].includes(rs)) return 'recebido_cd';
    if (['in_review','under_review','inspection'].includes(rs)) return 'em_inspecao';
    if (['cancelled','refunded','closed','delivered','finished'].includes(rs)) return 'fechado';

    if (/prep|prepar|embaland/.test(css)) return 'aguardando_postagem';
    if (/ready|etiq|label|pronto/.test(css)) return 'postado';
    if (/transit|transporte|enviado|out_for_delivery/.test(css)) return 'em_transito';
    if (/delivered|entreg|arrived|recebid/.test(css)) return 'recebido_cd';
    if (/closed|fechad/.test(cs)) return 'fechado';

    return null;
  }

  function isMediation(claimStatus, claimSub) {
    const s  = String(claimStatus || '').toLowerCase();
    const ss = String(claimSub    || '').toLowerCase();
    return /(media|mediati|mediac)/.test(s) || /(media|mediati|mediac)/.test(ss);
  }

  /* ---------- SHIPMENTS (ME1) ---------- */
  async function getOrderShipments(http, orderId) {
    const { data } = await http.get(`/orders/${orderId}/shipments`);
    // pode vir objeto ou array dependendo do endpoint; normaliza para array
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') return [data];
    return [];
  }

  // mapeia status/substatus do ME1 para o seu log_status
  function mapShipmentToLog(status, substatus) {
    const s  = String(status || '').toLowerCase();
    const ss = String(substatus || '').toLowerCase();

    // doc: shipped(null) | shipped(out_for_delivery) | delivered | not_delivered(returning_to_sender)
    if (s === 'shipped') return 'em_transito';                 // enviado / saiu para entrega
    if (s === 'delivered') return 'recebido_cd';               // entregue (para o comprador)
    if (s === 'not_delivered' && ss === 'returning_to_sender') return 'em_transito'; // voltando ao remetente
    // outros estados comuns do /shipments (fora do ME1 estrito):
    if (s === 'pending' || s === 'ready_to_ship') return 'postado';
    return null;
  }

  // Atualiza log_status pelos shipments (só avança estágio)
  async function syncShippingForOrder(req, returnId, orderId, http) {
    const q = qOf(req);
    const cols = await tableHasColumns('devolucoes', [
      'log_status','ml_shipment_id','ml_shipping_status','ml_shipping_substatus','ml_status_desc','updated_at'
    ]);

    const { rows: curRows } = await q(`SELECT log_status FROM devolucoes WHERE id=$1`, [returnId]);
    const current = curRows[0]?.log_status || null;

    const ships = await getOrderShipments(http, orderId);
    if (!ships.length) return { updated: false };

    // pega o mais recente (maior id ou último do array)
    const chosen = ships.slice().sort((a,b) => (Number(b.id||0) - Number(a.id||0)))[0];
    const s  = chosen?.status || null;
    const ss = chosen?.substatus || null;
    const mapped = mapShipmentToLog(s, ss);

    // guarda alguns campos descritivos
    const set = []; const vals = [];
    if (cols.ml_shipment_id && chosen?.id != null)      set.push(`ml_shipment_id=$${vals.push(String(chosen.id))}`);
    if (cols.ml_shipping_status)                        set.push(`ml_shipping_status=$${vals.push(s || null)}`);
    if (cols.ml_shipping_substatus)                     set.push(`ml_shipping_substatus=$${vals.push(ss || null)}`);
    if (cols.ml_status_desc) {
      const desc = [String(s||'').toLowerCase(), String(ss||'').toLowerCase()].filter(Boolean).join(':') || null;
      set.push(`ml_status_desc=$${vals.push(desc)}`);
    }

    // aplica log_status se for avanço
    if (cols.log_status && mapped && betterStage(current, mapped)) {
      set.push(`log_status=$${vals.push(mapped)}`);
    }
    if (!set.length) return { updated: false };

    if (cols.updated_at) set.push('updated_at=now()');
    vals.push(returnId);
    await q(`UPDATE devolucoes SET ${set.join(', ')} WHERE id=$${vals.length}`, vals);

    await addReturnEvent(req, {
      returnId,
      type: 'ml-shipping',
      title: `Envio ${chosen?.id || ''} — ${s}${ss ? `/${ss}`:''}`,
      message: 'Status de envio sincronizado (ME1)',
      meta: { shipment_id: chosen?.id || null, status: s, substatus: ss, mapped }
    });

    return { updated: true, mapped, raw: { status: s, substatus: ss, shipment_id: chosen?.id || null } };
  }

  /* ---------- eventos ---------- */
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

    let tbl = 'devolucao_eventos';
    if (!(await tableExists('devolucao_eventos')) && await tableExists('return_events')) {
      tbl = 'return_events';
    }

    const hasIdemp = await tableHasColumns(tbl, ['idemp_key']).then(c=>!!c.idemp_key).catch(()=>false);

    try {
      if (tbl === 'devolucao_eventos') {
        await q(
          `INSERT INTO devolucao_eventos (return_id, type, title, message, meta)
           VALUES ($1,$2,$3,$4,$5)`,
          [returnId, type, title, message, metaStr]
        );
      } else {
        await q(
          `INSERT INTO return_events
             (return_id, type, title, message, meta, created_by, created_at${hasIdemp?', idemp_key':''})
           VALUES ($1,$2,$3,$4,$5,$6, now()${hasIdemp?', $7':''})`,
          hasIdemp
            ? [returnId, type, title, message, metaStr, created_by, idemp_key]
            : [returnId, type, title, message, metaStr, created_by]
        );
      }
    } catch (e) {
      if (String(e?.code) !== '23505') throw e;
    }
  }

  /* ---------- criação/garantia de devolução ---------- */
  async function ensureReturnByOrder(req, { order_id, sku = null, loja_nome = null, created_by = 'ml-sync' }) {
    const q = qOf(req);

    const { rows } = await q(
      `SELECT id FROM devolucoes WHERE id_venda::text = $1 LIMIT 1`,
      [String(order_id)]
    );
    if (rows[0]?.id) return { id: rows[0].id, created: false };

    const possibleCols = ['id_venda','sku','loja_nome','created_by'];
    const cols = await tableHasColumns('devolucoes', possibleCols);

    const keys = ['id_venda'];
    const vals = [String(order_id)];
    if (cols.sku)       { keys.push('sku');       vals.push(sku || null); }
    if (cols.loja_nome) { keys.push('loja_nome'); vals.push(loja_nome || 'Mercado Livre'); }
    if (cols.created_by){ keys.push('created_by');vals.push(created_by); }

    const ph = keys.map((_,i)=>`$${i+1}`).join(',');
    const ins = await q(`INSERT INTO devolucoes (${keys.join(',')}) VALUES (${ph}) RETURNING id`, vals);

    const id = ins.rows[0].id;

    await addReturnEvent(req, {
      returnId: id,
      type: 'ml-sync',
      title: 'Criação por ML Sync',
      message: `Stub criado a partir da API do Mercado Livre (order ${order_id})`,
      meta: { order_id, loja_nome: loja_nome || 'Mercado Livre' },
      idemp_key: `ml-sync:create:${order_id}`
    });

    return { id, created: true };
  }

  /* ---------- ML calls “básicas” ---------- */
  async function getClaimDetail(http, claimId) {
    const { data } = await http.get(`/post-purchase/v1/claims/${claimId}`);
    return data;
  }

  async function getReturnV2ByClaim(http, claimId) {
    const { data } = await http.get(`/post-purchase/v2/claims/${claimId}/returns`);
    if (Array.isArray(data?.data)) return data.data[0] || null;
    if (Array.isArray(data)) return data[0] || null;
    return data || null;
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
    const buyerName = [buyer.first_name, buyer.last_name].filter(Boolean).join(' ').trim() || buyer.nickname || null;
    const dataCompraIso = order?.date_created ? dayjs(order.date_created).toISOString() : null;

    let sku = null;
    const items = Array.isArray(order?.order_items) ? order.order_items : [];
    for (const it of items) { sku = normalizeSku(it, { item: it?.item }) || sku; if (sku) break; }

    await q(
      `UPDATE devolucoes
          SET cliente_nome = COALESCE($1, cliente_nome),
              data_compra  = COALESCE($2, data_compra),
              loja_nome    = COALESCE($3, loja_nome),
              sku          = COALESCE($4, sku),
              updated_at   = now()
        WHERE id = $5`,
      [buyerName, dataCompraIso, 'Mercado Livre', sku, returnId]
    );

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

  /* ================================ rotas ================================ */

  router.get('/api/ml/ping', async (req, res) => {
    try {
      const { http, account } = await getAuthedAxios(req);
      const { data: me } = await http.get('/users/me');
      res.json({ ok: true, account: { user_id: account.user_id, nickname: account.nickname, site_id: account.site_id, expires_at: account.expires_at }, me });
    } catch (e) {
      const detail = e?.response?.data || e?.message || String(e);
      res.status(500).json({ ok: false, error: detail });
    }
  });

  // DEBUG claims
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

      const used = [];
      const r = await (async function fetchClaimsPaged(http, account, { fromIso, toIso, status, siteId, limitPerPage = 200, max = 2000 }) {
        const collect = [];
        const strategies = [
          { label:'v1:new/date_created', path:'/post-purchase/v1/claims/search',
            makeParams:(off)=>({ player_role:'seller', player_user_id:account.user_id, status, site_id:siteId||undefined, sort:'date_created:desc', range:`date_created:after:${fmtML(fromIso)}:before:${fmtML(toIso)}`, limit:Math.min(limitPerPage,200), offset:off }) },
          { label:'v1:old/date_created', path:'/post-purchase/v1/claims/search',
            makeParams:(off)=>({ 'seller.id':account.user_id, 'date_created.from':fmtML(fromIso), 'date_created.to':fmtML(toIso), status, site_id:siteId||undefined, sort:'date_created:desc', limit:Math.min(limitPerPage,200), offset:off }) }
        ];
        for (const strat of strategies) {
          let offset = 0, page = 0;
          while (true) {
            const params = strat.makeParams(offset);
            const { data } = await http.get(strat.path, { params });
            const arr = Array.isArray(data?.data) ? data.data : [];
            used.push({ status, page: page + 1, used: { path: strat.path, label: strat.label, params } });
            if (!arr.length) break;
            collect.push(...arr);
            if (collect.length >= limit) break;
            page++; offset += params.limit || arr.length;
          }
          if (collect.length) break;
        }
        return { items: collect, used };
      })(http, account, { fromIso, toIso, status, siteId: account.site_id, limitPerPage: limit, max: limit });

      res.json({ ok: true, account: { user_id: account.user_id }, status, limit, paging: { total: r.items.length, offset: 0, limit }, used: r.used, sample: r.items.slice(0, limit) });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e?.response?.data || e?.message || String(e)) });
    }
  });

  // Importa claims + sincroniza envio (ME1)
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

      let processed = 0, created = 0, updated = 0, events = 0, errors = 0;
      const paramsUsed = [];
      const errors_detail = [];

      for (const acc of accounts) {
        const { http, account } = acc;
        const lojaNome = account?.nickname ? `Mercado Livre · ${account.nickname}` : 'Mercado Livre';

        // ---- busca claims paginada por status
        const claimMap = new Map();
        const strategies = async ({ fromIso, toIso, status, siteId }) => {
          const localUsed = [];
          const collect = [];
          const sdefs = [
            { label:'v1:new/date_created', path:'/post-purchase/v1/claims/search',
              makeParams:(off)=>({ player_role:'seller', player_user_id:account.user_id, status, site_id:siteId||undefined, sort:'date_created:desc', range:`date_created:after:${fmtML(fromIso)}:before:${fmtML(toIso)}`, limit:200, offset:off }) },
            { label:'v1:old/date_created', path:'/post-purchase/v1/claims/search',
              makeParams:(off)=>({ 'seller.id':account.user_id, 'date_created.from':fmtML(fromIso), 'date_created.to':fmtML(toIso), status, site_id:siteId||undefined, sort:'date_created:desc', limit:200, offset:off }) },
            { label:'v1:new/last_updated', path:'/post-purchase/v1/claims/search',
              makeParams:(off)=>({ player_role:'seller', player_user_id:account.user_id, status, site_id:siteId||undefined, sort:'last_updated:desc', range:`last_updated:after:${fmtML(fromIso)}:before:${fmtML(toIso)}`, limit:200, offset:off }) },
          ];
          for (const strat of sdefs) {
            let offset = 0;
            while (collect.length < max) {
              const params = strat.makeParams(offset);
              const { data } = await http.get(strat.path, { params });
              const arr = Array.isArray(data?.data) ? data.data : [];
              localUsed.push({ status, used: { path: strat.path, label: strat.label, params } });
              if (!arr.length) break;
              collect.push(...arr);
              offset += params.limit || arr.length;
            }
            if (collect.length) break;
          }
          return { items: collect, used: localUsed };
        };

        for (const st of statusList) {
          const r = await strategies({ fromIso, toIso, status: st, siteId: account.site_id });
          paramsUsed.push(...r.used.map(u => ({ ...u, account: account.user_id })));
          for (const it of r.items) {
            const id = it?.id || it?.claim_id;
            if (id && !claimMap.has(id)) claimMap.set(id, it);
            if (claimMap.size >= max) break;
          }
          if (claimMap.size >= max) break;
        }

        for (const [claimId, it] of claimMap.entries()) {
          try {
            const claimDet = await getClaimDetail(http, claimId);
            let ret = null;
            try { ret = await getReturnV2ByClaim(http, claimId); }
            catch (e) {
              errors++; errors_detail.push({ account: account.user_id, kind: 'return_v2', item: claimId, error: String(e?.response?.data || e?.message || e) });
            }

            const order_id =
              normalizeOrderId(ret?.resource_id) ||
              normalizeOrderId(claimDet?.resource_id) ||
              normalizeOrderId(it?.resource_id) ||
              normalizeOrderId(it?.order_id);
            if (!order_id) continue;

            const logFromReturn = mapReturnToLogStatus(ret?.status, claimDet?.status, claimDet?.substatus);
            const sku = normalizeSku(it, claimDet);
            const emMediacao = isMediation(claimDet?.status, claimDet?.substatus);
            const mlStatusDesc = [String(claimDet?.status||'').toLowerCase(), String(claimDet?.substatus||'').toLowerCase()].filter(Boolean).join(':') || null;

            const ensured = await ensureReturnByOrder(req, {
              order_id, sku, loja_nome: lojaNome, created_by: 'ml-sync'
            });
            if (ensured.created) created++;

            if (!dry) {
              const cols = await tableHasColumns('devolucoes',
                ['log_status','sku','loja_nome','updated_at','ml_claim_id','ml_status_desc','em_mediacao']
              );
              const { rows: cur } = await query(`SELECT log_status FROM devolucoes WHERE id=$1`, [ensured.id]);
              const curLog = cur[0]?.log_status || null;

              const set = []; const vals = [];
              if (cols.sku && sku)               set.push(`sku=COALESCE($${vals.push(sku)}, sku)`);
              if (cols.loja_nome)                set.push(`loja_nome=CASE WHEN (loja_nome IS NULL OR loja_nome='' OR loja_nome='Mercado Livre') THEN $${vals.push(lojaNome)} ELSE loja_nome END`);
              if (cols.ml_claim_id)              set.push(`ml_claim_id=$${vals.push(String(claimId))}`);
              if (cols.ml_status_desc)           set.push(`ml_status_desc=$${vals.push(mlStatusDesc)}`);
              if (cols.em_mediacao)              set.push(`em_mediacao=$${vals.push(!!emMediacao)}`);
              if (cols.log_status && logFromReturn && betterStage(curLog, logFromReturn))
                                               set.push(`log_status=$${vals.push(logFromReturn)}`);
              if (cols.updated_at)               set.push('updated_at=now()');
              if (set.length) {
                vals.push(ensured.id);
                await qOf(req)(`UPDATE devolucoes SET ${set.join(', ')} WHERE id=$${vals.length}`, vals);
                updated++;
              }
            }

            // registra evento do claim
            const idemp = `ml-claim:${account.user_id}:${claimId}:${order_id}`;
            if (!dry) {
              await addReturnEvent(req, {
                returnId: ensured.id,
                type: 'ml-claim',
                title: `Claim ${claimId}${logFromReturn ? ` (${logFromReturn})` : ''}`,
                message: 'Sincronizado pelo import',
                meta: {
                  account_id: account.user_id,
                  nickname: account.nickname,
                  claim_id: claimId,
                  order_id,
                  return_id: ret?.id || null,
                  return_status: String(ret?.status || ''),
                  loja_nome: lojaNome,
                  ml_status_desc: mlStatusDesc,
                  em_mediacao: emMediacao
                },
                idemp_key: idemp
              });
              events++;
            }

            // ======== NOVO: sincroniza envios ME1 para este pedido ========
            if (!dry) {
              const shipSync = await syncShippingForOrder(req, ensured.id, order_id, http);
              if (shipSync.updated) updated++;
            }

            processed++;
          } catch (e) {
            errors++;
            errors_detail.push({
              account: acc?.account?.user_id,
              kind: 'claim',
              item: claimId,
              error: String(e?.response?.data || e?.message || e)
            });
          }
        }
      }

      if (!silent) {
        console.log('[ml-sync] import', { from: fromIso, to: toIso, statuses: statusList, processed, created, updated, events, errors });
      }

      res.json({
        ok: true,
        from: fromIso,
        to: toIso,
        statuses: statusList,
        processed, created, updated, events, errors,
        paramsUsed, errors_detail
      });
    } catch (e) {
      const detail = e?.response?.data || e?.message || String(e);
      if (debug) return res.status(500).json({ ok: false, error: detail });
      return res.status(500).json({ ok: false, error: 'Falha ao importar' });
    }
  });

  // Enriquecimento manual
  router.post('/api/ml/returns/:id/enrich', async (req, res) => {
    try {
      const { id } = req.params;
      const out = await enrichReturnFromML(req, id);
      res.json({ ok: true, ...out });
    } catch (e) {
      const detail = e?.response?.data || e?.message || String(e);
      res.status(500).json({ ok: false, error: detail });
    }
  });

  // ======= NOVO: sincronizar apenas o envio pelo order_id (debug/manual) =======
  router.post('/api/ml/orders/:order_id/shipments/sync', async (req, res) => {
    try {
      const orderId = String(req.params.order_id);
      const { rows } = await query(`SELECT id FROM devolucoes WHERE id_venda::text=$1 LIMIT 1`, [orderId]);
      if (!rows[0]?.id) return res.status(404).json({ ok:false, error:'Devolução não encontrada para este pedido' });

      const { http } = await getAuthedAxios(req);
      const out = await syncShippingForOrder(req, rows[0].id, orderId, http);
      res.json({ ok:true, ...out });
    } catch (e) {
      const detail = e?.response?.data || e?.message || String(e);
      res.status(500).json({ ok:false, error: detail });
    }
  });

  app.use(router);
};
