// server/routes/ml-sync.js
'use strict';

const { query } = require('../db');

// ---- fetch helper (Node 18+ tem fetch nativo; senão cai no node-fetch)
const _fetch = (typeof fetch === 'function')
  ? fetch
  : (...a) => import('node-fetch').then(({ default: f }) => f(...a));

async function getMLToken(req) {
  if (req?.user?.ml?.access_token) return req.user.ml.access_token;
  if (process.env.ML_ACCESS_TOKEN) return process.env.ML_ACCESS_TOKEN;
  try {
    const { rows } = await query(
      `SELECT access_token
         FROM ml_tokens
        WHERE is_active IS TRUE
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 1`
    );
    return rows[0]?.access_token || null;
  } catch { return null; }
}

async function mlFetch(path, token, opts = {}) {
  const url = `https://api.mercadolibre.com${path}`;
  const r = await _fetch(url, {
    method: opts.method || 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
    body: opts.body || undefined
  });
  let j = null; try { j = await r.json(); } catch {}
  if (!r.ok) {
    const msg = (j && (j.message || j.error))
      ? `${j.error || ''} ${j.message || ''}`.trim()
      : `ML HTTP ${r.status}`;
    const e = new Error(msg); e.status = r.status; e.payload = j; throw e;
  }
  return j;
}

const norm = s => String(s || '').toLowerCase().trim();
const yes = v => ['1','true','yes','y','sim'].includes(String(v||'').toLowerCase());

/* =========================================================================
 *  MAPEAMENTO DE STATUS
 * ========================================================================= */

// A) SHIPPING (envios) → fluxo canônico do sistema
function canonFlowFromShipping(status, substatus) {
  const s = norm(status), ss = norm(substatus);
  const t = `${s}_${ss}`;

  if (/(mediat|dispute)/.test(t)) return 'mediacao';
  if (/(prep|prepar|embal|label|etiq|ready|pronto)/.test(t)) return 'em_preparacao';
  if (/(in[_-]?transit|transito|transporte|shipped|out[_-]?for[_-]?delivery|returning|to[_-]?be[_-]?received)/.test(t)) return 'em_transporte';
  if (/(delivered|entreg|arrived|recebid)/.test(t)) return 'recebido_cd';
  if (/(not[_-]?delivered)/.test(t)) return 'nao_entregue';
  if (/(cancelled|canceled)/.test(t)) return 'cancelado';
  if (/(closed|fechado|finaliz)/.test(t)) return 'fechado';
  return 'pendente';
}

// B) RETURNS v2 (claims/:id/returns) → fluxo canônico
function canonFlowFromReturnStatus(returnStatus) {
  const s = norm(returnStatus);
  if (!s) return 'pendente';

  // Estados do recurso v2
  if (/^label_generated$|ready_to_ship|etiqueta/.test(s)) return 'pronto_envio';
  if (/^pending(_.*)?$|pending_cancel|pending_failure|pending_expiration/.test(s)) return 'pendente';
  if (/^shipped$|pending_delivered$/.test(s)) return 'em_transporte';
  if (/^delivered$/.test(s)) return 'recebido_cd';
  if (/^not_delivered$/.test(s)) return 'nao_entregue';
  if (/^return_to_buyer$/.test(s)) return 'retorno_comprador';
  if (/^scheduled$/.test(s)) return 'agendado';
  if (/^expired$/.test(s)) return 'expirado';
  if (/^failed$/.test(s)) return 'falha';
  if (/^cancelled$|canceled$/.test(s)) return 'cancelado';

  // Legado (fallback)
  if (['to_be_sent', 'to_be_received', 'in_transit'].includes(s)) return 'em_transporte';
  if (['received', 'arrived'].includes(s)) return 'recebido_cd';
  if (['in_review', 'under_review', 'inspection'].includes(s)) return 'em_inspecao';
  if (['refunded', 'closed'].includes(s)) return 'encerrado';

  return 'pendente';
}

// Se o status geral do retorno for inconclusivo, deduz pelos shipments
function canonFlowFromReturnObject(ret) {
  const base = canonFlowFromReturnStatus(ret?.status);
  if (base !== 'pendente') return base;

  const ships = Array.isArray(ret?.shipments) ? ret.shipments : [];
  let strong = null;

  for (const sh of ships) {
    const st = norm(sh?.status);
    if (st === 'delivered') return 'recebido_cd';
    if (st === 'shipped' || st === 'pending_delivered') strong = strong || 'em_transporte';
    if (st === 'label_generated' || st === 'ready_to_ship') strong = strong || 'pronto_envio';
    if (st === 'not_delivered') strong = strong || 'nao_entregue';
    if (st === 'cancelled') strong = strong || 'cancelado';
  }
  return strong || 'pendente';
}

