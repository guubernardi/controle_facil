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
  } catch {
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

/* ======= Normalização/Rotulagem de Motivo ======= */

// mapeia a chave canônica para rótulo amigável
function labelFromCanon(key = '') {
  const k = String(key || '').toLowerCase();
  const MAP = {
    nao_corresponde:         'Não corresponde à descrição',
    produto_defeituoso:      'Produto com defeito',
    produto_danificado:      'Produto danificado (transporte)',
    produto_incompleto:      'Produto incompleto / faltando peças',
    arrependimento_cliente:  'Arrependimento do cliente',
    entrega_atrasada:        'Entrega atrasada / não entregue',
    outro:                   'Outro'
  };
  return MAP[k] || null;
}

// tenta inferir a chave canônica a partir de texto livre
function canonFromText(text = '') {
  const s = String(text || '')
    .normalize?.('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase() || String(text || '').toLowerCase();

  if (/(nao\s*quer\s*mais|mudou\s*de\s*ideia|buyer\s*remorse|changed\s*mind|preferiu\s*f(icar|ica)r)/.test(s))
    return 'arrependimento_cliente';
  if (/(tamanho|size|nao\s*cabe|doesn.?t\s*fit)/.test(s))
    return 'arrependimento_cliente';

  if (/(defeit|nao\s*funciona|broken|not\s*working)/.test(s))
    return 'produto_defeituoso';
  if (/(avaria|danific|amass|quebrad|transporte|shipping\s*damage)/.test(s))
    return 'produto_danificado';
  if (/(falt(a|am)\s*pecas|faltando|incomplet|missing\s*parts)/.test(s))
    return 'produto_incompleto';
  if (/(diferent|descricao|descri[cç]ao|wrong\s*item|not\s*as\s*described)/.test(s))
    return 'nao_corresponde';
  if (/(nao\s*entreg|undelivered|delayed|entrega\s*atras)/.test(s))
    return 'entrega_atrasada';

  return null;
}

// tenta inferir a canônica a partir de códigos do ML (reason_id resumido)
function canonFromCode(code = '') {
  const c = String(code || '').toUpperCase();
  if (c === 'CS')  return 'arrependimento_cliente';     // Compra cancelada / changed_mind
  if (c === 'PNR') return 'entrega_atrasada';           // Produto não recebido
  if (c.startsWith('PDD')) {
    // PDD* engloba "produto diferente/defeituoso" – sem granularidade garantida
    return 'nao_corresponde';
  }
  return null;
}

// rótulo “humano” legado (mantém retrocompat)
function legacyHumanize(idOrText = '') {
  const s = String(idOrText || '').toLowerCase();
  const map = {
    different_from_description: 'Não corresponde à descrição',
    not_as_described:           'Não corresponde à descrição',
    wrong_item:                 'Não corresponde à descrição',
    variations_mismatch:        'Não corresponde à descrição',
    size_color_mismatch:        'Não corresponde à descrição',
    damaged_item:               'Produto danificado (transporte)',
    broken:                     'Produto com defeito',
    incomplete_item:            'Produto incompleto / faltando peças',
    missing_parts:              'Produto incompleto / faltando peças',
    not_delivered:              'Entrega atrasada / não entregue',
    undelivered:                'Entrega atrasada / não entregue',
    cs:                         'Arrependimento do cliente' // atalho se vier "cs"
  };
  if (map[s]) return map[s];
  const viaText = canonFromText(s);
  if (viaText) return labelFromCanon(viaText);
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

    [
      'id','id_venda','cliente_nome','loja_nome','sku','status','log_status',
      'created_at','updated_at','data_compra','cd_recebido_em',
      'valor_produto','valor_frete'
    ].forEach(c => { if (has(c)) selectCols.push(c); });

    if (has('foto_produto'))     selectCols.push('foto_produto');
    if (has('ml_return_status')) selectCols.push('ml_return_status');

    if (has('ml_claim_id'))      selectCols.push('ml_claim_id');
    if (has('ml_claim_stage'))   selectCols.push('ml_claim_stage');
    if (has('ml_claim_status'))  selectCols.push('ml_claim_status');
    if (has('ml_claim_type'))    selectCols.push('ml_claim_type');

    if (has('ml_triage_stage'))               selectCols.push('ml_triage_stage');
    if (has('ml_triage_status'))              selectCols.push('ml_triage_status');
    if (has('ml_triage_benefited'))           selectCols.push('ml_triage_benefited');
    if (has('ml_triage_reason_id'))           selectCols.push('ml_triage_reason_id');
    if (has('ml_triage_product_condition'))   selectCols.push('ml_triage_product_condition');
    if (has('ml_triage_product_destination')) selectCols.push('ml_triage_product_destination');

    if (has('tipo_reclamacao')) selectCols.push('tipo_reclamacao');

    if (!selectCols.length) selectCols.push('*');

    const params       = [];
    const whereClauses = [];

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
        if (has('ml_return_status')) {
          clause += ` OR ml_return_status IN ('shipped','pending_delivered','on_transit')`;
        }
        clause += ')';
        whereClauses.push(clause);
      } else if (status === 'disputa') {
        let clause = `(status IN ('disputa','mediacao','reclamacao')`;
        if (has('ml_return_status')) clause += ` OR ml_return_status IN ('dispute','mediation','pending','open')`;
        if (has('ml_claim_stage'))   clause += ` OR LOWER(ml_claim_stage) IN ('dispute','mediation')`;
        if (has('ml_claim_status'))  clause += ` OR LOWER(ml_claim_status) IN ('dispute','mediation')`;
        if (has('ml_triage_stage'))  clause += ` OR LOWER(ml_triage_stage) IN ('seller_review_pending','pending')`;
        if (has('ml_triage_status')) clause += ` OR LOWER(ml_triage_status) = 'failed'`;
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

    const orderCol = (has('updated_at') && 'updated_at')
      || (has('created_at') && 'created_at')
      || 'id';

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

/* =============== 2) SYNC via ML (wrapper) =============== */
router.get('/sync', async (req, res) => {
  try {
    const qs = new URLSearchParams(req.query);
    if (!qs.has('days'))   qs.set('days', '30');
    if (!qs.has('all'))    qs.set('all',  '1');
    if (!qs.has('silent')) qs.set('silent','1');

    // Redireciona preservando método (GET) e query
    return res.redirect(307, `/api/ml/claims/import?${qs.toString()}`);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'sync_redirect_failed' });
  }
});

/* =============== 3) DETALHES =============== */
router.get('/:id', async (req, res) => {
  const debug = req.query.debug === '1';
  try {
    const q        = qOf(req);
    const idParam  = String(req.params.id || '').trim();
    const tenantId = getTenantId(req);
    const isNumeric = /^\d+$/.test(idParam);

    const cols       = await columnsOf(q, 'devolucoes');
    const hasIdVenda = cols.has('id_venda');
    const hasTenant  = cols.has('tenant_id');

    let row = null;

    if (isNumeric) {
      try {
        const args = [ Number(idParam) ];
        let sql = 'SELECT * FROM devolucoes WHERE id = $1';
        if (hasTenant && tenantId) {
          sql += ' AND (tenant_id = $2 OR tenant_id IS NULL)';
          args.push(tenantId);
        }
        sql += ' LIMIT 1';
        const r = await q(sql, args);
        row = r.rows[0] || null;
      } catch (err) {
        console.warn('[returns:get] erro ao buscar por id:', err.message);
        if (debug) return res.status(500).json({ error: 'sql_error_id', detail: err.message });
      }
    }

    if (!row && hasIdVenda) {
      try {
        const args2 = [ idParam ];
        let sql2 = 'SELECT * FROM devolucoes WHERE id_venda = $1';
        if (hasTenant && tenantId) {
          sql2 += ' AND (tenant_id = $2 OR tenant_id IS NULL)';
          args2.push(tenantId);
        }
        sql2 += ' LIMIT 1';
        const r2 = await q(sql2, args2);
        row = r2.rows[0] || null;
      } catch (err) {
        console.warn('[returns:get] erro ao buscar por id_venda:', err.message);
        if (debug) return res.status(500).json({ error: 'sql_error_id_venda', detail: err.message });
      }
    }

    if (!row) return res.status(404).json({ error: 'Não encontrado' });

    // ===== Motivo canônico/label =====
    // Preferência: tipo_reclamacao (canônico) > reclamacao/descrição livre > ml_return_status (último recurso)
    const rawCanon =
      (row.tipo_reclamacao && String(row.tipo_reclamacao).toLowerCase()) || null;

    // tenta achar código curto (CS/PNR/PDD*) se vier em algum campo textual
    let shortCode = null;
    for (const k of ['reclamacao','tipo_reclamacao','ml_return_status','ml_triage_reason_id']) {
      if (row[k]) {
        const m = String(row[k]).match(/\b(PNR|CS|PDD\d{0,4})\b/i);
        if (m) { shortCode = m[1].toUpperCase(); break; }
      }
    }

    const canon =
      rawCanon ||
      canonFromCode(shortCode) ||
      canonFromText(row.reclamacao) ||
      canonFromText(row.ml_return_status) ||
      'outro';

    const motivo_label = labelFromCanon(canon) || legacyHumanize(rawCanon || row.reclamacao || row.ml_return_status || 'outro');

    res.json({ ...row, tipo_reclamacao: canon, motivo_label });
  } catch (e) {
    console.error('[returns:get] ERRO', e);
    if (debug) return res.status(500).json({ error: e.message || 'Erro interno ao buscar' });
    res.status(500).json({ error: 'Erro interno ao buscar' });
  }
});

/* =============== 3b) PATCH /:id =============== */
router.patch('/:id', express.json(), async (req, res) => {
  try {
    const q  = qOf(req);
    const id = String(req.params.id || '').trim();
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

    push('id_venda',        body.id_venda);
    push('cliente_nome',    body.cliente_nome);
    push('loja_nome',       body.loja_nome);
    push('data_compra',     body.data_compra);
    push('status',          body.status);
    push('sku',             body.sku, v => String(v || '').toUpperCase());
    push('tipo_reclamacao', body.tipo_reclamacao); // aceita "arrependimento_cliente" etc.
    push('nfe_numero',      body.nfe_numero);
    push('nfe_chave',       body.nfe_chave);
    push('reclamacao',      body.reclamacao);

    push('valor_produto',   body.valor_produto, Number);
    push('valor_frete',     body.valor_frete, Number);

    push('log_status',      body.log_status);

    push('cd_recebido_em',  body.cd_recebido_em || null);
    push('cd_responsavel',  body.cd_responsavel || null);

    if (has('updated_at')) set.push('updated_at = NOW()');

    if (!set.length) return res.status(400).json({ error: 'empty_patch' });

    const where     = [];
    const whereArgs = [];

    whereArgs.push(Number(id));
    where.push(`id = $${whereArgs.length}`);

    const hasTenantNow = cols.has('tenant_id');
    const tenantId     = getTenantId(req);
    if (hasTenantNow && tenantId) {
      whereArgs.push(tenantId);
      where.push(`(tenant_id = $${whereArgs.length} OR tenant_id IS NULL)`);
    }

    const sql = `
      UPDATE devolucoes
         SET ${set.join(', ')}
       WHERE ${where.join(' AND ')}
       RETURNING *
    `;

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
    const q  = qOf(req);
    const id = String(req.params.id || '').trim();
    if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'invalid_id' });

    const { responsavel, when, updated_by } = req.body || {};
    const cols = await columnsOf(q, 'devolucoes');
    const has  = (c) => cols.has(c);

    if (!has('cd_recebido_em') || !has('cd_responsavel')) {
      return res.status(400).json({ error: 'columns_missing' });
    }

    const set  = [
      'cd_recebido_em = $1',
      'cd_responsavel = $2'
    ];
    const args = [
      when || new Date().toISOString(),
      responsavel || 'cd'
    ];

    if (has('log_status')) set.push(`log_status = 'recebido_cd'`);
    if (has('updated_at')) set.push('updated_at = NOW()');

    const where = [];
    const wargs = [ Number(id) ];
    where.push(`id = $${wargs.length}`);

    const hasTenantNow = has('tenant_id');
    const tenantId     = getTenantId(req);
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

    try {
      const hasRetEvents = await hasTable(q, 'return_events');
      const hasDevEvents = await hasTable(q, 'devolucoes_events');

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
    const q  = qOf(req);
    const id = String(req.params.id || '').trim();
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
