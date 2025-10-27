// server/routes/ml-reenrich.js
'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../db');
const axios = require('axios');
const { requireRole } = require('../security/rbac');

/**
 * POST /api/ml/returns/re-enrich
 * Body (opcional): { since_hours?: number, limit?: number }
 * Processo:
 * 1) Seleciona devoluções pendentes nas últimas X horas.
 * 2) Para cada uma, chama o endpoint GET fetch-amounts.
 * 3) Aplica PATCH /api/returns/:id/log para persistir suggested/tipo.
 * 4) Cria evento (o PATCH já faz isso).
 */
router.post('/returns/re-enrich', requireRole('operador','admin'), async (req, res) => {
  try {
    const { since_hours = 48, limit = 50 } = req.body || {};
    const tenantId = (req.tenant && req.tenant.id) || req.session?.tenant_id || null;

    const { rows } = await query(
      `SELECT id, order_id, claim_id
         FROM returns
        WHERE (log_status IS NULL OR log_status IN ('pendente','em_analise','em-analise'))
          AND updated_at >= (NOW() - ($1 || ' hours')::interval)
        ORDER BY updated_at DESC
        LIMIT $2`,
      [ String(since_hours), Number(limit) ]
    );

    const base = `${req.protocol}://${req.get('host')}`;
    const out = [];
    for (const r of rows) {
      try {
        // 1) chama fetch-amounts
        const params = new URLSearchParams();
        if (r.order_id) params.set('order_id', r.order_id);
        if (r.claim_id) params.set('claim_id', r.claim_id);

        const amountsUrl = `${base}/api/ml/returns/${r.id}/fetch-amounts${params.toString() ? ('?'+params) : ''}`;
        const m = await axios.get(amountsUrl, { headers: { Cookie: req.headers.cookie || '' }});
        const suggested = m.data && m.data.log_status_suggested;

        // heurística para tipo a partir do reason_name
        let tipoSug = '';
        const reason = (m.data && m.data.reason_name || '').toLowerCase();
        if (reason.includes('arrepend')) tipoSug = 'arrependimento';
        else if (reason.includes('defeito') || reason.includes('avaria')) tipoSug = 'defeito';
        else if (reason.includes('errado') || reason.includes('troca')) tipoSug = 'compra_errada';

        // 2) PATCH persistindo
        const patchBody = {
          source: 'auto_batch_reenrich',
          ...(suggested ? { log_status: suggested } : {}),
          ...(tipoSug ? { tipo_reclamacao: tipoSug } : {})
        };
        const p = await axios.patch(`${base}/api/returns/${r.id}/log`, patchBody, { headers: { Cookie: req.headers.cookie || '' }});
        out.push({ id: r.id, ok: true, applied: patchBody, event_id: p.data?.event?.id || null });
      } catch (err) {
        console.warn('[re-enrich] item erro', r.id, err?.response?.status, err?.message);
        out.push({ id: r.id, ok: false, error: err?.response?.data || err?.message });
      }
    }

    res.json({ ok: true, count: out.length, results: out });
  } catch (err) {
    console.error('[POST /api/ml/returns/re-enrich] error', err);
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