/* =========================================================================
 *  PERSISTÊNCIA
 * ========================================================================= */

async function persistFlowByOrder(orderId, flow, updatedBy) {
  const { rowCount } = await query(
    `UPDATE devolucoes
        SET status     = $2,
            log_status = $2,
            updated_at = now(),
            updated_by = $3
      WHERE id_venda  = $1`,
    [String(orderId), flow, updatedBy || 'ml-sync']
  );
  return rowCount;
}

async function persistFlowSmart({ orderId, claimId, returnId, flow, updatedBy }) {
  let rows = 0;

  if (orderId) rows = await persistFlowByOrder(orderId, flow, updatedBy);

  if (!rows && claimId) {
    const r = await query(
      `UPDATE devolucoes
          SET status     = $2,
              log_status = $2,
              updated_at = now(),
              updated_by = $3
        WHERE ml_claim_id = $1 OR claim_id = $1`,
      [String(claimId), flow, updatedBy || 'ml-sync']
    );
    rows = r.rowCount || 0;
  }

  if (!rows && returnId) {
    try {
      const r = await query(
        `UPDATE devolucoes
            SET status     = $2,
                log_status = $2,
                updated_at = now(),
                updated_by = $3
          WHERE ml_return_id = $1 OR return_id = $1`,
        [String(returnId), flow, updatedBy || 'ml-sync']
      );
      rows = r.rowCount || 0;
    } catch { /* coluna pode não existir */ }
  }

  return rows;
}

/* =========================================================================
 *  COLETAS ML
 * ========================================================================= */

// Resolve estado de shipping via várias fontes
async function resolveShippingFromML(orderId, token) {
  // flag para retornar "forbidden" sem quebrar o fluxo
  let lastError = null;

  // 1) /orders/:id/shipments
  try {
    const data = await mlFetch(`/orders/${orderId}/shipments`, token);
    const ship = Array.isArray(data) ? data[0] : data;
    if (ship) {
      let status = ship.status || null;
      let substatus = ship.substatus || null;

      if ((!status || !substatus) && ship.id) {
        const d = await mlFetch(`/shipments/${ship.id}`, token).catch(() => null);
        if (d) { status = d.status || status; substatus = d.substatus || substatus; }
      }

      if (status || substatus) {
        return { status, substatus, shipment_id: ship.id || null, source: 'orders/:id/shipments' };
      }
    }
  } catch (e) {
    lastError = e;
    if (e.status === 403 || e.status === 404) return { status:null, substatus:null, shipment_id:null, source:'orders/:id/shipments', forbidden:true, error:e.message };
  }

  // 2) /shipments?order_id=...
  try {
    const list = await mlFetch(`/shipments?order_id=${orderId}`, token);
    const ship = Array.isArray(list) ? list[0] : (list?.results?.[0] || null);
    if (ship) {
      return {
        status: ship.status || null,
        substatus: ship.substatus || null,
        shipment_id: ship.id || null,
        source: 'shipments?order_id'
      };
    }
  } catch (e) {
    lastError = e;
    if (e.status === 403 || e.status === 404) return { status:null, substatus:null, shipment_id:null, source:'shipments?order_id', forbidden:true, error:e.message };
  }

  // 3) /orders/:id + /shipments/:id
  try {
    const ord = await mlFetch(`/orders/${orderId}`, token);
    const sid = ord?.shipping?.id;
    if (sid) {
      const ship = await mlFetch(`/shipments/${sid}`, token);
      return {
        status: ship.status || null,
        substatus: ship.substatus || null,
        shipment_id: sid,
        source: 'orders/:id ⇒ shipments/:id'
      };
    }
  } catch (e) {
    lastError = e;
    if (e.status === 403 || e.status === 404) return { status:null, substatus:null, shipment_id:null, source:'orders ⇒ shipments', forbidden:true, error:e.message };
  }

  return { status: null, substatus: null, shipment_id: null, source: 'not_found', error: lastError?.message || null };
}

// Returns por claim_id (v2)
async function resolveReturnByClaim(claimId, token) {
  const ret = await mlFetch(`/post-purchase/v2/claims/${encodeURIComponent(claimId)}/returns`, token);
  return ret; // objeto único
}

// Busca claim por order_id (ajuda quando a tabela ainda não tem claim salvo)
async function findClaimByOrderId(orderId, token) {
  try {
    const data = await mlFetch(`/post-purchase/v1/claims/search?order_id=${encodeURIComponent(orderId)}`, token);
    const arr = Array.isArray(data?.results) ? data.results
            : Array.isArray(data?.data)    ? data.data
            : Array.isArray(data)          ? data : [];
    return arr[0]?.id || arr[0]?.claim_id || null;
  } catch { return null; }
}

