// server/routes/ml-sync.js
'use strict';

const express = require('express');
const dayjs   = require('dayjs');
const { query } = require('../db');
const { getAuthedAxios } = require('../mlClient');

const isTrue = (v) => ['1','true','yes','on','y'].includes(String(v || '').toLowerCase());
const qOf    = (req) => (req?.q || query);
// formato aceito pelo ML nos filtros de range: 2025-10-22T12:34:56.789-0300
const fmtML  = (d) => dayjs(d).format('YYYY-MM-DDTHH:mm:ss.SSSZZ');

/** Helper genérico para testar colunas de uma tabela (usa pool global) */
async function tableHasColumns(table, cols) {
  const { rows } = await query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = $1`,
    [table]
  );
  const set = new Set(rows.map(r => r.column_name));
  const out = {};
  for (const c of cols) out[c] = set.has(c);
  return out;
}

// cache simples para saber se devolucoes tem tenant_id
let HAS_TENANT_COL = null;

module.exports = function registerMlSync(app, opts = {}) {
  const router = express.Router();
  const externalAddReturnEvent = opts.addReturnEvent;

  // tenta descobrir todas as contas do ML disponíveis
  async function resolveMlAccounts(req) {
    if (typeof opts.listMlAccounts === 'function') {
      // esperado: retorna [{ http, account }, ...]
      return await opts.listMlAccounts(req);
    }
    if (typeof getAuthedAxios.listAccounts === 'function') {
      return await getAuthedAxios.listAccounts(req);
    }
    // fallback: conta atual apenas
    const one = await getAuthedAxios(req);
    return [one];
  }

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

  // pega um claimId seguro (somente numérico > 0)
  function selectClaimId(it) {
    const candidates = [
      it?.id,
      it?.claim_id,
      it?.claim?.id,
      // às vezes vem como string; strip não-dígitos:
      typeof it?.id === 'string' ? it.id.replace(/\D/g, '') : null,
      typeof it?.claim_id === 'string' ? it.claim_id.replace(/\D/g, '') : null,
    ].filter(Boolean);

    for (const c of candidates) {
      const n = Number(String(c));
      if (Number.isFinite(n) && n > 0) return String(n);
    }
    return null;
  }

  function isInvalidClaimIdError(err) {
    const data = err?.response?.data;
    const msg  = (data && (data.error || data.message)) || err?.message || '';
    return /invalid[_-]?claim[_-]?id/i.test(String(msg));
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

  /**
   * Garante que exista uma devolução para o order_id.
   * Se a tabela tiver tenant_id, procura primeiro pelo tenant atual; se não achar,
   * "adota" registros órfãos (tenant_id IS NULL) para o tenant atual; por fim, cria.
   */
  async function ensureReturnByOrder(req, {
    order_id,
    sku = null,
    loja_nome = null,
    created_by = 'ml-sync' // hoje só vai pro evento, não pra tabela
  }) {
    const q = qOf(req);
    const orderIdStr = String(order_id);

    // descobre tenant atual (se existir)
    const tenantId = req.session?.user?.tenant_id || req.tenant?.id || null;

    // descobre se existe coluna tenant_id (cacheada)
    if (HAS_TENANT_COL === null) {
      const cols = await tableHasColumns('devolucoes', ['tenant_id']);
      HAS_TENANT_COL = !!cols.tenant_id;
    }

    // 1) Se temos coluna e tenant, tenta achar do tenant
    if (HAS_TENANT_COL && tenantId) {
      const r1 = await q(
        `SELECT id, tenant_id
           FROM devolucoes
          WHERE id_venda::text = $1
            AND tenant_id = $2
          LIMIT 1`,
        [orderIdStr, tenantId]
      );
      if (r1.rows[0]?.id) return r1.rows[0].id;

      // 2) Não tem pro tenant? tenta achar órfão e "adota"
      const rOrf = await q(
        `SELECT id, tenant_id
           FROM devolucoes
          WHERE id_venda::text = $1
            AND tenant_id IS NULL
          LIMIT 1`,
        [orderIdStr]
      );
      if (rOrf.rows[0]?.id) {
        try {
          await q(
            `UPDATE devolucoes
                SET tenant_id = $1, updated_at = now()
              WHERE id = $2`,
            [tenantId, rOrf.rows[0].id]
          );
        } catch (_) { /* se houver constraint/erro, seguimos */ }
        return rOrf.rows[0].id;
      }
    } else {
      // Compat antigo: sem coluna tenant_id
      const rAny = await q(
        `SELECT id
           FROM devolucoes
          WHERE id_venda::text = $1
          LIMIT 1`,
        [orderIdStr]
      );
      if (rAny.rows[0]?.id) return rAny.rows[0].id;
    }

    // 3) Não achou: cria (com tenant quando possível)
    let ins;
    if (HAS_TENANT_COL && tenantId) {
      ins = await q(`
        INSERT INTO devolucoes (id_venda, sku, loja_nome, tenant_id)
        VALUES ($1, $2, $3, $4)
        RETURNING id
      `, [orderIdStr, sku || null, loja_nome || 'Mercado Livre', tenantId]);
    } else {
      ins = await q(`
        INSERT INTO devolucoes (id_venda, sku, loja_nome)
        VALUES ($1, $2, $3)
        RETURNING id
      `, [orderIdStr, sku || null, loja_nome || 'Mercado Livre']);
    }

    const id = ins.rows[0].id;

    await addReturnEvent(req, {
      returnId: id,
      type: 'ml-sync',
      title: 'Criação por ML Sync',
      message: `Stub criado a partir da API do Mercado Livre (order ${orderIdStr})`,
      meta: { order_id: orderIdStr, loja_nome: loja_nome || 'Mercado Livre' },
      idemp_key: `ml-sync:create:${orderIdStr}`
    });

    return id;
  }

  // ===== Mapeamentos compatíveis com a UI =====
  // Status do "return v2" → token do fluxo reconhecido pelo front
  function mapFlowFromReturn(retStatusRaw) {
    const s = String(retStatusRaw || '').toLowerCase();

    // to_be_sent → etiqueta emitida aguardando postagem
    if (s === 'to_be_sent') return 'aguardando_postagem';

    // shipped / in_transit / to_be_received → em trânsito
    if (s === 'shipped' || s === 'in_transit' || s === 'to_be_received') return 'em_transito';

    // received / arrived / delivered → recebido no CD (fim logístico)
    if (s === 'received' || s === 'arrived' || s === 'delivered') return 'recebido_cd';

    // cancelled / refunded / closed / not_delivered / returned_to_sender → fluxo encerrado
    if (s === 'cancelled' || s === 'refunded' || s === 'closed' || s === 'not_delivered' || s === 'returned_to_sender') return 'fechado';

    // inspeção / revisão não mapeiam diretamente no pipeline logístico
    if (s === 'in_review' || s === 'under_review' || s === 'inspection') return 'aguardando_postagem';

    return 'pendente';
  }

  // Deriva um "status" interno a partir do fluxo (coerente com badges internas)
  function mapInternalStatusFromFlow(flow) {
    if (flow === 'fechado' || flow === 'recebido_cd') return 'finalizado';
    if (flow === 'em_transito' || flow === 'aguardando_postagem') return 'aprovado';
    return 'pendente';
  }

  // ===== Motivo derivation (canonical) =====
  function normalizeKeyLocal(s = '') {
    try {
      return String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
    } catch {
      return String(s || '').toLowerCase();
    }
  }

  const REASONKEY_TO_CANON_LOCAL = {
    product_defective: 'produto_defeituoso', not_working: 'produto_defeituoso', broken: 'produto_defeituoso',
    damaged: 'produto_danificado', damaged_in_transit: 'produto_danificado',
    different_from_publication: 'nao_corresponde', not_as_described: 'nao_corresponde', wrong_item: 'nao_corresponde', different_item: 'nao_corresponde', missing_parts: 'nao_corresponde', incomplete: 'nao_corresponde',
    buyer_remorse: 'arrependimento_cliente', changed_mind: 'arrependimento_cliente', doesnt_fit: 'arrependimento_cliente', size_issue: 'arrependimento_cliente',
    not_delivered: 'entrega_atrasada', shipment_delayed: 'entrega_atrasada'
  };

  function canonFromCodeLocal(code) {
    const c = String(code || '').toUpperCase();
    if (!c) return null;
    const SPEC = {
      PDD9939: 'arrependimento_cliente',
      PDD9904: 'produto_defeituoso',
      PDD9905: 'produto_danificado',
      PDD9906: 'arrependimento_cliente',
      PDD9907: 'entrega_atrasada',
      PDD9944: 'produto_defeituoso'
    };
    if (SPEC[c]) return SPEC[c];
    if (c === 'PNR') return 'entrega_atrasada';
    if (c === 'CS')  return 'arrependimento_cliente';
    return null;
  }

  function canonFromTextLocal(text) {
    if (!text) return null;
    const s = normalizeKeyLocal(String(text));
    if (/faltam\s+partes\s+ou\s+acess[oó]rios/.test(s)) return 'nao_corresponde';
    if (/(nao\s*(o\s*)?quer\s*mais|mudou\s*de\s*ideia|changed\s*mind|buyer\s*remorse|repentant|no\s*longer)/.test(s)) return 'arrependimento_cliente';
    if (/(tamanho|size|doesn.?t\s*fit|size\s*issue)/.test(s)) return 'arrependimento_cliente';
    if (/(defeit|nao\s*funciona|not\s*working|broken|quebrad|danific|avariad)/.test(s)) return 'produto_defeituoso';
    if (/(transporte|shipping\s*damage|carrier\s*damage)/.test(s)) return 'produto_danificado';
    if (/(diferent|descri[cç]ao|nao\s*correspond|wrong\s*item|not\s*as\s*described|different\s*from|produto\s*trocad|incomplet|faltando)/.test(s)) return 'nao_corresponde';
    if (/(nao\s*entreg|delayed|not\s*delivered|undelivered)/.test(s)) return 'entrega_atrasada';
    return null;
  }

  // -------- Claims Search robusto (com fallback + paginação) ----------
  async function fetchClaimsPaged(http, account, {
    fromIso, toIso, status, siteId, limitPerPage = 200, max = 2000
  }) {
    const used    = [];
    const collect = [];
    let totalFetched = 0;

    const strategies = [
      {
        label: 'v1:new/date_created',
        path:  '/post-purchase/v1/claims/search',
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
        path:  '/post-purchase/v1/claims/search',
        makeParams: (off) => ({
          'seller.id': account.user_id,
          'date_created.from': fmtML(fromIso),
          'date_created.to':   fmtML(toIso),
          status,
          site_id: siteId || undefined,
          sort: 'date_created:desc',
          limit: Math.min(limitPerPage, 200),
          offset: off
        })
      },
      {
        label: 'v1:new/last_updated',
        path:  '/post-purchase/v1/claims/search',
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
      let page   = 0;
      let anyThisStrategy = false;
      try {
        while (totalFetched < max) {
          const params = strat.makeParams(offset);
          const { data } = await http.get(strat.path, { params });
          const arr = Array.isArray(data?.data) ? data.data : [];
          used.push({ status, page: page + 1, used: { path: strat.path, label: strat.label, params } });

          if (!arr.length) break;

          for (const it of arr) {
            const cid = selectClaimId(it);
            if (!cid) continue;
            if (!collect.find(c => c.__cid === cid)) {
              const copy = { ...it, __cid: cid };
              collect.push(copy);
              totalFetched++;
              if (totalFetched >= max) break;
            }
          }

          anyThisStrategy = true;
          page++;
          offset += params.limit || arr.length;
        }
      } catch (e) {
        used.push({
          status,
          page: page + 1,
          used: { path: strat.path, label: strat.label },
          error: e?.response?.data || e?.message || String(e)
        });
      }

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

  // -------- Order & Item detail (para enriquecer devolução) ----------
  async function getOrderDetail(http, orderId) {
    const { data } = await http.get(`/orders/${orderId}`);
    return data;
  }

  async function getItemDetail(http, itemId) {
    const { data } = await http.get(`/items/${itemId}`);
    return data;
  }

  /**
   * Tenta obter foto e SKU a partir do pedido do ML.
   * Não lança erro — se der ruim, devolve { fotoUrl: null, skuFromOrder: null }.
   */
  async function tryGetPictureFromOrder(http, orderId) {
    try {
      const order = await getOrderDetail(http, orderId);
      const items = Array.isArray(order?.order_items) ? order.order_items : [];
      if (!items.length) return { fotoUrl: null, skuFromOrder: null };

      const it = items[0]; // na prática, devolução quase sempre é 1 item
      let skuFromOrder = normalizeSku(it, { item: it?.item }) || null;

      let fotoUrl =
        it?.item?.thumbnail ||
        it?.item?.picture_url ||
        it?.item?.secure_thumbnail ||
        null;

      // se ainda não temos foto, tenta o /items/{id} completo
      if (!fotoUrl && it?.item?.id) {
        try {
          const fullItem = await getItemDetail(http, it.item.id);
          if (Array.isArray(fullItem?.pictures) && fullItem.pictures.length) {
            fotoUrl = fullItem.pictures[0]?.secure_url || fullItem.pictures[0]?.url || null;
          }
          if (!fotoUrl) {
            fotoUrl = fullItem?.secure_thumbnail || fullItem?.thumbnail || null;
          }
        } catch (_) {
          // não quebra o sync por causa de imagem
        }
      }

      return { fotoUrl: fotoUrl || null, skuFromOrder };
    } catch (_) {
      return { fotoUrl: null, skuFromOrder: null };
    }
  }

  async function enrichReturnFromML(req, returnId) {
    const q = qOf(req);

    const { rows } = await q(
      `SELECT id, id_venda, loja_nome
         FROM devolucoes
        WHERE id = $1
        LIMIT 1`,
      [returnId]
    );
    if (!rows[0]) throw new Error('Devolução não encontrada');

    const orderId = normalizeOrderId(rows[0].id_venda);
    if (!orderId) throw new Error('Devolução não possui número do pedido');

    const { http } = await getAuthedAxios(req);
    const order    = await getOrderDetail(http, orderId);

    const buyer = order?.buyer || {};
    const buyerName =
      [buyer.first_name, buyer.last_name].filter(Boolean).join(' ').trim() ||
      buyer.nickname || null;

    const dataCompraIso =
      order?.date_created ? dayjs(order.date_created).toISOString() : null;

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
        account: {
          user_id: account.user_id,
          nickname: account.nickname,
          site_id: account.site_id,
          expires_at: account.expires_at
        },
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
      const now   = dayjs();
      const days  = Math.max(1, parseInt(req.query.days || '7', 10) || 7);
      const fromIso = req.query.from
        ? dayjs(req.query.from).toISOString()
        : now.subtract(days, 'day').toISOString();
      const toIso   = req.query.to
        ? dayjs(req.query.to).toISOString()
        : now.toISOString();
      const status  = (req.query.status || 'opened').toLowerCase();
      const limit   = Math.min(parseInt(req.query.limit || '5', 10) || 5, 200);

      const accounts = await resolveMlAccounts(req);
      const { http, account } = accounts[0];

      const r = await fetchClaimsPaged(http, account, {
        fromIso, toIso, status, siteId: account.site_id,
        limitPerPage: limit,
        max: limit
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
      res.status(500).json({
        ok: false,
        error: (e?.response?.data || e?.message || String(e))
      });
    }
  });

  // DEBUG — returns/search não existe
  router.get('/api/ml/returns/search-debug', (req, res) => {
    res.status(501).json({
      ok: false,
      error: 'returns search is not provided by ML; use claims/search + /v2/claims/{claim_id}/returns'
    });
    return;
  });

  /**
   * Importa devoluções por meio dos claims (com fallback e paginação)
   * Query:
   *  - statuses=opened,in_progress   (padrão)
   *  - days=90  ou  from=YYYY-MM-DD&to=YYYY-MM-DD
   *  - max=2000
   *  - dry=1, silent=1, debug=1
   *  - all=1  ← roda para todas as contas disponíveis
   *
   * Nunca retorna 400 em erro de claim — contabiliza em errors_detail e segue.
   */
  router.get('/api/ml/claims/import', async (req, res) => {
    const debug = isTrue(req.query.debug); // pode usar depois se quiser log extra
    try {
      const dry    = isTrue(req.query.dry);
      const silent = isTrue(req.query.silent);
      const max    = Math.max(1, parseInt(req.query.max || '2000', 10) || 2000);
      const wantAll = isTrue(req.query.all) ||
                      String(req.query.scope || 'all') === 'all';

      const now = dayjs();
      let fromIso, toIso;
      if (req.query.from || req.query.to) {
        fromIso = req.query.from
          ? dayjs(req.query.from).toISOString()
          : now.subtract(7, 'day').toISOString();
        toIso   = req.query.to
          ? dayjs(req.query.to).toISOString()
          : now.toISOString();
      } else if (req.query.days) {
        const days = Math.max(1, parseInt(req.query.days, 10) || 7);
        fromIso = now.subtract(days, 'day').toISOString();
        toIso   = now.toISOString();
      } else {
        fromIso = now.subtract(7, 'day').toISOString();
        toIso   = now.toISOString();
      }

      const statusList = String(
        req.query.statuses || req.query.status || 'opened,in_progress'
      ).split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);

      const accounts = wantAll
        ? await resolveMlAccounts(req)
        : [await getAuthedAxios(req)];

      // checar se colunas extras existem (uma vez por import)
      const colInfo    = await tableHasColumns('devolucoes', ['tipo_reclamacao', 'foto_produto']);
      const hasTipoCol = !!colInfo.tipo_reclamacao;
      const hasFotoCol = !!colInfo.foto_produto;

      let processed = 0, created = 0, updated = 0, events = 0,
          errors = 0, skipped = 0;
      const paramsUsed    = [];
      const errors_detail = [];

      for (const acc of accounts) {
        const { http, account } = acc;
        const lojaNome = account?.nickname
          ? `Mercado Livre · ${account.nickname}`
          : 'Mercado Livre';

        // ---- busca claims paginada por status
        const claimMap = new Map();
        for (const st of statusList) {
          const r = await fetchClaimsPaged(http, account, {
            fromIso,
            toIso,
            status: st,
            siteId: account.site_id,
            limitPerPage: 200,
            max
          });
          paramsUsed.push(...r.used.map(u => ({
            ...u,
            account: account.user_id
          })));
          for (const it of r.items) {
            const id = it.__cid || selectClaimId(it);
            if (id && !claimMap.has(id)) claimMap.set(id, it);
            if (claimMap.size >= max) break;
          }
          if (claimMap.size >= max) break;
        }

        for (const [claimId, it] of claimMap.entries()) {
          const orderFromList =
            normalizeOrderId(it?.resource_id) ||
            normalizeOrderId(it?.order_id);

          try {
            const cidNum = Number(claimId);
            if (!Number.isFinite(cidNum) || cidNum <= 0) {
              skipped++;
              if (orderFromList) {
                const returnId = await ensureReturnByOrder(req, {
                  order_id: orderFromList,
                  sku: normalizeSku(it),
                  loja_nome: lojaNome,
                  created_by: 'ml-sync'
                });
                created++;
                await addReturnEvent(req, {
                  returnId,
                  type: 'ml-claim',
                  title: 'Claim inválido (skipped)',
                  message: 'Claim sem ID numérico; criado via order_id da listagem',
                  meta: { claim_id: claimId, order_id: orderFromList },
                  idemp_key: `ml-claim-skip:${account.user_id}:${orderFromList}`
                });
                events++;
              }
              continue;
            }

            let claimDet = null;
            try {
              claimDet = await getClaimDetail(http, claimId);
            } catch (e) {
              if (isInvalidClaimIdError(e)) {
                errors++;
                errors_detail.push({
                  account: account.user_id,
                  kind: 'claim_detail',
                  claim_id: claimId,
                  error: 'invalid_claim_id'
                });
                if (orderFromList) {
                  const returnId = await ensureReturnByOrder(req, {
                    order_id: orderFromList,
                    sku: normalizeSku(it),
                    loja_nome: lojaNome,
                    created_by: 'ml-sync'
                  });
                  created++;
                  await addReturnEvent(req, {
                    returnId,
                    type: 'ml-claim',
                    title: 'Claim inválido (fallback)',
                    message: 'Não foi possível abrir o claim no ML; criado/atualizado pelo order_id',
                    meta: { claim_id: claimId, order_id: orderFromList },
                    idemp_key: `ml-claim-fallback:${account.user_id}:${orderFromList}`
                  });
                  events++;
                }
                continue;
              } else {
                errors++;
                errors_detail.push({
                  account: account.user_id,
                  kind: 'claim_detail',
                  claim_id: claimId,
                  error: e?.response?.data || e?.message || String(e)
                });
                continue;
              }
            }

            let ret = null;
            try {
              ret = await getReturnV2ByClaim(http, claimId);
            } catch (e) {
              errors++;
              errors_detail.push({
                account: account.user_id,
                kind: 'return_v2',
                claim_id: claimId,
                error: e?.response?.data || e?.message || String(e)
              });
            }

            const order_id =
              normalizeOrderId(ret?.resource_id) ||
              normalizeOrderId(claimDet?.resource_id) ||
              orderFromList ||
              normalizeOrderId(it?.order_id);

            if (!order_id) {
              errors++;
              errors_detail.push({
                account: account.user_id,
                kind: 'no_order_id',
                claim_id: claimId,
                error: 'missing order_id'
              });
              continue;
            }

            const flow     = mapFlowFromReturn(ret?.status);
            const internal = mapInternalStatusFromFlow(flow);
            let   sku      = normalizeSku(it, claimDet);

            let fotoUrl = null;
            if (hasFotoCol) {
              const imgInfo = await tryGetPictureFromOrder(http, order_id);
              fotoUrl = imgInfo.fotoUrl || null;
              if (!sku && imgInfo.skuFromOrder) {
                sku = imgInfo.skuFromOrder;
              }
            }

            // ----- motivo canônico
            let tipoSug = null;
            try {
              const reasonKey =
                (ret && (ret.reason_key || ret.reason?.key)) ||
                (claimDet && (claimDet.reason_key || claimDet.reason?.key)) ||
                null;
              const reasonId =
                (ret && (ret.reason_id || ret.reason?.id)) ||
                (claimDet && (claimDet.reason_id || claimDet.reason?.id)) ||
                null;
              const reasonName =
                (ret && (ret.reason_name || ret.reason?.name || ret.reason?.description)) ||
                (claimDet && (claimDet.reason_name || claimDet.reason?.name || claimDet.reason?.description)) ||
                null;
              if (reasonKey && REASONKEY_TO_CANON_LOCAL[reasonKey]) tipoSug = REASONKEY_TO_CANON_LOCAL[reasonKey];
              if (!tipoSug && reasonId)   tipoSug = canonFromCodeLocal(reasonId);
              if (!tipoSug && reasonName) tipoSug = canonFromTextLocal(reasonName);
            } catch (_) { /* ignore */ }

            const returnId = await ensureReturnByOrder(req, {
              order_id,
              sku,
              loja_nome: lojaNome,
              created_by: 'ml-sync'
            });

            if (!dry) {
              let sql, params;
              if (hasFotoCol) {
                sql = `
                  UPDATE devolucoes
                     SET log_status       = COALESCE($1, log_status),
                         ml_return_status = COALESCE($2, ml_return_status),
                         status           = COALESCE($3, status),
                         sku              = COALESCE($4, sku),
                         loja_nome        = CASE
                           WHEN (loja_nome IS NULL OR loja_nome = '' OR loja_nome = 'Mercado Livre')
                             THEN COALESCE($5, loja_nome)
                           ELSE loja_nome
                         END,
                         foto_produto     = COALESCE($6, foto_produto),
                         ml_claim_id      = COALESCE($7, ml_claim_id),
                         updated_at       = now()
                   WHERE id = $8`;
                params = [
                  flow,
                  String(ret?.status || ''),
                  internal,
                  sku,
                  lojaNome,
                  fotoUrl,
                  String(claimId),
                  returnId
                ];
              } else {
                sql = `
                  UPDATE devolucoes
                     SET log_status       = COALESCE($1, log_status),
                         ml_return_status = COALESCE($2, ml_return_status),
                         status           = COALESCE($3, status),
                         sku              = COALESCE($4, sku),
                         loja_nome        = CASE
                           WHEN (loja_nome IS NULL OR loja_nome = '' OR loja_nome = 'Mercado Livre')
                             THEN COALESCE($5, loja_nome)
                           ELSE loja_nome
                         END,
                         ml_claim_id      = COALESCE($6, ml_claim_id),
                         updated_at       = now()
                   WHERE id = $7`;
                params = [
                  flow,
                  String(ret?.status || ''),
                  internal,
                  sku,
                  lojaNome,
                  String(claimId),
                  returnId
                ];
              }

              await qOf(req)(sql, params);
              updated++;
            }

            if (!dry && hasTipoCol && tipoSug) {
              try {
                await qOf(req)(
                  `UPDATE devolucoes
                      SET tipo_reclamacao = $1
                    WHERE id = $2
                      AND (COALESCE(tipo_reclamacao,'') = '')`,
                  [tipoSug, returnId]
                );
              } catch (_) { /* ignore */ }
            }

            const idemp = `ml-claim:${account.user_id}:${claimId}:${order_id}`;
            if (!dry) {
              await addReturnEvent(req, {
                returnId,
                type: 'ml-claim',
                title: `Claim ${claimId} (${internal})`,
                message: 'Sincronizado pelo import',
                meta: {
                  account_id: account.user_id,
                  nickname: account.nickname,
                  claim_id: claimId,
                  order_id,
                  return_id: ret?.id || null,
                  return_status: String(ret?.status || ''),
                  flow,
                  loja_nome: lojaNome
                },
                idemp_key: idemp
              });
              events++;
            }

            processed++;
          } catch (e) {
            errors++;
            errors_detail.push({
              account: acc?.account?.user_id,
              kind: 'loop',
              claim_id: claimId,
              error: String(e?.response?.data || e?.message || e)
            });
          }
        }
      }

      if (!silent) {
        console.log('[ml-sync] import', {
          from: fromIso,
          to: toIso,
          statuses: statusList,
          processed, created, updated, events, errors, skipped
        });
      }

      return res.json({
        ok: true,
        from: fromIso,
        to: toIso,
        statuses: statusList,
        processed, created, updated, events, errors, skipped,
        paramsUsed,
        errors_detail
      });

    } catch (e) {
      const detail = e?.response?.data || e?.message || String(e);
      // Mesmo em falha geral, evita 400 para não quebrar o front polling.
      return res.status(200).json({ ok: false, error: detail });
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

  // Backfill simples para usar no pós-login (últimos N dias, padrão 7)
  router.post('/api/ml/claims/backfill-on-login', async (req, res) => {
    try {
      const days = Math.max(1, parseInt(req.body?.days || '7', 10) || 7);
      // dica: chame a rota GET de import pelo front, sem bloquear a navegação
      return res.json({
        ok: true,
        hint: `GET /api/ml/claims/import?days=${days}&statuses=opened,in_progress&silent=1&all=1`
      });
    } catch (e) {
      return res.status(200).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.use(router);
};
