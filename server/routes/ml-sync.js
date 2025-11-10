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

const norm = s => String(s || '').toLowerCase();
function canonFlow(status, substatus) {
  const s = norm(status), ss = norm(substatus);
  const t = `${s}_${ss}`;
  if (/(mediat)/.test(t)) return 'mediacao';
  if (/(prep|prepar|embal|label|etiq|ready|pronto)/.test(t)) return 'em_preparacao';
  if (/(transit|transito|transporte|enviado|out_for_delivery|returning)/.test(t)) return 'em_transporte';
  if (/(delivered|entreg|arrived|recebid)/.test(t)) return 'recebido_cd';
  if (/(closed|fechado|finaliz)/.test(t)) return 'fechado';
  return 'pendente';
}

async function persistFlowByOrder(orderId, status, substatus, updatedBy) {
  const flow = canonFlow(status, substatus);
  await query(
    `UPDATE devolucoes
        SET log_status = $2,
            updated_at = now(),
            updated_by = $3
      WHERE id_venda = $1`,
    [String(orderId), flow, updatedBy || 'ml-sync']
  );
  return flow;
}

// Tenta várias fontes do ML e retorna { status, substatus, shipment_id, source }
async function resolveShippingFromML(orderId, token) {
  // 1) /orders/:id/shipments
  try {
    const data = await mlFetch(`/orders/${orderId}/shipments`, token);
    const ship = Array.isArray(data) ? data[0] : data;
    if (ship) {
      // às vezes aqui só vem o id; se tiver, tenta detalhar:
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

module.exports = function registerMlSync(app) {
  // ————— Unified state (novo front usa esta)
  app.get('/api/ml/shipping/state', async (req, res) => {
    try {
      const orderId = String(req.query.order_id || '').trim();
      if (!orderId) return res.status(400).json({ error: 'order_id obrigatório' });

      const token = await getMLToken(req);
      if (!token) return res.status(501).json({ error: 'Token do ML ausente' });

      const info = await resolveShippingFromML(orderId, token);
      // persiste se achou algo
      if (info.status || info.substatus) {
        const flow = await persistFlowByOrder(orderId, info.status, info.substatus, 'ml-shipping-state');
        return res.json({ ok: true, order_id: orderId, flow, ...info });
      }
      // não 404: respondemos 200 com ok:false para não poluir o console
      res.json({ ok: false, order_id: orderId, ...info });
    } catch (e) {
      res.status(502).json({ error: 'Falha na consulta ao ML', detail: e.message, upstream: e.payload });
    }
  });

  // ————— Varredura por período (novo front usa esta também)
  app.get('/api/ml/shipping/sync', async (req, res) => {
    try {
      const token = await getMLToken(req);
      if (!token) return res.status(501).json({ error: 'Token do ML ausente' });

      const orderId = req.query.order_id && String(req.query.order_id).trim();
      if (orderId) {
        const info = await resolveShippingFromML(orderId, token);
        let flow = null;
        if (info.status || info.substatus) {
          flow = await persistFlowByOrder(orderId, info.status, info.substatus, 'ml-sync(one)');
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
          await persistFlowByOrder(r.id_venda, info.status, info.substatus, 'ml-sync(scan)');
          updated++;
        }
      }
      res.json({ ok: true, updated, scanned: rows.length });
    } catch (e) {
      res.status(502).json({ error: 'Falha no sync de shipping', detail: e.message });
    }
  });

  // ————— Compat: endpoints antigos (evitar 404 no console)
  app.get('/api/ml/shipping/status', async (req, res) => {
    const orderId = String(req.query.order_id || '').trim();
    if (!orderId) return res.status(400).json({ error: 'order_id obrigatório' });
    try {
      const token = await getMLToken(req);
      const info = token ? await resolveShippingFromML(orderId, token) : { status:null, substatus:null, source:'no_token' };
      if (info.status || info.substatus) await persistFlowByOrder(orderId, info.status, info.substatus, 'ml-shipping-status');
      res.json({ ok: !!(info.status || info.substatus), order_id: orderId, ...info });
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
      if (info.status || info.substatus) await persistFlowByOrder(orderId, info.status, info.substatus, 'ml-by-order');
      res.json({ ok: !!(info.status || info.substatus), order_id: orderId, ...info });
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
