// server/routes/returns.js
'use strict';

const express = require('express');
const router  = express.Router();
const { query } = require('../db');

// Usa o pool da request (quando existir) ou o global
const qOf = (req) => req.q || query;

/** Helper genérico para testar colunas de uma tabela */
async function tableHasColumns(q, table, cols) {
  const { rows } = await q(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = $1`,
    [table]
  );
  const set = new Set(rows.map(r => r.column_name));
  const out = {};
  for (const c of cols) out[c] = set.has(c);
  return out;
}

// cache simples para saber se devolucoes tem tenant_id
let HAS_TENANT_COL = null;

async function hasTenantColumn(q) {
  if (HAS_TENANT_COL !== null) return HAS_TENANT_COL;
  try {
    const cols = await tableHasColumns(q, 'devolucoes', ['tenant_id']);
    HAS_TENANT_COL = !!cols.tenant_id;
  } catch (err) {
    console.warn('[returns] Falha ao checar tenant_id:', err.message || err);
    HAS_TENANT_COL = false;
  }
  return HAS_TENANT_COL;
}

// ==========================================
// 1. LISTAGEM (Kanban / Lista)
// ==========================================
router.get('/', async (req, res) => {
  try {
    const q         = qOf(req);
    const limit     = parseInt(req.query.limit || '50', 10);
    const offset    = parseInt(req.query.offset || '0', 10);
    const search    = (req.query.search || '').trim();
    const status    = (req.query.status || '').trim();
    const rangeDays = parseInt(req.query.range_days || '0', 10);

    const params       = [];
    const whereClauses = [];

    // Filtro por Tenant (se coluna existir)
    const tenantId  = req.session?.user?.tenant_id || req.tenant?.id || null;
    const hasTenant = await hasTenantColumn(q);
    if (tenantId && hasTenant) {
      whereClauses.push(`(tenant_id = $${params.length + 1} OR tenant_id IS NULL)`);
      params.push(tenantId);
    }

    // Busca (Texto)
    if (search) {
      whereClauses.push(`(
        id_venda     ILIKE $${params.length + 1} OR 
        sku          ILIKE $${params.length + 1} OR 
        cliente_nome ILIKE $${params.length + 1} OR
        nfe_chave    ILIKE $${params.length + 1} OR
        CAST(id AS TEXT) = $${params.length + 1}
      )`);
      params.push(`%${search}%`);
    }

    // Filtro por Data
    if (rangeDays > 0) {
      whereClauses.push(`created_at >= NOW() - INTERVAL '${rangeDays} days'`);
    }

    // Filtro por Status (seria usado se você quiser filtrar no back,
    // mas hoje as abas filtram no front. Mantive por compat.)
    if (status) {
      if (status === 'em_transporte') {
        whereClauses.push(`(
          status = 'em_transporte'
          OR ml_return_status IN ('shipped', 'pending_delivered', 'on_transit')
        )`);
      } else if (status === 'disputa') {
        whereClauses.push(`(
          status IN ('disputa', 'mediacao')
          OR ml_return_status IN ('dispute', 'mediation', 'pending', 'open')
        )`);
      } else if (status === 'concluida') {
        whereClauses.push(`(
          status IN ('concluida', 'finalizado', 'aprovado', 'rejeitado')
          OR log_status = 'recebido_cd'
          OR ml_return_status = 'delivered'
        )`);
      } else if (status !== 'todos') {
        whereClauses.push(`(status = $${params.length + 1} OR log_status = $${params.length + 1})`);
        params.push(status);
      }
    }

    const whereSql = whereClauses.length
      ? 'WHERE ' + whereClauses.join(' AND ')
      : '';

    const sql = `
      SELECT id, id_venda, cliente_nome, loja_nome, sku,
             status, log_status, ml_return_status, ml_claim_id,
             updated_at, created_at, valor_produto, valor_frete
        FROM devolucoes
        ${whereSql}
       ORDER BY updated_at DESC
       LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `;

    const countSql = `SELECT COUNT(*) AS total FROM devolucoes ${whereSql}`;

    const [rowsRes, countRes] = await Promise.all([
      q(sql,      [...params, limit, offset]),
      q(countSql, params)
    ]);

    res.json({
      items: rowsRes.rows,
      total: parseInt(countRes.rows[0]?.total || 0, 10)
    });
  } catch (e) {
    console.error('[API] Erro listar devoluções:', e);
    res.status(500).json({ error: 'Erro interno ao listar' });
  }
});

// ==========================================
// 2. SYNC (importar devoluções via ML Sync)
// ==========================================
// IMPORTANTE: precisa vir ANTES de '/:id'
router.get('/sync', (req, res) => {
  const { days = '7', silent = '0' } = req.query;

  const qs = new URLSearchParams();
  if (days) qs.set('days', String(days));
  qs.set('all', '1'); // roda para TODAS as contas conectadas
  if (silent) qs.set('silent', String(silent));

  // endpoint real do import está em /api/ml/claims/import
  return res.redirect(`/api/ml/claims/import?${qs.toString()}`);
});

// ==========================================
// 3. DETALHES E EDIÇÃO
// ==========================================
router.get('/:id', async (req, res) => {
  try {
    const q        = qOf(req);
    const tenantId = req.session?.user?.tenant_id || req.tenant?.id || null;
    const idParam  = req.params.id;

    const hasTenant = await hasTenantColumn(q);

    let rows;
    if (tenantId && hasTenant) {
      const { rows: r } = await q(
        `SELECT *
           FROM devolucoes
          WHERE (id = $1 OR id_venda = $1)
            AND (tenant_id = $2 OR tenant_id IS NULL)
          LIMIT 1`,
        [idParam, tenantId]
      );
      rows = r;
    } else {
      const { rows: r } = await q(
        'SELECT * FROM devolucoes WHERE id = $1 OR id_venda = $1 LIMIT 1',
        [idParam]
      );
      rows = r;
    }

    if (!rows.length) {
      return res.status(404).json({ error: 'Não encontrado' });
    }
    res.json(rows[0]);
  } catch (e) {
    console.error('[API] Erro buscar devolução:', e);
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const q      = qOf(req);
    const { id } = req.params;
    const body   = req.body;

    const sets = ['updated_at = NOW()'];
    const vals = [id];
    let idx    = 2;

    // Campos permitidos para update
    const allowed = [
      'status',
      'log_status',
      'updated_by',
      'valor_produto',
      'valor_frete',
      'reclamacao'
    ];

    for (const field of allowed) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        sets.push(`${field} = $${idx++}`);
        vals.push(body[field]);
      }
    }

    if (sets.length === 1) {
      // nada para atualizar
      return res.json({ ok: true });
    }

    const sql = `
      UPDATE devolucoes
         SET ${sets.join(', ')}
       WHERE id = $1
       RETURNING *
    `;
    const { rows } = await q(sql, vals);

    if (!rows.length) {
      return res.status(404).json({ error: 'Não encontrado' });
    }

    res.json(rows[0]);
  } catch (e) {
    console.error('[API] Erro update devolução:', e);
    res.status(500).json({ error: 'Erro ao atualizar' });
  }
});

// ==========================================
// 4. AÇÕES ESPECÍFICAS (Scanner/Logística)
// ==========================================
router.patch('/:id/cd/receive', async (req, res) => {
  try {
    const q = qOf(req);
    const { id } = req.params;
    const { responsavel, when, updated_by } = req.body;

    await q(`
      UPDATE devolucoes
         SET cd_recebido_em = $1,
             cd_responsavel = $2,
             log_status     = 'recebido_cd',
             updated_at     = NOW()
       WHERE id = $3
    `, [when || new Date(), responsavel || 'cd', id]);

    // Loga na timeline (se a tabela existir)
    try {
      await q(`
        INSERT INTO return_events (return_id, type, title, message, created_by)
        VALUES ($1, 'logistica', 'Recebido no CD', $2, $3)
      `, [
        id,
        `Pacote conferido por ${responsavel || 'cd'}`,
        updated_by || 'scanner'
      ]);
    } catch (err) {
      console.warn('Sem tabela de eventos ou erro ao gravar evento:', err.message);
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('[API] Erro receive devolução:', e);
    res.status(500).json({ error: 'Erro ao registrar recebimento' });
  }
});

module.exports = router;