/* =========================================================================
 *  PÍLULA (consolida Claim + Return → rótulo curto)
 * ========================================================================= */

function computePill({ claim, ret }) {
  // 1) Mediação (dispute) tem prioridade
  const stage = norm(claim?.stage);
  if (stage === 'dispute') {
    return { code: 'em_mediacao', label: 'Em mediação', tone: 'warning' };
  }

  // 2) Return + shipments
  const rStatus = norm(ret?.status);
  const ships = Array.isArray(ret?.shipments) ? ret.shipments : [];
  const shipStatuses = new Set(ships.map(s => norm(s?.status)));

  // pronto p/ envio
  if (rStatus === 'label_generated' || shipStatuses.has('ready_to_ship') || rStatus === 'pending') {
    return { code: 'pronto_envio', label: 'Pronto p/ envio', tone: 'info' };
  }

  // em transporte
  const transitSet = ['shipped', 'in_transit', 'pending_delivered', 'not_delivered'];
  if (transitSet.some(s => shipStatuses.has(s)) || transitSet.includes(rStatus)) {
    return { code: 'em_transporte', label: 'Em transporte', tone: 'info' };
  }

  // entregue (chegou ao destino de devolução)
  if (rStatus === 'delivered' || shipStatuses.has('delivered')) {
    const toWh = ships.some(s => norm(s?.destination?.name) === 'warehouse' && norm(s.status) === 'delivered');
    return toWh
      ? { code: 'recebido_cd', label: 'Recebido no CD', tone: 'success' }
      : { code: 'entregue', label: 'Entregue', tone: 'success' };
  }

  // encerrado/cancelado
  const closedSet = ['cancelled', 'expired', 'return_to_buyer', 'closed'];
  if (closedSet.includes(rStatus) || norm(claim?.status) === 'closed') {
    return { code: 'encerrado', label: 'Encerrado', tone: 'muted' };
  }

  // fallback
  return { code: 'pendente', label: 'Pendente', tone: 'muted' };
}

/* =========================================================================
 *  ROTAS
 * ========================================================================= */

