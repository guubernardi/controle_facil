// server/routes/returns-messages.js
'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../db');

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

/** Tenant com fallback:
 * - tenant_mw.slug -> user.company -> TENANT_TEXT_FALLBACK -> prefixo do e-mail -> 'default'
 * - para UUID: usa TENANT_UUID_FALLBACK ou slug acima (se for um UUID válido)
 */
function resolveTenantCtx(req) {
  const t = req.tenant || {};
  const user = req.session?.user || {};
  const id_num = (t.id ?? user.tenant_id ?? null);
  const emailSlug = user?.email ? String(user.email).split('@')[0] : null;
  const fallbackText = process.env.TENANT_TEXT_FALLBACK || emailSlug || 'default';
  const text = t.slug || user.company || fallbackText;
  return { id_num, text };
}

async function assertTableExists(req) {
  const has = await tableHasColumns(
    'return_messages',
    ['return_id', 'body', 'created_at'],
    req
  );
  if (!has.return_id || !has.body) {
    const e = new Error('Tabela return_messages ausente ou incompleta');
    e.code = 'TABLE_MISSING';
    throw e;
  }
}

/* -------------------- ROTAS (RELATIVAS) -------------------- */
/** GET /api/returns/:id/messages */
router.get('/returns/:id/messages', async (req, res) => {
  try {
    await assertTableExists(req);

    const q = qOf(req);
    const returnId = parseInt(req.params.id, 10);
    if (!Number.isInteger(returnId)) {
      return res.status(400).json({ error: 'return_id inválido' });
    }

    const limit  = Math.max(1, Math.min(parseInt(req.query.limit || '200', 10), 500));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10) || 0);

    const has = await tableHasColumns(
      'return_messages',
      [
        'tenant_id','parent_id','conversation_id','created_by',
        'attachments','metadata','channel','sender_role','sender_name',
        'direction','body','created_at','return_id'
      ],
      req
    );
    const types = await columnTypes('return_messages', ['tenant_id'], req);
    const { id_num, text } = resolveTenantCtx(req);

    const where = [`return_id = $1`];
    const params = [returnId];

    if (has.tenant_id) {
      if (isNumericType(types['tenant_id'])) {
        if (id_num == null) return res.status(400).json({ error: 'tenant_id ausente' });
        where.push(`tenant_id = $${params.length + 1}::bigint`);
        params.push(id_num);
      } else if (isUuidType(types['tenant_id'])) {
        const uuidText = process.env.TENANT_UUID_FALLBACK || text;
        if (!uuidText) return res.status(400).json({ error: 'tenant_id (uuid) ausente' });
        where.push(`tenant_id::text = $${params.length + 1}`);
        params.push(String(uuidText));
      } else {
        where.push(`tenant_id::text = $${params.length + 1}`);
        params.push(String(text));
      }
    }

    const selectCols = [
      'id',
      `return_id AS "returnId"`,
      has.parent_id       ? `parent_id AS "parentId"`             : `NULL::int AS "parentId"`,
      has.conversation_id ? `conversation_id AS "conversationId"` : `NULL::int AS "conversationId"`,
      has.channel         ? `channel`                             : `'internal'::text AS channel`,
      has.direction       ? `direction`                           : `'out'::text AS direction`,
      has.sender_name     ? `sender_name AS "senderName"`         : `NULL::text AS "senderName"`,
      has.sender_role     ? `sender_role AS "senderRole"`         : `NULL::text AS "senderRole"`,
      `body`,
      has.attachments ? `attachments` : `'[]'::jsonb AS attachments`,
      has.metadata    ? `metadata`    : `NULL::jsonb AS metadata`,
      `created_at AS "createdAt"`,
      has.created_by  ? `created_by AS "createdBy"` : `NULL::int AS "createdBy"`
    ];

    const sql = `
      SELECT ${selectCols.join(', ')}
        FROM return_messages
       WHERE ${where.join(' AND ')}
       ORDER BY created_at ASC, id ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    const { rows } = await q(sql, [...params, limit, offset]);

    const items = rows.map(r => ({
      ...r,
      attachments: Array.isArray(r.attachments)
        ? r.attachments
        : (safeParseJson(r.attachments) || []),
      metadata: (typeof r.metadata === 'string')
        ? safeParseJson(r.metadata)
        : r.metadata
    }));

    res.json({ items, limit, offset });
  } catch (e) {
    console.error('GET /returns/:id/messages ERRO:', e);
    const reveal = String(process.env.REVEAL_ERRORS ?? 'false').toLowerCase() === 'true';
    const msg = e?.code === 'TABLE_MISSING'
      ? e.message
      : (reveal ? (e?.detail || e?.message || String(e)) : 'Falha ao listar mensagens');
    res.status(500).json({ error: msg });
  }
});

/** POST /api/returns/:id/messages */
router.post('/returns/:id/messages', async (req, res) => {
  try {
    await assertTableExists(req);

    const q = qOf(req);
    const returnId = parseInt(req.params.id, 10);
    if (!Number.isInteger(returnId)) {
      return res.status(400).json({ error: 'return_id inválido' });
    }

    const bodyText = String(req.body?.body || '').trim();
    if (!bodyText) return res.status(400).json({ error: 'body vazio' });
    if (bodyText.length > 5000) return res.status(413).json({ error: 'body muito grande' });

    const channelReq = String(req.body?.channel || 'internal');

    const has = await tableHasColumns(
      'return_messages',
      [
        'tenant_id','parent_id','conversation_id','created_by',
        'attachments','metadata','channel','sender_role','sender_name',
        'direction','body','created_at','return_id'
      ],
      req
    );
    const types = await columnTypes('return_messages', ['tenant_id'], req);
    const { id_num, text } = resolveTenantCtx(req);
    const user = req.session?.user || {};

    const cols = [];
    const vals = [];
    const args = [];
    const add = (col, val, cast = '') => {
      cols.push(col);
      args.push(val);
      vals.push(`$${args.length}${cast}`);
    };

    if (has.tenant_id) {
      if (isNumericType(types['tenant_id'])) {
        if (id_num == null) return res.status(400).json({ error: 'tenant_id ausente' });
        add('tenant_id', id_num, '::bigint');
      } else if (isUuidType(types['tenant_id'])) {
        const uuidText = process.env.TENANT_UUID_FALLBACK || text;
        if (!uuidText) return res.status(400).json({ error: 'tenant_id (uuid) ausente' });
        add('tenant_id', String(uuidText));
      } else {
        add('tenant_id', String(text));
      }
    }

    add('return_id', returnId);

    if (has.parent_id)       add('parent_id', null);
    if (has.conversation_id) add('conversation_id', null);

    if (has.channel)    add('channel', channelReq);
    if (has.direction)  add('direction', 'out');
    if (has.sender_name) add('sender_name', user.name || 'Você');
    if (has.sender_role) add('sender_role', user.role || 'operador');

    add('body', bodyText);

    const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
    const metadata    = req.body?.metadata ?? null;

    if (has.attachments) add('attachments', JSON.stringify(attachments), '::jsonb');
    if (has.metadata)    add('metadata',    JSON.stringify(metadata),    '::jsonb');
    if (has.created_by)  add('created_by', user.id ?? null, '::int');

    if (has.created_at) {
      cols.push('created_at');
      vals.push('now()');
    }

    const sql = `
      INSERT INTO return_messages (${cols.join(', ')})
      VALUES (${vals.join(', ')})
      RETURNING
        id,
        return_id  AS "returnId",
        ${has.parent_id       ? 'parent_id AS "parentId"'           : 'NULL::int AS "parentId"'},
        ${has.conversation_id ? 'conversation_id AS "conversationId"' : 'NULL::int AS "conversationId"'},
        ${has.channel         ? 'channel'                           : `'internal'::text AS channel`},
        ${has.direction       ? 'direction'                         : `'out'::text AS direction`},
        ${has.sender_name     ? 'sender_name AS "senderName"'       : 'NULL::text AS "senderName"'},
        ${has.sender_role     ? 'sender_role AS "senderRole"'       : 'NULL::text AS "senderRole"'},
        body,
        ${has.attachments ? 'attachments' : `'[]'::jsonb AS attachments`},
        ${has.metadata    ? 'metadata'    : `NULL::jsonb AS metadata`},
        ${has.created_at  ? 'created_at AS "createdAt"' : 'now() AS "createdAt"'},
        ${has.created_by  ? 'created_by AS "createdBy"' : 'NULL::int AS "createdBy"'}
    `;

    const { rows } = await q(sql, args);
    const saved = rows[0];
    saved.attachments = Array.isArray(saved.attachments)
      ? saved.attachments
      : (safeParseJson(saved.attachments) || []);
    saved.metadata = (typeof saved.metadata === 'string')
      ? safeParseJson(saved.metadata)
      : saved.metadata;

    res.status(201).json(saved);
  } catch (e) {
    console.error('POST /returns/:id/messages ERRO:', e);
    const reveal = String(process.env.REVEAL_ERRORS ?? 'false').toLowerCase() === 'true';
    const msg = e?.code === 'TABLE_MISSING'
      ? e.message
      : (reveal ? (e?.detail || e?.message || String(e)) : 'Falha ao enviar mensagem');
    res.status(500).json({ error: msg });
  }
});

module.exports = router;
