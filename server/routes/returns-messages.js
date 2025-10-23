// server/routes/returns-messages.js
'use strict';

const { query } = require('../db');
const { broadcast } = require('../events');

/* -------------------- helpers -------------------- */
async function tableHasColumns(table, columns) {
  const { rows } = await query(
    `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1`,
    [table]
  );
  const set = new Set(rows.map(r => r.column_name));
  const out = {};
  for (const c of columns) out[c] = set.has(c);
  return out;
}

async function columnTypes(table, cols) {
  const { rows } = await query(
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

async function assertTableExists() {
  const has = await tableHasColumns('return_messages', ['return_id','body','created_at']);
  if (!has.return_id || !has.body) {
    const e = new Error('Tabela return_messages ausente ou incompleta');
    e.code = 'TABLE_MISSING';
    throw e;
  }
}

/* ================================================================
   ROTAS – exporta função (mesmo padrão do returns.js)
   ================================================================ */
module.exports = function registerReturnMessages(app) {
  /** GET /api/returns/:id/messages */
  app.get('/api/returns/:id/messages', async (req, res) => {
    try {
      await assertTableExists();

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
        ]
      );
      const types = await columnTypes('return_messages', ['tenant_id']);

      // Multitenancy (opcional). Se não houver sessão/tenant, não filtra.
      const user   = req.session?.user || {};
      const tSlug  = (req.tenant?.slug || user.company || (user.email?.split('@')[0]) || 'default');
      const tIdNum = (req.tenant?.id ?? user.tenant_id ?? null);

      const where = [`return_id = $1`];
      const params = [returnId];

      if (has.tenant_id) {
        if (isNumericType(types['tenant_id'])) {
          if (tIdNum != null) {
            where.push(`tenant_id = $${params.length + 1}::bigint`);
            params.push(tIdNum);
          }
        } else if (isUuidType(types['tenant_id'])) {
          // aceita TENANT_UUID_FALLBACK ou slug, se for um UUID válido; caso não, não filtra
          const uuidText = process.env.TENANT_UUID_FALLBACK || '';
          if (uuidText) {
            where.push(`tenant_id::text = $${params.length + 1}`);
            params.push(uuidText);
          }
        } else {
          // string
          if (tSlug) {
            where.push(`tenant_id::text = $${params.length + 1}`);
            params.push(String(tSlug));
          }
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

      const { rows } = await query(sql, [...params, limit, offset]);

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
      console.error('GET /api/returns/:id/messages ERRO:', e);
      const reveal = String(process.env.REVEAL_ERRORS ?? 'false').toLowerCase() === 'true';
      const msg = e?.code === 'TABLE_MISSING'
        ? e.message
        : (reveal ? (e?.detail || e?.message || String(e)) : 'Falha ao listar mensagens');
      res.status(500).json({ error: msg });
    }
  });

  /** POST /api/returns/:id/messages */
  app.post('/api/returns/:id/messages', async (req, res) => {
    try {
      await assertTableExists();

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
        ]
      );
      const types = await columnTypes('return_messages', ['tenant_id']);

      // dados de usuário/tenant (opcional)
      const user   = req.session?.user || {};
      const tSlug  = (req.tenant?.slug || user.company || (user.email?.split('@')[0]) || 'default');
      const tIdNum = (req.tenant?.id ?? user.tenant_id ?? null);

      const cols = [];
      const vals = [];
      const args = [];
      const add = (col, val, cast = '') => { cols.push(col); args.push(val); vals.push(`$${args.length}${cast}`); };

      if (has.tenant_id) {
        if (isNumericType(types['tenant_id'])) {
          if (tIdNum != null) add('tenant_id', tIdNum, '::bigint');
        } else if (isUuidType(types['tenant_id'])) {
          const uuidText = process.env.TENANT_UUID_FALLBACK || '';
          if (uuidText) add('tenant_id', String(uuidText));
        } else {
          if (tSlug) add('tenant_id', String(tSlug));
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

      if (has.created_at) { cols.push('created_at'); vals.push('now()'); }

      const sql = `
        INSERT INTO return_messages (${cols.join(', ')})
        VALUES (${vals.join(', ')})
        RETURNING
          id,
          return_id  AS "returnId",
          ${has.parent_id       ? 'parent_id AS "parentId"'             : 'NULL::int AS "parentId"'},
          ${has.conversation_id ? 'conversation_id AS "conversationId"' : 'NULL::int AS "conversationId"'},
          ${has.channel         ? 'channel'                             : `'internal'::text AS channel`},
          ${has.direction       ? 'direction'                           : `'out'::text AS direction`},
          ${has.sender_name     ? 'sender_name AS "senderName"'         : 'NULL::text AS "senderName"'},
          ${has.sender_role     ? 'sender_role AS "senderRole"'         : 'NULL::text AS "senderRole"'},
          body,
          ${has.attachments ? 'attachments' : `'[]'::jsonb AS attachments`},
          ${has.metadata    ? 'metadata'    : `NULL::jsonb AS metadata`},
          ${has.created_at  ? 'created_at AS "createdAt"'               : 'now() AS "createdAt"'},
          ${has.created_by  ? 'created_by AS "createdBy"'               : 'NULL::int AS "createdBy"'}
      `;

      const { rows } = await query(sql, args);
      const saved = rows[0];

      saved.attachments = Array.isArray(saved.attachments)
        ? saved.attachments
        : (safeParseJson(saved.attachments) || []);
      saved.metadata = (typeof saved.metadata === 'string')
        ? safeParseJson(saved.metadata)
        : saved.metadata;

      // 🔔 Notifica assinantes SSE (front atualiza automaticamente)
      broadcast('return_message', { return_id: returnId, message: saved });

      res.status(201).json({ item: saved });
    } catch (e) {
      console.error('POST /api/returns/:id/messages ERRO:', e);
      const reveal = String(process.env.REVEAL_ERRORS ?? 'false').toLowerCase() === 'true';
      const msg = e?.code === 'TABLE_MISSING'
        ? e.message
        : (reveal ? (e?.detail || e?.message || String(e)) : 'Falha ao enviar mensagem');
      res.status(500).json({ error: msg });
    }
  });
};
