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

async function mlFetch(path, token) {
  const url = `https://api.mercadolibre.com${path}`;
  const r = await _fetch(url, { headers: { Authorization: `Bearer ${token}` } });
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

// ========= Mapas de FLUXO =========

// (A) Mapa para SHIPPING (envios)
function canonFlowFromShipping(status, substatus) {
  const s = norm(status), ss = norm(substatus);
  const t = `${s}_${ss}`;
  if (/(mediat|dispute)/.test(t)) return 'mediacao';
  if (/(prep|prepar|embal|label|etiq|ready|pronto)/.test(t)) return 'em_preparacao';
  if (/(in[_-]?transit|transito|transporte|enviado|out[_-]?for[_-]?delivery|returning|to[_-]?be[_-]?received)/.test(t)) return 'em_transporte';
  if (/(delivered|entreg|arrived|recebid)/.test(t)) return 'recebido_cd';
  if (/(not[_-]?delivered)/.test(t)) return 'nao_entregue';
  if (/(cancelled|canceled)/.test(t)) return 'cancelado';
  if (/(closed|fechado|finaliz)/.test(t)) return 'fechado';
  return 'pendente';
}

// (B) Mapa para RETURNS (post-purchase/v2/claims/:id/returns → status)
function canonFlowFromReturnStatus(returnStatus) {
  const s = norm(returnStatus);
  if (!s) return 'pendente';
  if (/^label_generated$|ready_to_ship|etiqueta/.test(s)) return 'pronto_envio';
  if (/^pending(_.*)?$|pending_cancel|pending_failure|pending_expiration/.test(s)) return 'pendente';
  if (/^shipped$|pending_delivered/.test(s)) return 'em_transporte';
  if (/^delivered$/.test(s)) return 'recebido_cd';
  if (/^not_delivered$/.test(s)) return 'nao_entregue';
  if (/^return_to_buyer$/.test(s)) return 'retorno_comprador';
  if (/^scheduled$/.test(s)) return 'agendado';
  if (/^expired$/.test(s)) return 'expirado';
  if (/^failed$/.test(s)) return 'falhou';
  if (/^cancelled$|canceled$/.test(s)) return 'cancelado';
  return 'pendente';
}

// Se o status geral não vier claro, tenta deduzir pelos shipments do retorno
function canonFlowFromReturnObject(ret) {
  const base = canonFlowFromReturnStatus(ret?.status);
  if (base !== 'pendente') return base;

  const ships = Array.isArray(ret?.shipments) ? ret.shipments : [];
  // prioriza um status "mais forte" se existir nos shipments
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

// ========= Persistência =========

async function persistFlowByOrder(orderId, flow, updatedBy) {
  const { rowCount } = await query(
    `UPDATE devolucoes
        SET log_status = $2,
            updated_at = now(),
            updated_by = $3
      WHERE id_venda = $1`,
    [String(orderId), flow, updatedBy || 'ml-sync']
  );
  return rowCount;
}

// Atualiza por order_id (prioridade), senão por claim_id
async function persistFlowSmart({ orderId, claimId, returnId, flow, updatedBy }) {
  let rows = 0;
  if (orderId) rows = await persistFlowByOrder(orderId, flow, updatedBy);
  if (!rows && claimId) {
    const r = await query(
      `UPDATE devolucoes
          SET log_status = $2,
              updated_at = now(),
              updated_by = $3
        WHERE ml_claim_id = $1 OR claim_id = $1`,
      [String(claimId), flow, updatedBy || 'ml-sync']
    );
    rows = r.rowCount || 0;
  }
  if (!rows && returnId) {
    // tenta por return_id se existir na tabela
    try {
      const r = await query(
        `UPDATE devolucoes
            SET log_status = $2,
                updated_at = now(),
                updated_by = $3
          WHERE ml_return_id = $1 OR return_id = $1`,
        [String(returnId), flow, updatedBy || 'ml-sync']
      );
      rows = r.rowCount || 0;
    } catch { /* coluna pode não existir, tudo bem */ }
  }
  return rows;
}

// ========= Coletas ML =========

// Tenta várias fontes do ML e retorna { status, substatus, shipment_id, source }
async function resolveShippingFromML(orderId, token) {
  // 1) /orders/:id/shipments
  try {
    const data = await mlFetch(`/orders/${orderId}/shipments`, token);
    const ship = Array.isArray(data) ? data[0] : data;
    if (ship) {
      let status = ship.status || ship.substatus || null;
      let substatus = ship.substatus || null;
      if (!status && ship.id) {
        const d = await mlFetch(`/shipments/${ship.id}`, token).catch(() => null);
        if (d) { status = d.status || status; substatus = d.substatus || substatus; }
      }
      if (status || substatus) {
        return { status, substatus, shipment_id: ship.id || null, source: 'orders/:id/shipments' };
      }
    }
  } catch {}

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
  } catch {}

  // 3) /orders/:id (pega shipping.id e detalha)
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
  } catch {}

  return { status: null, substatus: null, shipment_id: null, source: 'not_found' };
}

