// server/routes/returns-messages.js
'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../db');

// Usa a conexão do middleware de tenant se existir
const qOf = (req) => (req?.q || query);

/* -------------------- helpers -------------------- */
async function tableHasColumns(table, columns, req) {
  const q = qOf(req);
  const { rows } = await q(
    `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1`,
    [table]
  );
  const set = new Set(rows.map(r => r.column_name));
  const out = {};
  for (const c of columns) out[c] = set.has(c);
  return out;
}

async function columnTypes(table, cols, req) {
  const q = qOf(req);
  const { rows } = await q(
    `SELECT column_name, data_type, udt_name
       FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name=$1
        AND column_name = ANY($2::text[])`,
    [table, cols]
  );
  const map = {};
  rows.forEach(r => (map[r.column_name] = r.data_type || r.udt_name || 'text'));
  return map;
}

const isNumericType = (t) => /int|numeric|decimal|real|double/i.test(String(t || ''));
const isUuidType    = (t) => /uuid/i.test(String(t || ''));

function safeParseJson(s) {
  if (s == null) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(String(s)); } catch { return null; }
}

/** resolve contexto do tenant (id numérico e/ou slug/texto) */
function resolveTenantCtx(req) {
  const t = req.tenant || {};
  const user = req.session?.user || {};
  const id_num   = (t.id ?? user.tenant_id);
  const slug     = t.slug || user.company || user.email || '';
  const text     = String(slug || '').split('@')[0] || null;
  const num_hint = (() => {
    const onlyDigits = (text || '').replace(/\D/g, '');
    return onlyDigits ? Number(onlyDigits) : null;
  })();
  return { id_num, text, num_hint };
}

/* -------------------- rotas -------------------- */

/**
 * GET /api/returns/:id/messages
 */
router.get('/api/returns/:id/messages', async (req, res) => {
  try {
    const q = qOf(req);
    const returnId = parseInt(req.params.id, 10);
    if (!Number.isInteger(returnId)) {
      return res.status(400).json({ error: 'return_id inválido' });
    }

    const has = await tableHasColumns(
      'return_messages',
      ['tenant_id','parent_id','conversation_id','created_by','attachments','metadata','channel'],
      req
    );
    const types = await columnTypes('return_messages', ['tenant_id'], req);
    const retTenant = resolveTenantCtx(req);

    const whereParts = [`return_id = $1`];
    const params = [returnId];

    if (has.tenant_id) {
      if (isNumericType(types['tenant_id'])) {
        const val = (retTenant.id_num != null)
          ? retTenant.id_num
          : (retTenant.num_hint != null ? retTenant.num_hint : 1);
        whereParts.push(`tenant_id = $${params.length + 1}::bigint`);
        params.push(val);
      } else if (isUuidType(types['tenant_id'])) {
        whereParts.push(`tenant_id::text = $${params.length + 1}`);
        params.push(retTenant.text || '00000000-0000-0000-0000-000000000000');
      } else {
        whereParts.push(`tenant_id::text = $${params.length + 1}`);
        params.push(retTenant.text || 'default');
      }
    }

    const selectCols = [
      'id',
      `return_id  AS "returnId"`,
      has.parent_id       ? `parent_id AS "parentId"`               : `NULL::int   AS "parentId"`,
      has.conversation_id ? `conversation_id AS "conversationId"`   : `NULL::int   AS "conversationId"`,
      has.channel         ? `channel`                                : `'internal'::text AS channel`,
      `direction`,
      `sender_name AS "senderName"`,
      `sender_role AS "senderRole"`,
      `body`,
      has.attachments ? `attachments` : `'[]'::jsonb AS attachments`,
      has.metadata    ? `metadata`    : `NULL::jsonb AS metadata`,
      `created_at AS "createdAt"`,
      has.created_by  ? `created_by AS "createdBy"` : `NULL::int AS "createdBy"`
    ];

    const sql = `
      SELECT ${selectCols.join(',\n             ')}
        FROM return_messages
       WHERE ${whereParts.join(' AND ')}
       ORDER BY created_at ASC, id ASC
    `;

    const { rows } = await q(sql, params);
    const items = rows.map(r => ({
      ...r,
      attachments: Array.isArray(r.attachments)
        ? r.attachments
        : (safeParseJson(r.attachments) || []),
      metadata: (typeof r.metadata === 'string')
        ? safeParseJson(r.metadata)
        : r.metadata
    }));

    return res.json({ items });
  } catch (e) {
    console.error('GET /returns/:id/messages ERRO:', e);
    res.status(500).json({ error: 'Falha ao listar mensagens' });
  }
});

