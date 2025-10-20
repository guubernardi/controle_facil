// server/routes/returns-messages.js
'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../db');

// usa a conexão do middleware de tenant se existir
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

/** resolve contexto do tenant de forma ampla */
function resolveTenantCtx(req) {
  const t = req.tenant || {};
  const user = req.session?.user || {};

  // valores possíveis
  const id_num   = (t.id ?? user.tenant_id);
  const slug     = t.slug || user.company || user.email || '';
  const text     = String(slug || '').split('@')[0] || null;
  const num_hint = (() => {
    const onlyDigits = (text || '').replace(/\D/g, '');
    return onlyDigits ? Number(onlyDigits) : null;
  })();

  return { id_num, text, num_hint };
}

/** monta cláusulas WHERE para tenant_id com cast correto */
function whereForTenant(tenantColType, retTenant, paramIndexStart = 2) {
  const where = [];
  const params = [];

  if (isNumericType(tenantColType)) {
    // preferir id_num, depois num_hint, depois fallback 1
    const val = (retTenant.id_num != null)
      ? retTenant.id_num
      : (retTenant.num_hint != null ? retTenant.num_hint : 1);
    where.push(`tenant_id = $${paramIndexStart}::bigint`);
    params.push(val);
  } else if (isUuidType(tenantColType)) {
    // se não tiver, cai para um UUID impossível
    where.push(`tenant_id::text = $${paramIndexStart}`);
    params.push(retTenant.text || '00000000-0000-0000-0000-000000000000');
  } else {
    // texto
    where.push(`tenant_id::text = $${paramIndexStart}`);
    params.push(retTenant.text || 'default');
  }

  return { where, params };
}

/* -------------------- rotas -------------------- */

/**
 * GET /api/returns/:id/messages
 * Retorna as mensagens do chat da devolução
 */
router.get('/api/returns/:id/messages', async (req, res) => {
  try {
    const q = qOf(req);
    const returnId = parseInt(req.params.id, 10);
    if (!Number.isInteger(returnId)) {
      return res.status(400).json({ error: 'return_id inválido' });
    }

    const has = await tableHasColumns('return_messages',
      ['tenant_id', 'created_by', 'attachments', 'metadata'], req);
    const types = await columnTypes('return_messages', ['tenant_id'], req);
    const retTenant = resolveTenantCtx(req);

    const baseWhere = [`return_id = $1`];
    const params = [returnId];

    if (has.tenant_id) {
      const { where, params: tParams } = whereForTenant(types['tenant_id'], retTenant, 2);
      baseWhere.push(where[0]);
      params.push(tParams[0]);
    }

    const sql = `
      SELECT
        id,
        return_id  AS "returnId",
        parent_id  AS "parentId",
        direction,
        sender_name AS "senderName",
        sender_role AS "senderRole",
        body,
        ${has.attachments ? 'attachments' : `'[]'::jsonb AS attachments`},
        ${has.metadata    ? 'metadata'    : 'NULL::jsonb AS metadata'},
        created_at AS "createdAt",
        ${has.created_by ? 'created_by AS "createdBy"' : 'NULL::int AS "createdBy"'}
      FROM return_messages
      WHERE ${baseWhere.join(' AND ')}
      ORDER BY created_at ASC, id ASC
    `;

    const { rows } = await q(sql, params);
    // normaliza JSON caso venha string
    const items = rows.map(r => ({
      ...r,
      attachments: typeof r.attachments === 'string' ? safeParseJson(r.attachments) || [] : (r.attachments || []),
      metadata: typeof r.metadata === 'string' ? safeParseJson(r.metadata) : r.metadata
    }));

    return res.json({ items });
  } catch (e) {
    console.error('GET /returns/:id/messages ERRO:', e);
    res.status(500).json({ error: 'Falha ao listar mensagens' });
  }
});

function safeParseJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * POST /api/returns/:id/messages
 * Envia uma mensagem para o chat da devolução
 */
router.post('/api/returns/:id/messages', async (req, res) => {
  try {
    const q = qOf(req);
    const returnId = parseInt(req.params.id, 10);
    if (!Number.isInteger(returnId)) {
      return res.status(400).json({ error: 'return_id inválido' });
    }
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'body vazio' });

    const has   = await tableHasColumns('return_messages',
      ['tenant_id','created_by','attachments','metadata'], req);
    const types = await columnTypes('return_messages', ['tenant_id'], req);
    const retTenant = resolveTenantCtx(req);
    const user = req.session?.user || {};

    // monta lista de colunas/valores dinamicamente
    const cols = ['return_id', 'parent_id', 'direction', 'sender_name', 'sender_role', 'body', 'attachments', 'metadata', 'created_at'];
    const ph   = ['$1',        '$2',        '$3',        '$4',          '$5',          '$6',   '$7::jsonb', '$8::jsonb', 'now()'];
    const args = [returnId, null, 'out', user.name || 'Você', user.role || 'operador', body, JSON.stringify([]), JSON.stringify(null)];

    let next = 9; // próximo placeholder

    // tenant_id primeiro (se existir)
    if (has.tenant_id) {
      cols.unshift('tenant_id'); // adiciona no início
      if (isNumericType(types['tenant_id'])) {
        const val = (retTenant.id_num != null)
          ? retTenant.id_num
          : (retTenant.num_hint != null ? retTenant.num_hint : 1);
        ph.unshift(`$${next}::bigint`);
        args.push(val);
      } else if (isUuidType(types['tenant_id'])) {
        ph.unshift(`$${next}`);
        args.push(retTenant.text || '00000000-0000-0000-0000-000000000000');
      } else {
        ph.unshift(`$${next}`);
        args.push(retTenant.text || 'default');
      }
      next++;
    }

    // created_by se existir
    if (has.created_by) {
      cols.push('created_by');
      ph.push(`$${next}::int`);
      args.push(user.id || null);
      next++;
    }

    const sql = `
      INSERT INTO return_messages (${cols.join(', ')})
      VALUES (${ph.join(', ')})
      RETURNING id,
        return_id  AS "returnId",
        parent_id  AS "parentId",
        direction,
        sender_name AS "senderName",
        sender_role AS "senderRole",
        body,
        ${has.attachments ? 'attachments' : `'[]'::jsonb AS attachments`},
        ${has.metadata    ? 'metadata'    : 'NULL::jsonb AS metadata'},
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