// Returns por claim_id
async function resolveReturnByClaim(claimId, token) {
  const ret = await mlFetch(`/post-purchase/v2/claims/${encodeURIComponent(claimId)}/returns`, token);
  // a API pode retornar direto o objeto de retorno (não array)
  return ret;
}

module.exports = function registerMlSync(app) {
  // ===== SHIPPING: estado único por order_id
  app.get('/api/ml/shipping/state', async (req, res) => {
    const silent = String(req.query.silent || '').toLowerCase() === '1' || String(req.query.silent || '').toLowerCase() === 'true';
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
      res.json({ ok: false, order_id: orderId, ...info });
    } catch (e) {
      if (silent) return res.json({ ok: false, error: e.message, upstream: e.payload || null });
      res.status(502).json({ error: 'Falha na consulta ao ML', detail: e.message, upstream: e.payload || null });
    }
  });

  // ===== SHIPPING: varredura (recent_days) ou one-shot via ?order_id
  app.get('/api/ml/shipping/sync', async (req, res) => {
    const silent = String(req.query.silent || '').toLowerCase() === '1' || String(req.query.silent || '').toLowerCase() === 'true';
    try {
      const token = await getMLToken(req);
      if (!token) return res.status(501).json({ error: 'Token do ML ausente' });

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
  // Ex.: GET /api/ml/returns/state?claim_id=5298178312[&order_id=2000009229357366][&silent=1]
  app.get('/api/ml/returns/state', async (req, res) => {
    const silent = String(req.query.silent || '').toLowerCase() === '1' || String(req.query.silent || '').toLowerCase() === 'true';
    try {
      const claimId = String(req.query.claim_id || '').trim();
      const orderId = req.query.order_id ? String(req.query.order_id).trim() : null;
      if (!claimId) return res.status(400).json({ error: 'claim_id obrigatório' });

      const token = await getMLToken(req);
      if (!token) return res.status(501).json({ error: 'Token do ML ausente' });

      const ret = await resolveReturnByClaim(claimId, token);
      const flow = canonFlowFromReturnObject(ret);
      const persistedRows = await persistFlowSmart({ orderId, claimId, returnId: ret?.id, flow, updatedBy: 'ml-returns-state' });

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
        // evita 4xx no console: responde 200 com ok:false
        return res.json({ ok: false, error: e.message, upstream: e.payload || null });
      }
      res.status(502).json({ error: 'Falha ao consultar returns', detail: e.message, upstream: e.payload || null });
    }
  });

  // ===== RETURNS: varredura por período (usa claim_id salvo na tabela)
  // Ex.: GET /api/ml/returns/sync?recent_days=7[&silent=1]
  app.get('/api/ml/returns/sync', async (req, res) => {
    const silent = String(req.query.silent || '').toLowerCase() === '1' || String(req.query.silent || '').toLowerCase() === 'true';
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
          await persistFlowSmart({ orderId: r.order_id, claimId: r.claim_id, returnId: ret?.id, flow, updatedBy: 'ml-returns-sync' });
          updated++;
        } catch (e) {
          // ignora 401/403 silenciosamente na varredura
          if (!(e.status === 401 || e.status === 403)) {
            // log opcional no servidor
            // console.warn('[returns/sync] claim', r.claim_id, '→', e.message);
          }
        }
      }
      res.json({ ok: true, updated, scanned });
    } catch (e) {
      if (silent) return res.json({ ok: false, error: e.message });
      res.status(502).json({ error: 'Falha no sync de returns', detail: e.message });
    }
  });

  // ===== Compat: endpoints antigos (evitar 404 no console)
  app.get('/api/ml/shipping/status', async (req, res) => {
    const orderId = String(req.query.order_id || '').trim();
    if (!orderId) return res.status(400).json({ error: 'order_id obrigatório' });
    try {
      const token = await getMLToken(req);
      const info = token ? await resolveShippingFromML(orderId, token) : { status:null, substatus:null, source:'no_token' };
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
      const info = token ? await resolveShippingFromML(orderId, token) : { status:null, substatus:null, source:'no_token' };
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

  // Alias compatíveis com tentativas antigas do front
  app.get('/api/ml/orders/:order_id/shipping', (req, res) =>
    app._router.handle({ ...req, url: `/api/ml/shipping/by-order/${encodeURIComponent(req.params.order_id)}`, method: 'GET' }, res, () => {})
  );
  app.get('/api/ml/shipments', (req, res) => {
    const orderId = String(req.query.order_id || '').trim();
    if (!orderId) return res.status(400).json({ error: 'order_id obrigatório' });
    app._router.handle({ ...req, url: `/api/ml/shipping/by-order/${encodeURIComponent(orderId)}`, method: 'GET' }, res, () => {});
  });
};
