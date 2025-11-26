// server/routes/returns.js
'use strict';

const express = require('express');
const router  = express.Router();
const { query } = require('../db');

// Usa o pool da request (quando existir) ou o global
const qOf = (req) => req.q || query;

/* ================= helpers ================= */
async function columnsOf(q, table) {
  try {
    const { rows } = await q(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1`,
      [table]
    );
    return new Set(rows.map(r => r.column_name));
  } catch (e) {
    return new Set(); // fallback
  }
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

function getTenantId(req) {
  return req.session?.user?.tenant_id || req.tenant?.id || null;
}

function humanizeReason(idOrText = '') {
  const s = String(idOrText || '').toLowerCase();
  const map = {
    different_from_description: 'Produto diferente do anunciado',
    not_as_described: 'Produto diferente do anunciado',
    wrong_item: 'Produto diferente do anunciado',
    variations_mismatch: 'Variação errada',
    size_color_mismatch: 'Variação errada',
    damaged_item: 'Produto com defeito',
    broken: 'Produto com defeito',
    incomplete_item: 'Produto incompleto',
    missing_parts: 'Produto incompleto',
    not_delivered: 'Entrega atrasada',
    undelivered: 'Entrega atrasada'
  };
  if (map[s]) return map[s];
  if (/diferente.*anunciad|not.*describ/.test(s)) return 'Produto diferente do anunciado';
  if (/cor|tamanho|variaç|variation/.test(s))     return 'Variação errada';
  if (/defeit|quebrad|broken|damag/.test(s))      return 'Produto com defeito';
  if (/incomplet|faltando|missing/.test(s))       return 'Produto incompleto';
  if (/undeliver|not.*deliver|atras/.test(s))     return 'Entrega atrasada';
  return idOrText || 'Outro';
}

/* =============== 1) LISTAGEM =============== */
router.get('/', async (req, res) => {
  try {
    const q         = qOf(req);
    const limit     = parseInt(req.query.limit || '50', 10);
    const offset    = parseInt(req.query.offset || '0', 10);
    const search    = (req.query.search || '').trim();
    const status    = (req.query.status || '').trim();
    const rangeDays = parseInt(req.query.range_days || '0', 10);
    const debug     = req.query.debug === '1';

    const cols = await columnsOf(q, 'devolucoes');
    const has  = (c) => cols.has(c);

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

    // tenant (sem cache: usa as colunas reais do momento)
    const tenantId = getTenantId(req);
    if (tenantId && has('tenant_id')) {
      whereClauses.push(`(tenant_id = $${params.length + 1} OR tenant_id IS NULL)`);
      params.push(tenantId);
    }

    if (search) {
      const likes = [];
      if (has('id_venda'))     likes.push(`id_venda ILIKE $${params.length + 1}`);
      if (has('sku'))          likes.push(`sku ILIKE $${params.length + 1}`);
      if (has('cliente_nome')) likes.push(`cliente_nome ILIKE $${params.length + 1}`);
      if (has('nfe_chave'))    likes.push(`nfe_chave ILIKE $${params.length + 1}`);
      likes.push(`CAST(id AS TEXT) = $${params.length + 1}`);
      whereClauses.push('(' + likes.join(' OR ') + ')');
      params.push(`%${search}%`);
    }

    if (rangeDays > 0) {
      const dcol = has('created_at') ? 'created_at' : (has('updated_at') ? 'updated_at' : null);
      if (dcol) whereClauses.push(`${dcol} >= NOW() - INTERVAL '${rangeDays} days'`);
    }

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
        let clause = `status IN ('concluida','finalizado','aprovado','rejeitado')`;
        if (has('log_status'))       clause = `(${clause} OR log_status = 'recebido_cd')`;
        if (has('ml_return_status')) clause = `(${clause} OR ml_return_status = 'delivered')`;
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

    const payload = {
      items: rowsRes.rows,
      total: parseInt(countRes.rows[0]?.total || 0, 10)
    };
    if (debug) payload.debug = { sql, params, countSql };

    res.json(payload);
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

/* =============== 3) DETALHES (com fallbacks) =============== */
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
  return {
    sql: all.length ? `SELECT ${all.join(', ')} FROM devolucoes` : `SELECT * FROM devolucoes`,
    hasTenant: has('tenant_id'),
    has: (name) => has(name)
  };
}

router.get('/:id', async (req, res) => {
  const debug = req.query.debug === '1';
  try {
    const q        = qOf(req);
    const { sql: selSql, hasTenant } = await buildSafeSelect(q);
    const tenantId = getTenantId(req);
    const idParam  = String(req.params.id || '').trim();
    const isNumeric = /^\d+$/.test(idParam);

    // tenta por id
    let sql1 = `${selSql} WHERE id = $1`;
    const args1 = [ Number(isNumeric ? idParam : 0) ];
    if (hasTenant && tenantId) {
      sql1 += ` AND (tenant_id = $2 OR tenant_id IS NULL)`;
      args1.push(tenantId);
    }
    sql1 += ` LIMIT 1`;

    let row = null;
    try {
      const r1 = await q(sql1, args1);
      row = r1.rows[0] || null;
    } catch (err) {
      // fallback para SELECT * (se a projeção com colunas falhou)
      try {
        const r1b = await q(
          `SELECT * FROM devolucoes WHERE id = $1 ${hasTenant && tenantId ? 'AND (tenant_id = $2 OR tenant_id IS NULL)' : ''} LIMIT 1`,
          args1
        );
        row = r1b.rows[0] || null;
        if (!debug) console.warn('[returns:get] fallback SELECT * (id)', err.message);
      } catch (err2) {
        if (debug) return res.status(500).json({ error: 'sql_error', sql: sql1, args: args1, detail: err2.message });
        throw err2;
      }
    }

    // se não achou (ou param não era numérico), tenta por id_venda
    if (!row) {
      const args2 = [ idParam ];
      let sql2 = `${selSql} WHERE id_venda = $1`;
      if (hasTenant && tenantId) {
        sql2 += ` AND (tenant_id = $2 OR tenant_id IS NULL)`;
        args2.push(tenantId);
      }
      sql2 += ` LIMIT 1`;

      try {
        const r2 = await q(sql2, args2);
        row = r2.rows[0] || null;
      } catch (err) {
        try {
          const r2b = await q(
            `SELECT * FROM devolucoes WHERE id_venda = $1 ${hasTenant && tenantId ? 'AND (tenant_id = $2 OR tenant_id IS NULL)' : ''} LIMIT 1`,
            args2
          );
          row = r2b.rows[0] || null;
          if (!debug) console.warn('[returns:get] fallback SELECT * (id_venda)', err.message);
        } catch (err2) {
          if (debug) return res.status(500).json({ error:'sql_error', sql: sql2, args: args2, detail: err2.message });
          throw err2;
        }
      }
    }

    if (!row) return res.status(404).json({ error: 'Não encontrado' });

    // motivo “derivado” para o front ter algo mesmo sem enrich ML
    const rawMotivo = row.tipo_reclamacao || row.reclamacao || row.ml_return_status || '';
    const motivo_label = humanizeReason(rawMotivo);

    res.json({ ...row, motivo_label });
  } catch (e) {
    console.error('[returns:get] ERRO', e);
    if (req.query.debug === '1') {
      return res.status(500).json({ error: e.message || 'Erro interno ao buscar' });
    }
    res.status(500).json({ error: 'Erro interno ao buscar' });
  }
});

/* =============== 3b) PATCH /:id =============== */
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

    if (has('updated_at')) set.push('updated_at = NOW()');

    if (!set.length) return res.status(400).json({ error: 'empty_patch' });

    const where = [];
    const whereArgs = [];
    whereArgs.push(Number(id));
    where.push(`id = $${whereArgs.length}`);

    const hasTenantNow = cols.has('tenant_id');
    const tenantId  = getTenantId(req);
    if (hasTenantNow && tenantId) {
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

    const hasTenantNow = has('tenant_id');
    const tenantId  = getTenantId(req);
    if (hasTenantNow && tenantId) {
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

    // timeline
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

/* =============== 5) TIMELINE =============== */
router.get('/:id/events', async (req, res) => {
  try {
    const q   = qOf(req);
    const id  = String(req.params.id || '').trim();
    if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'invalid_id' });

    const hasRetEvents = await hasTable(q, 'return_events');
    const hasDevEvents = await hasTable(q, 'devolucoes_events');

    if (!hasRetEvents && !hasDevEvents) return res.json({ items: [] });

    const params = [ Number(id) ];
    const sql = hasRetEvents
      ? `SELECT * FROM return_events WHERE return_id = $1 ORDER BY created_at DESC NULLS LAST, id DESC`
      : `SELECT * FROM devolucoes_events WHERE return_id = $1 ORDER BY created_at DESC NULLS LAST, id DESC`;

    const { rows } = await q(sql, params);
    res.json({ items: rows || [] });
  } catch (e) {
    console.error('[returns:events] ERRO', e);
    res.status(500).json({ items: [] });
  }
});

module.exports = router;