/**
 * POST /api/returns/:id/messages
 */
router.post('/api/returns/:id/messages', async (req, res) => {
  try {
    const q = qOf(req);
    const returnId = parseInt(req.params.id, 10);
    if (!Number.isInteger(returnId)) {
      return res.status(400).json({ error: 'return_id inválido' });
    }

    const bodyText = String(req.body?.body || '').trim();
    if (!bodyText) return res.status(400).json({ error: 'body vazio' });

    const channelReq = String(req.body?.channel || 'internal');

    const has = await tableHasColumns(
      'return_messages',
      ['tenant_id','parent_id','conversation_id','created_by','attachments','metadata','channel'],
      req
    );
    const types = await columnTypes('return_messages', ['tenant_id'], req);
    const retTenant = resolveTenantCtx(req);
    const user = req.session?.user || {};

    // builder de INSERT seguro
    const cols = [];
    const vals = [];
    const args = [];
    const add = (col, val, cast = '') => {
      cols.push(col);
      args.push(val);
      vals.push(`$${args.length}${cast}`);
    };

    // tenant_id (se existir na tabela)
    if (has.tenant_id) {
      if (isNumericType(types['tenant_id'])) {
        const val = (retTenant.id_num != null)
          ? retTenant.id_num
          : (retTenant.num_hint != null ? retTenant.num_hint : 1);
        add('tenant_id', val, '::bigint');
      } else if (isUuidType(types['tenant_id'])) {
        add('tenant_id', retTenant.text || '00000000-0000-0000-0000-000000000000');
      } else {
        add('tenant_id', retTenant.text || 'default');
      }
    }

    add('return_id', returnId);
    if (has.parent_id)       add('parent_id', null);              // raiz (thread opcional)
    if (has.conversation_id) add('conversation_id', null);        // compat
    if (has.channel)         add('channel', channelReq);          // NOT NULL na sua tabela
    add('direction', 'out');
    add('sender_name', user.name || 'Você');
    add('sender_role', user.role || 'operador');
    add('body', bodyText);
    add('attachments', JSON.stringify(req.body?.attachments ?? []), '::jsonb');
    add('metadata',    JSON.stringify(req.body?.metadata ?? null),  '::jsonb');
    if (has.created_by) add('created_by', user.id ?? null, '::int');

    // created_at = now()
    cols.push('created_at');
    vals.push('now()');

    const sql = `
      INSERT INTO return_messages (${cols.join(', ')})
      VALUES (${vals.join(', ')})
      RETURNING
        id,
        return_id  AS "returnId",
        ${has.parent_id       ? 'parent_id AS "parentId"'           : 'NULL::int AS "parentId"'},
        ${has.conversation_id ? 'conversation_id AS "conversationId"' : 'NULL::int AS "conversationId"'},
        ${has.channel         ? 'channel'                           : `'internal'::text AS channel`},
        direction,
        sender_name AS "senderName",
        sender_role AS "senderRole",
        body,
        ${has.attachments ? 'attachments' : `'[]'::jsonb AS attachments`},
        ${has.metadata    ? 'metadata'    : `NULL::jsonb AS metadata`},
        created_at AS "createdAt",
        ${has.created_by ? 'created_by AS "createdBy"' : 'NULL::int AS "createdBy"'}
    `;

    const { rows } = await q(sql, args);
    return res.json(rows[0]);
  } catch (e) {
    console.error('POST /returns/:id/messages ERRO:', e);
    res.status(500).json({ error: 'Falha ao enviar mensagem' });
  }
});

module.exports = router;
