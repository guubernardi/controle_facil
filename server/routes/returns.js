// server/routes/returns.js
'use strict';

const express = require('express');
const router  = express.Router();
const { query } = require('../db');

// Usa o pool da request (quando existir) ou o global
const qOf = (req) => req.q || query;

/* ================= helpers ================= */
async function columnsOf(q, table) {
  const { rows } = await q(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1`,
    [table]
  );
  return new Set(rows.map(r => r.column_name));
}

async function hasTable(q, table) {
  const { rows } = await q(
    `SELECT 1
       FROM information_schema.tables
      WHERE table_schema='public' AND table_name=$1
      LIMIT 1`,
    [table]
  );
  return !!rows.length;
}

let HAS_TENANT_COL = null;
async function hasTenantColumn(q) {
  if (HAS_TENANT_COL !== null) return HAS_TENANT_COL;
  try {
    const cols = await columnsOf(q, 'devolucoes');
    HAS_TENANT_COL = cols.has('tenant_id');
  } catch (e) {
    console.warn('[returns] tenant_id check failed:', e.message || e);
    HAS_TENANT_COL = false;
  }
  return HAS_TENANT_COL;
}

function getTenantId(req) {
  return req.session?.user?.tenant_id || req.tenant?.id || null;
}

/* =============== 1) LISTAGEM (Kanban / Lista) =============== */
router.get('/', async (req, res) => {
  try {
    const q         = qOf(req);
    const limit     = parseInt(req.query.limit || '50', 10);
    const offset    = parseInt(req.query.offset || '0', 10);
    const search    = (req.query.search || '').trim();
    const status    = (req.query.status || '').trim();
    const rangeDays = parseInt(req.query.range_days || '0', 10);

    const cols = await columnsOf(q, 'devolucoes');
    const has  = (c) => cols.has(c);

    // monta SELECT seguro
    const selectCols = [];
    ['id','id_venda','cliente_nome','loja_nome','sku','status','log_status',
     'updated_at','created_at','valor_produto','valor_frete'
    ].forEach(c => { if (has(c)) selectCols.push(c); });

    if (has('foto_produto'))     selectCols.push('foto_produto');
    if (has('ml_return_status')) selectCols.push('ml_return_status');
    if (has('ml_claim_id'))      selectCols.push('ml_claim_id');

    if (!selectCols.length) selectCols.push('*');

    const params       = [];
    const whereClauses = [];

    // tenant
    const tenantId  = getTenantId(req);
    const hasTenant = await hasTenantColumn(q);
    if (tenantId && hasTenant) {
      whereClauses.push(`(tenant_id = $${params.length + 1} OR tenant_id IS NULL)`);
      params.push(tenantId);
    }

    // busca textual / por ID (defensivo em colunas opcionais)
    if (search) {
      const orPieces = [];

      const likeIdx = params.length + 1;
      const likes = [];
      if (has('id_venda'))     likes.push(`id_venda ILIKE $${likeIdx}`);
      if (has('sku'))          likes.push(`sku ILIKE $${likeIdx}`);
      if (has('cliente_nome')) likes.push(`cliente_nome ILIKE $${likeIdx}`);
      if (has('nfe_chave'))    likes.push(`nfe_chave ILIKE $${likeIdx}`);
      if (likes.length) {
        orPieces.push('(' + likes.join(' OR ') + ')');
        params.push(`%${search}%`);
      }

      if (/^\d+$/.test(search)) {
        // pesquisa direta por ID interno
        orPieces.push(`id = $${params.length + 1}::bigint`);
        params.push(search);
      }

      if (orPieces.length) whereClauses.push('(' + orPieces.join(' OR ') + ')');
    }

    // filtro por data (usa created_at se existir, senão updated_at)
    if (rangeDays > 0) {
      const dcol = has('created_at') ? 'created_at' : (has('updated_at') ? 'updated_at' : null);
      if (dcol) whereClauses.push(`${dcol} >= NOW() - INTERVAL '${rangeDays} days'`);
    }

    // filtro por status (defensivo p/ colunas opcionais)
    if (status) {
      if (status === 'em_transporte') {
        let clause = `(status = 'em_transporte'`;
        if (has('ml_return_status')) clause += ` OR ml_return_status IN ('shipped','pending_delivered','on_transit')`;
        clause += ')';
        whereClauses.push(clause);
      } else if (status === 'disputa') {
        let clause = `(status IN ('disputa','mediacao')`;
        if (has('ml_return_status')) clause += ` OR ml_return_status IN ('dispute','mediation','pending','open')`;
        clause += ')';
        whereClauses.push(clause);
      } else if (status === 'concluida') {
        let clause = `(`;
        clause += `status IN ('concluida','finalizado','aprovado','rejeitado')`;
        if (has('log_status')) clause += ` OR log_status = 'recebido_cd'`;
        if (has('ml_return_status')) clause += ` OR ml_return_status = 'delivered'`;
        clause += `)`;
        whereClauses.push(clause);
      } else if (status !== 'todos') {
        const opts = [];
        if (has('status'))     opts.push(`status = $${params.length + 1}`);
        if (has('log_status')) opts.push(`log_status = $${params.length + 1}`);
        if (opts.length) {
          whereClauses.push('(' + opts.join(' OR ') + ')');
          params.push(status);
        }
      }
    }

    const whereSql = whereClauses.length ? 'WHERE ' + whereClauses.join(' AND ') : '';
    const orderCol = has('updated_at') ? 'updated_at' : (has('created_at') ? 'created_at' : 'id');

    const sql = `
      SELECT ${selectCols.join(',\n             ')}
        FROM devolucoes
        ${whereSql}
       ORDER BY ${orderCol} DESC
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
    console.error('[returns:list] ERRO', e);
    res.status(500).json({ error: 'Erro interno ao listar' });
  }
});

/* =============== 2) SYNC via ML =============== */
router.get('/sync', (req, res) => {
  const { days = '7', silent = '0' } = req.query;
  const qs = new URLSearchParams();
  if (days) qs.set('days', String(days));
  qs.set('all', '1');
  if (silent) qs.set('silent', String(silent));
  return res.redirect(`/api/ml/claims/import?${qs.toString()}`);
});

/* =============== 3) DETALHES =============== */
async function buildSafeSelect(q) {
  const cols = await columnsOf(q, 'devolucoes');
  const has  = (c) => cols.has(c);

  const base = [
    'id','id_venda','cliente_nome','loja_nome','data_compra',
    'status','sku','tipo_reclamacao','nfe_numero','nfe_chave',
    'reclamacao','valor_produto','valor_frete','log_status'
  ].filter(has);

  const opt = [];
  if (has('tenant_id'))        opt.push('tenant_id');
  if (has('ml_claim_id'))      opt.push('ml_claim_id');
  if (has('claim_id'))         opt.push('claim_id');
  if (has('order_id'))         opt.push('order_id');
  if (has('resource_id'))      opt.push('resource_id');
  if (has('cd_recebido_em'))   opt.push('cd_recebido_em');
  if (has('cd_responsavel'))   opt.push('cd_responsavel');
  if (has('ml_return_status')) opt.push('ml_return_status');
  if (has('foto_produto'))     opt.push('foto_produto');

  const all = base.concat(opt);
  return all.length ? `SELECT ${all.join(', ')} FROM devolucoes`
                    : `SELECT * FROM devolucoes`;
}

router.get('/:id', async (req, res) => {
  try {
    const q        = qOf(req);
    const selSql   = await buildSafeSelect(q);
    const hasCols  = await columnsOf(q, 'devolucoes');
    const hasIdVenda = hasCols.has('id_venda');

    const hasTenant= await hasTenantColumn(q);
    const tenantId = getTenantId(req);
    const raw      = String(req.params.id || '').trim();
    const idNum    = /^\d+$/.test(raw) ? raw : null;

    // Estratégia robusta: tenta por ID interno (se numérico) **ou** por id_venda (se existir)
    const whereParts = [];
    const args = [];

    // 1) id interno (condição vira false quando $1 é NULL)
    args.push(idNum);
    whereParts.push(`($1::bigint IS NOT NULL AND id = $1::bigint)`);

    // 2) id_venda literal (se coluna existir)
    if (hasIdVenda) {
      args.push(raw);
      whereParts.push(`id_venda = $${args.length}`);
    }

    let whereSql = '(' + whereParts.join(' OR ') + ')';

    // 3) tenant (se aplicável)
    if (hasTenant && tenantId) {
      args.push(tenantId);
      whereSql += ` AND (tenant_id = $${args.length} OR tenant_id IS NULL)`;
    }

    const orderFrag = hasCols.has('updated_at') ? ' ORDER BY updated_at DESC' : '';
    const sql = `${selSql} WHERE ${whereSql}${orderFrag} LIMIT 1`;

    const { rows } = await q(sql, args);
    if (!rows.length) return res.status(404).json({ error: 'Não encontrado' });
    res.json(rows[0]);
  } catch (e) {
    console.error('[returns:get] ERRO', e);
    res.status(500).json({ error: 'Erro interno ao buscar' });
  }
});

/* =============== 3b) PATCH /:id (whitelist + colunas opcionais) =============== */
router.patch('/:id', express.json(), async (req, res) => {
  try {
    const q   = qOf(req);
    const id  = String(req.params.id || '').trim();
    if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'invalid_id' });

    const cols = await columnsOf(q, 'devolucoes');
    const has  = (c) => cols.has(c);
    const body = req.body || {};

    const set  = [];
    const args = [];

    function push(col, val, transform) {
      if (!has(col) || val === undefined) return;
      args.push(transform ? transform(val) : val);
      set.push(`${col} = $${args.length}`);
    }

    // meta
    push('id_venda',        body.id_venda);
    push('cliente_nome',    body.cliente_nome);
    push('loja_nome',       body.loja_nome);
    push('data_compra',     body.data_compra);
    push('status',          body.status);
    push('sku',             body.sku, v => String(v || '').toUpperCase());
    push('tipo_reclamacao', body.tipo_reclamacao);
    push('nfe_numero',      body.nfe_numero);
    push('nfe_chave',       body.nfe_chave);
    push('reclamacao',      body.reclamacao);

    // valores
    push('valor_produto',   body.valor_produto, Number);
    push('valor_frete',     body.valor_frete, Number);

    // fluxo
    push('log_status',      body.log_status);

    // CD
    push('cd_recebido_em',  body.cd_recebido_em || null);
    push('cd_responsavel',  body.cd_responsavel || null);

    if (cols.has('updated_at')) set.push('updated_at = NOW()');

    if (!set.length) return res.status(400).json({ error: 'empty_patch' });

    const where = [];
    const whereArgs = [];
    whereArgs.push(Number(id));
    where.push(`id = $${whereArgs.length}`);

    const hasTenant = await hasTenantColumn(q);
    const tenantId  = getTenantId(req);
    if (hasTenant && tenantId) {
      whereArgs.push(tenantId);
      where.push(`(tenant_id = $${whereArgs.length} OR tenant_id IS NULL)`);
    }

    const sql = `UPDATE devolucoes SET ${set.join(', ')} WHERE ${where.join(' AND ')} RETURNING *`;
    const { rows } = await q(sql, [...args, ...whereArgs]);
    if (!rows.length) return res.status(404).json({ error: 'Não encontrado' });
    res.json(rows[0]);
  } catch (e) {
    console.error('[returns:patch] ERRO', e);
    res.status(500).json({ error: 'Erro ao atualizar' });
  }
});

