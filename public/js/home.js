'use strict';
const express = require('express');
const router = express.Router();
const { query } = require('../db');
const qOf = (req) => (req?.q || query);

async function hasColumn(req, table, col) {
  const q = qOf(req);
  const { rows } = await q(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND column_name=$2 LIMIT 1`,
    [table, col]
  );
  return !!rows[0];
}
async function getTenantId(req) {
  try {
    if (req?.tenant?.id) return req.tenant.id;
    const q = qOf(req);
    const { rows } = await q(`SELECT current_setting('app.tenant_id', true) AS tid`);
    const tid = rows?.[0]?.tid;
    return tid ? parseInt(tid, 10) : null;
  } catch { return null; }
}

router.get('/returns/:id/messages', async (req, res) => {
  try {
    const q = qOf(req);
    const returnId = parseInt(req.params.id, 10);
    if (!Number.isInteger(returnId)) return res.status(400).json({ error: 'return_id inválido' });

    const colTenant     = await hasColumn(req, 'return_messages', 'tenant_id');
    const colDirection  = await hasColumn(req, 'return_messages', 'direction');
    const colSenderName = await hasColumn(req, 'return_messages', 'sender_name');
    const colSenderRole = await hasColumn(req, 'return_messages', 'sender_role');
    const colCreatedBy  = await hasColumn(req, 'return_messages', 'created_by');
    const colCreatedAt  = await hasColumn(req, 'return_messages', 'created_at');

    const params = [returnId];
    let where = 'return_id = $1';
    if (colTenant) {
      const tid = await getTenantId(req);
      if (tid != null) { params.push(tid); where += ` AND tenant_id = $${params.length}`; }
    }

    const fields = `
      id,
      return_id AS "returnId",
      ${colDirection  ? 'direction'    : `'out'`}        AS direction,
      body,
      ${colSenderName ? 'sender_name'  : 'NULL'}         AS "senderName",
      ${colSenderRole ? 'sender_role'  : 'NULL'}         AS "senderRole",
      ${colCreatedBy  ? 'created_by'   : 'NULL'}         AS "createdBy",
      ${colCreatedAt  ? 'created_at'   : 'now()'}        AS "createdAt"
    `;
    const sql = `
      SELECT ${fields}
        FROM public.return_messages
       WHERE ${where}
       ORDER BY "createdAt" ASC, id ASC
    `;
    const { rows } = await q(sql, params);
    res.json({ items: rows });
  } catch (e) {
    console.error('GET /returns/:id/messages ERRO:', e);
    res.status(500).json({ error: 'Falha ao listar mensagens' });
  }
});

router.post('/returns/:id/messages', async (req, res) => {
  try {
    const q = qOf(req);
    const returnId = parseInt(req.params.id, 10);
    if (!Number.isInteger(returnId)) return res.status(400).json({ error: 'return_id inválido' });

    const text = String(req.body?.body || '').trim();
    if (!text) return res.status(400).json({ error: 'body obrigatório' });

    const user = req.session?.user || { id: null, name: 'Usuário' };

    const colTenant     = await hasColumn(req, 'return_messages', 'tenant_id');
    const colDirection  = await hasColumn(req, 'return_messages', 'direction');
    const colSenderName = await hasColumn(req, 'return_messages', 'sender_name');
    const colSenderRole = await hasColumn(req, 'return_messages', 'sender_role');
    const colCreatedBy  = await hasColumn(req, 'return_messages', 'created_by');

    const cols = ['return_id', 'body'];
    const vals = [returnId, text];
    const ph   = ['$1', '$2'];

    if (colDirection)  { vals.push('out');                  cols.push('direction');   ph.push(`$${vals.length}`); }
    if (colSenderName) { vals.push(user.name || 'Usuário'); cols.push('sender_name'); ph.push(`$${vals.length}`); }
    if (colSenderRole) { vals.push('seller');               cols.push('sender_role'); ph.push(`$${vals.length}`); }
    if (colCreatedBy)  { vals.push(user.id || null);        cols.push('created_by');  ph.push(`$${vals.length}`); }
    if (colTenant) {
      const tid = await getTenantId(req);
      vals.push(tid); cols.push('tenant_id'); ph.push(`$${vals.length}`);
    }

    const sql = `
      INSERT INTO public.return_messages (${cols.join(',')})
      VALUES (${ph.join(',')})
      RETURNING
        id,
        return_id  AS "returnId",
        ${colDirection  ? 'direction'  : `'out'`}      AS direction,
        body,
        ${colSenderName ? 'sender_name' : 'NULL'}      AS "senderName",
        ${colSenderRole ? 'sender_role' : 'NULL'}      AS "senderRole",
        ${colCreatedBy  ? 'created_by'  : 'NULL'}      AS "createdBy",
        now()                                          AS "createdAt"
    `;
    const { rows } = await q(sql, vals);
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('POST /returns/:id/messages ERRO:', e);
    // sempre revelar o erro em dev; para forçar, defina REVEAL_ERRORS=true
    const reveal = String(process.env.REVEAL_ERRORS ?? 'true').toLowerCase() === 'true';
    const errMsg = (e && (e.detail || e.message)) ? (e.detail || e.message) : String(e || 'Falha');
    res.status(500).json({ error: reveal ? errMsg : 'Falha ao enviar mensagem' });
  }
});

module.exports = router;
