// server/routes/returns-log.js
'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { requireRole } = require('../security/rbac'); // arquivo abaixo
const dayjs = require('dayjs');

/**
 * PATCH /api/returns/:id/log
 * Body: { log_status?, tipo_reclamacao?, source? }
 * Efeito: atualiza e insere em return_events.
 */
router.patch('/:id/log', requireRole('operador','admin'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });

    const { log_status, tipo_reclamacao, source } = req.body || {};
    if (!log_status && !tipo_reclamacao) {
      return res.status(400).json({ error: 'nothing_to_update' });
    }

    const tenantId = (req.tenant && req.tenant.id) || req.session?.tenant_id || null;
    const userId   = req.session?.user?.id || null;
    const userRole = req.session?.user?.role || 'leitura';

    // lê valores antigos
    const { rows: prevRows } = await query(
      `SELECT id, tenant_id, log_status, tipo_reclamacao FROM returns WHERE id=$1`,
      [id]
    );
    if (!prevRows.length) return res.status(404).json({ error: 'return_not_found' });
    const prev = prevRows[0];

    // aplica update (só campos enviados)
    const updates = [];
    const params = [];
    let idx = 1;

    if (log_status) { updates.push(`log_status=$${idx++}`); params.push(log_status); }
    if (tipo_reclamacao) { updates.push(`tipo_reclamacao=$${idx++}`); params.push(tipo_reclamacao); }
    updates.push(`updated_at=NOW()`);

    params.push(id);

    const { rows: upRows } = await query(
      `UPDATE returns SET ${updates.join(', ')} WHERE id=$${idx} RETURNING id, log_status, tipo_reclamacao, updated_at`,
      params
    );
    const updated = upRows[0];

    // cria evento
    const payload = {
      source: source || 'manual',
      before: { log_status: prev.log_status, tipo_reclamacao: prev.tipo_reclamacao },
      after:  { log_status: updated.log_status, tipo_reclamacao: updated.tipo_reclamacao },
      actor: { id: userId, role: userRole },
    };

    const { rows: evRows } = await query(
      `INSERT INTO return_events (tenant_id, return_id, event_type, payload, created_by)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, event_type, payload, created_at`,
      [ tenantId, id, 'log_status.update', payload, userId ]
    );
    const event = evRows[0];

    res.json({ ok: true, updated, event });
  } catch (err) {
    console.error('[PATCH /api/returns/:id/log] error', err);
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