module.exports = function registerMlSync(app) {
  // ===== SHIPPING: estado único por order_id
  app.get('/api/ml/shipping/state', async (req, res) => {
    const silent = yes(req.query.silent);
    try {
      const orderId = String(req.query.order_id || '').trim();
      if (!orderId) return res.status(400).json({ error: 'order_id obrigatório' });

      const token = await getMLToken(req);
      if (!token) return res.status(501).json({ error: 'Token do ML ausente' });

      const info = await resolveShippingFromML(orderId, token);
      if (info.status || info.substatus) {
        const flow = canonFlowFromShipping(info.status, info.substatus);
        await persistFlowByOrder(orderId, flow, 'ml-shipping-state');
        return res.json({ ok: true, order_id: orderId, flow, ...info });
      }
      // não quebra em 401/403 — devolve ok:false com a razão
      return res.json({ ok: false, order_id: orderId, ...info });
    } catch (e) {
      if (silent) return res.json({ ok: false, error: e.message, upstream: e.payload || null });
      res.status(502).json({ error: 'Falha na consulta ao ML', detail: e.message, upstream: e.payload || null });
    }
  });

  // ===== SHIPPING: varredura (por período) ou one-shot via ?order_id
  app.get('/api/ml/shipping/sync', async (req, res) => {
    const silent = yes(req.query.silent);
    try {
      const token = await getMLToken(req);
      if (!token) return res.status(501).json({ error: 'Token do ML ausente' });

      // one-shot
      const orderId = req.query.order_id && String(req.query.order_id).trim();
      if (orderId) {
        const info = await resolveShippingFromML(orderId, token);
        let flow = null;
        if (info.status || info.substatus) {
          flow = canonFlowFromShipping(info.status, info.substatus);
          await persistFlowByOrder(orderId, flow, 'ml-sync(one)');
        }
        return res.json({ ok: true, order_id: orderId, flow, ...info });
      }

      // scan por período
      const days = Math.max(1, Math.min(90, Number(req.query.recent_days || 7)));
      const { rows } = await query(
        `SELECT id_venda
           FROM devolucoes
          WHERE id_venda IS NOT NULL
            AND created_at >= now() - ($1 || ' days')::interval`,
        [days]
      );

      let updated = 0;
      for (const r of rows) {
        const info = await resolveShippingFromML(r.id_venda, token);
        if (info.status || info.substatus) {
          const flow = canonFlowFromShipping(info.status, info.substatus);
          await persistFlowByOrder(r.id_venda, flow, 'ml-sync(scan)');
          updated++;
        }
      }
      res.json({ ok: true, updated, scanned: rows.length });
    } catch (e) {
      if (silent) return res.json({ ok: false, error: e.message });
      res.status(502).json({ error: 'Falha no sync de shipping', detail: e.message });
    }
  });

  // ===== RETURNS: estado por claim_id
  // GET /api/ml/returns/state?claim_id=... [&order_id=...] [&silent=1]
  app.get('/api/ml/returns/state', async (req, res) => {
    const silent = yes(req.query.silent);
    try {
      const claimId = String(req.query.claim_id || '').trim();
      const orderId = req.query.order_id ? String(req.query.order_id).trim() : null;
      if (!claimId) return res.status(400).json({ error: 'claim_id obrigatório' });

      const token = await getMLToken(req);
      if (!token) return res.status(501).json({ error: 'Token do ML ausente' });

      const ret = await resolveReturnByClaim(claimId, token);
      const flow = canonFlowFromReturnObject(ret);
      const persistedRows = await persistFlowSmart({
        orderId, claimId, returnId: ret?.id, flow, updatedBy: 'ml-returns-state'
      });

      return res.json({
        ok: true,
        claim_id: claimId,
        order_id: orderId || null,
        return_id: ret?.id || null,
        flow,
        persisted_rows: persistedRows,
        raw_status: ret?.status || null,
        shipments: Array.isArray(ret?.shipments) ? ret.shipments : [],
        status_money: ret?.status_money || null,
        refund_at: ret?.refund_at || null,
        resource_type: ret?.resource_type || null
      });
    } catch (e) {
      if (silent || e.status === 401 || e.status === 403) {
        return res.json({ ok: false, error: e.message, upstream: e.payload || null });
      }
      res.status(502).json({ error: 'Falha ao consultar returns', detail: e.message, upstream: e.payload || null });
    }
  });

  // ===== RETURNS: varredura por período (usa claim_id salvo na tabela)
  // GET /api/ml/returns/sync?recent_days=7[&silent=1]
  app.get('/api/ml/returns/sync', async (req, res) => {
    const silent = yes(req.query.silent);
    try {
      const token = await getMLToken(req);
      if (!token) return res.status(501).json({ error: 'Token do ML ausente' });

      const days = Math.max(1, Math.min(90, Number(req.query.recent_days || 7)));
      const { rows } = await query(
        `SELECT COALESCE(ml_claim_id::text, claim_id::text) AS claim_id,
                id_venda::text AS order_id
           FROM devolucoes
          WHERE (ml_claim_id IS NOT NULL OR claim_id IS NOT NULL)
            AND created_at >= now() - ($1 || ' days')::interval`,
        [days]
      );

      let updated = 0, scanned = 0;
      for (const r of rows) {
        scanned++;
        if (!r.claim_id) continue;
        try {
          const ret = await resolveReturnByClaim(r.claim_id, token);
          const flow = canonFlowFromReturnObject(ret);
          await persistFlowSmart({
            orderId: r.order_id, claimId: r.claim_id, returnId: ret?.id,
            flow, updatedBy: 'ml-returns-sync'
          });
          updated++;
        } catch (e) {
          // ignora 401/403 silenciosamente
          if (!(e.status === 401 || e.status === 403)) {
            // console.warn('[returns/sync]', r.claim_id, e.message);
          }
        }
      }
      res.json({ ok: true, updated, scanned });
    } catch (e) {
      if (silent) return res.json({ ok: false, error: e.message });
      res.status(502).json({ error: 'Falha no sync de returns', detail: e.message });
    }
  });

  /* ===== PÍLULA: consolida claim+return e devolve rótulo curto ========= */

  // GET /api/ml/returns/:dev_id/pill
  // dev_id = id da sua tabela "devolucoes". Opcionalmente aceitar ?order_id e/ou ?claim_id.
  app.get('/api/ml/returns/:dev_id/pill', async (req, res) => {
    const silent = yes(req.query.silent);
    try {
      const devId = Number(req.params.dev_id || 0);
      const token = await getMLToken(req);
      if (!token) return res.status(501).json({ error: 'Token do ML ausente' });

      // 1) tenta obter dados da devolução na sua tabela
      let orderId = null, claimId = null;
      try {
        const { rows } = await query(
          `SELECT id, id_venda::text AS order_id,
                  COALESCE(ml_claim_id::text, claim_id::text) AS claim_id
             FROM devolucoes
            WHERE id = $1
            LIMIT 1`,
          [devId]
        );
        orderId = rows[0]?.order_id || null;
        claimId = rows[0]?.claim_id || null;
      } catch {}

      // overrides por query
      if (req.query.order_id) orderId = String(req.query.order_id);
      if (req.query.claim_id) claimId = String(req.query.claim_id);

      // 2) se não tiver claim, tenta descobrir via order_id
      if (!claimId && orderId) {
        claimId = await findClaimByOrderId(orderId, token);
      }

      // 3) coleta claim e return
      let claimDet = {};
      if (claimId) {
        try { claimDet = await mlFetch(`/post-purchase/v1/claims/${encodeURIComponent(claimId)}`, token); }
        catch (e) { if (!(e.status === 401 || e.status === 403 || e.status === 404)) throw e; }
      }

      let ret = {};
      if (claimId) {
        try { ret = await resolveReturnByClaim(claimId, token); }
        catch (e) { if (!(e.status === 401 || e.status === 403 || e.status === 404)) throw e; }
      }

      const pill = computePill({ claim: claimDet, ret });
      // persistimos o fluxo canônico junto (ajuda o SSR/SQL)
      try {
        const flow = canonFlowFromReturnObject(ret);
        if (flow) await persistFlowSmart({ orderId, claimId, returnId: ret?.id, flow, updatedBy: 'ml-pill' });
      } catch {}

      return res.json({
        ok: true,
        pill,
        raw: {
          claim: { id: claimId || null, status: claimDet?.status || null, stage: claimDet?.stage || null },
          ret:   { id: ret?.id || null, status: ret?.status || null, refund_at: ret?.refund_at || null,
                   shipments: Array.isArray(ret?.shipments)
                     ? ret.shipments.map(s => ({ shipment_id: s.shipment_id, status: s.status, type: s.type, dest: s?.destination?.name || null }))
                     : [] }
        }
      });
    } catch (e) {
      if (silent) return res.json({ ok: false, error: e.message, upstream: e.payload || null });
      res.status(502).json({ error: 'Falha ao consolidar pílula', detail: e.message, upstream: e.payload || null });
    }
  });

  /* ===== COMPATIBILIDADE: endpoints antigos para não gerar 404 no front ===== */

  app.get('/api/ml/shipping/status', async (req, res) => {
    const orderId = String(req.query.order_id || '').trim();
    if (!orderId) return res.status(400).json({ error: 'order_id obrigatório' });
    try {
      const token = await getMLToken(req);
      const info = token ? await resolveShippingFromML(orderId, token)
                         : { status:null, substatus:null, source:'no_token' };
      if (info.status || info.substatus) {
        const flow = canonFlowFromShipping(info.status, info.substatus);
        await persistFlowByOrder(orderId, flow, 'ml-shipping-status');
        return res.json({ ok: true, order_id: orderId, flow, ...info });
      }
      res.json({ ok: false, order_id: orderId, ...info });
    } catch (e) {
      res.json({ ok: false, order_id: orderId, error: e.message }); // não 404
    }
  });

  app.get('/api/ml/shipping/by-order/:order_id', async (req, res) => {
    const orderId = String(req.params.order_id || '').trim();
    if (!orderId) return res.status(400).json({ error: 'order_id obrigatório' });
    try {
      const token = await getMLToken(req);
      const info = token ? await resolveShippingFromML(orderId, token)
                         : { status:null, substatus:null, source:'no_token' };
      if (info.status || info.substatus) {
        const flow = canonFlowFromShipping(info.status, info.substatus);
        await persistFlowByOrder(orderId, flow, 'ml-by-order');
        return res.json({ ok: true, order_id: orderId, flow, ...info });
      }
      res.json({ ok: false, order_id: orderId, ...info });
    } catch (e) {
      res.json({ ok: false, order_id: orderId, error: e.message });
    }
  });

  // Aliases que o front tentou usar em versões antigas
  app.get('/api/ml/orders/:order_id/shipping', (req, res) =>
    app._router.handle(
      { ...req, url: `/api/ml/shipping/by-order/${encodeURIComponent(req.params.order_id)}`, method: 'GET' },
      res, () => {}
    )
  );

  app.get('/api/ml/shipments', (req, res) => {
    const orderId = String(req.query.order_id || '').trim();
    if (!orderId) return res.status(400).json({ error: 'order_id obrigatório' });
    app._router.handle(
      { ...req, url: `/api/ml/shipping/by-order/${encodeURIComponent(orderId)}`, method: 'GET' },
      res, () => {}
    );
  });
};