/* =============== 4) RECEBIMENTO NO CD =============== */
router.patch('/:id/cd/receive', express.json(), async (req, res) => {
  try {
    const q   = qOf(req);
    const id  = String(req.params.id || '').trim();
    if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'invalid_id' });

    const { responsavel, when, updated_by } = req.body || {};
    const cols = await columnsOf(q, 'devolucoes');
    const has  = (c) => cols.has(c);

    if (!has('cd_recebido_em') || !has('cd_responsavel')) {
      return res.status(400).json({ error: 'columns_missing' });
    }

    const set = [
      'cd_recebido_em = $1',
      'cd_responsavel = $2'
    ];
    const args = [ when || new Date().toISOString(), responsavel || 'cd' ];

    if (has('log_status')) set.push(`log_status = 'recebido_cd'`);
    if (has('updated_at')) set.push('updated_at = NOW()');

    const where = [];
    const wargs = [ Number(id) ];
    where.push(`id = $${wargs.length}`);

    const hasTenant = await hasTenantColumn(q);
    const tenantId  = getTenantId(req);
    if (hasTenant && tenantId) {
      wargs.push(tenantId);
      where.push(`(tenant_id = $${wargs.length} OR tenant_id IS NULL)`);
    }

    const { rows } = await q(
      `UPDATE devolucoes
          SET ${set.join(', ')}
        WHERE ${where.join(' AND ')}
        RETURNING *`,
      [...args, ...wargs]
    );

    if (!rows.length) return res.status(404).json({ error: 'Não encontrado' });

    // timeline (tenta nas duas tabelas conhecidas)
    try {
      const hasRetEvents  = await hasTable(q, 'return_events');
      const hasDevEvents  = await hasTable(q, 'devolucoes_events');

      if (hasRetEvents) {
        await q(
          `INSERT INTO return_events (return_id, type, title, message, created_by)
           VALUES ($1, 'logistica', 'Recebido no CD', $2, $3)`,
          [ id, `Pacote conferido por ${responsavel || 'cd'}`, updated_by || 'scanner' ]
        );
      } else if (hasDevEvents) {
        await q(
          `INSERT INTO devolucoes_events (return_id, type, title, message, created_by)
           VALUES ($1,$2,$3,$4,$5)`,
          [ id, 'logistica', 'Recebido no CD', `Pacote conferido por ${responsavel || 'cd'}`, updated_by || 'scanner' ]
        );
      }
    } catch (err) {
      console.warn('[returns:receive] evento não gravado:', err.message || err);
    }

    res.json(rows[0]);
  } catch (e) {
    console.error('[returns:receive] ERRO', e);
    res.status(500).json({ error: 'Erro ao registrar recebimento' });
  }
});

/* =============== 5) TIMELINE (/api/returns/:id/events) =============== */
router.get('/:id/events', async (req, res) => {
  try {
    const q   = qOf(req);
    const id  = String(req.params.id || '').trim();
    if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'invalid_id' });

    const hasRetEvents = await hasTable(q, 'return_events');
    const hasDevEvents = await hasTable(q, 'devolucoes_events');

    if (!hasRetEvents && !hasDevEvents) return res.json({ items: [] });

    const params = [ Number(id) ];
    let sql;
    if (hasRetEvents) {
      sql = `SELECT * FROM return_events WHERE return_id = $1 ORDER BY created_at DESC NULLS LAST, id DESC`;
    } else {
      sql = `SELECT * FROM devolucoes_events WHERE return_id = $1 ORDER BY created_at DESC NULLS LAST, id DESC`;
    }

    const { rows } = await q(sql, params);
    res.json({ items: rows || [] });
  } catch (e) {
    console.error('[returns:events] ERRO', e);
    res.status(500).json({ items: [] });
  }
});

module.exports = router;
