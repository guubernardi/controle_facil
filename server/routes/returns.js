// server/routes/returns.js
'use strict';

const { query } = require('../db');
const { broadcast } = require('../events');

// ---- fetch helper (Node 18+ tem fetch nativo; senão cai no node-fetch) ----
const _fetch = (typeof fetch === 'function')
  ? fetch
  : (...a) => import('node-fetch').then(({ default: f }) => f(...a));

async function getMLToken(req) {
  // ajuste aqui se o token estiver salvo em outro lugar no seu projeto
  if (req?.user?.ml?.access_token) return req.user.ml.access_token;
  if (process.env.ML_ACCESS_TOKEN) return process.env.ML_ACCESS_TOKEN;
  try {
    const { rows } = await query(
      `SELECT access_token
         FROM ml_tokens
        WHERE is_active IS TRUE
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 1`
    );
    return rows[0]?.access_token || null;
  } catch {
    return null;
  }
}

async function mlFetch(path, token) {
  const url = `https://api.mercadolibre.com${path}`;
  const r = await _fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  let j = null;
  try { j = await r.json(); } catch {}
  if (!r.ok) {
    const msg = (j && (j.message || j.error))
      ? `${j.error || ''} ${j.message || ''}`.trim()
      : `ML HTTP ${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    err.payload = j;
    throw err;
  }
  return j;
}

/* =============== introspecção =============== */
async function tableHasColumns(table, cols) {
  const { rows } = await query(
    `SELECT column_name, is_nullable, data_type, column_default
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1`,
    [table]
  );
  const set = new Set(rows.map(r => r.column_name));
  const out = {};
  for (const c of cols) out[c] = set.has(c);
  out.__cols = rows;
  return out;
}

/* =============== campos & normalização =============== */
const POSSIVEIS_CAMPOS = [
  'id_venda','cliente_nome','loja_nome','sku',
  'status','log_status',
  'valor_produto','valor_frete',
  'motivo','descricao',
  'nfe_numero','nfe_chave',
  'data_compra',
  'recebido_cd','recebido_resp','recebido_em'
];

const nrm = s => String(s ?? '')
  .toLowerCase()
  .normalize('NFD').replace(/\p{Diacritic}/gu,'')
  .replace(/[_-]+/g,' ').replace(/\s+/g,' ').trim();

const STATUS_MAP = new Map([
  ['pendente','pendente'],['em analise','pendente'],['analise','pendente'],
  ['aprovado','aprovado'],['aprovada','aprovado'],['autorizado','aprovado'],['autorizada','aprovado'],
  ['rejeitado','rejeitado'],['rejeitada','rejeitado'],['negado','rejeitado'],['negada','rejeitado'],
]);

// CHECK permitido na tabela: nao_recebido, recebido_cd, em_inspecao
const LOG_MAP = new Map([
  ['nao recebido','nao_recebido'],['nao_recebido','nao_recebido'],['nao-recebido','nao_recebido'],
  ['recebido cd','recebido_cd'],['recebido_cd','recebido_cd'],['recebido-cd','recebido_cd'],
  ['em inspecao','em_inspecao'],['em_inspecao','em_inspecao'],['em-inspecao','em_inspecao'],['em inspecao','em_inspecao'],
  ['postado','nao_recebido'],['coletado','nao_recebido'],
  ['em transito','nao_recebido'],['em_transito','nao_recebido'],['em-transito','nao_recebido'],
]);

const num = v => (v===''||v==null) ? null : (Number.isFinite(Number(v)) ? Number(v) : null);

function sanitizeForInsert(body={}, cols) {
  const out = {};
  for (const c of POSSIVEIS_CAMPOS) {
    if (!cols[c] || body[c] === undefined) continue;
    let val = body[c];

    if (c === 'status' && val != null && val !== '') {
      val = STATUS_MAP.get(nrm(val)) || 'pendente';
    }
    if (c === 'log_status') {
      if (val == null || val === '') val = null;
      else val = LOG_MAP.get(nrm(val)) ?? null;
    }
    if (c === 'valor_produto' || c === 'valor_frete') val = num(val);
    if (typeof val === 'string') { val = val.trim(); if (val === '') val = null; }

    out[c] = val;
  }
  if (cols.status && (out.status === undefined || out.status === null)) out.status = 'pendente';
  return out;
}

function sanitizeForUpdate(body={}, cols) {
  const out = {};
  for (const c of POSSIVEIS_CAMPOS) {
    if (!cols[c] || !Object.prototype.hasOwnProperty.call(body,c)) continue;
    let val = body[c];

    if (c === 'status' && val != null && val !== '') val = STATUS_MAP.get(nrm(val)) || 'pendente';
    if (c === 'log_status') val = (val==null||val==='') ? null : (LOG_MAP.get(nrm(val)) ?? null);
    if (c === 'valor_produto' || c === 'valor_frete') val = num(val);
    if (typeof val === 'string') { val = val.trim(); if (val === '') val = null; }

    out[c] = val;
  }
  return out;
}

function errPayload(e, fallback) {
  return {
    error: fallback,
    detail: e?.detail || e?.message,
    code: e?.code,
    constraint: e?.constraint,
  };
}

function parseDateYMD(s) {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0,10);
}

/* ===== helpers de eventos (timeline) ===== */
async function eventosTableExists() {
  const { rows } = await query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name='devolucao_eventos'`
  );
  return rows.length > 0;
}

async function logEvento(returnId, type, title, message, meta) {
  try {
    if (!(await eventosTableExists())) return; // não falha se não existir
    await query(
      `INSERT INTO devolucao_eventos (return_id, type, title, message, meta)
       VALUES ($1,$2,$3,$4,$5)`,
      [returnId, type, title, message || null, meta ? JSON.stringify(meta) : null]
    );
    broadcast('return_event', { return_id: returnId, type, title, message, meta });
  } catch (_) { /* silencioso */ }
}

/* ============================ ROTAS ============================ */
module.exports = function registerReturns(app) {
  /* ---------- Diagnóstico de colunas ---------- */
  app.get('/api/dev/returns/columns', async (_req, res) => {
    try {
      const cols = await tableHasColumns('devolucoes', POSSIVEIS_CAMPOS.concat(['created_at','updated_at']));
      res.json({ columns: cols.__cols });
    } catch (e) {
      res.status(500).json(errPayload(e, 'Falha ao inspecionar colunas.'));
    }
  });

  /* ---------- LISTA SIMPLES ---------- */
  app.get('/api/returns', async (req, res) => {
    try {
      const { status='', page='1', pageSize='50', orderBy='updated_at', orderDir='desc' } = req.query;

      const base = ['id','id_venda','cliente_nome','loja_nome','sku','status','log_status',
                    'valor_produto','valor_frete','motivo','descricao','nfe_numero','nfe_chave',
                    'data_compra','recebido_cd','recebido_resp','recebido_em','created_at','updated_at'];
      const cols = await tableHasColumns('devolucoes', base);
      const select = ['id', ...base.filter(c => c!=='id' && cols[c])];

      const p = []; const where = [];
      if (status) {
        const s = nrm(status);
        const logish = new Set(['recebido_cd','em_inspecao','postado','em transito','em_transito']);
        if (logish.has(s) && cols.log_status) { p.push(s.replace(' ','_')); where.push(`LOWER(COALESCE(log_status,'')) = $${p.length}`); }
        else if (cols.status) { p.push(`%${s}%`); where.push(`LOWER(COALESCE(status,'')) LIKE $${p.length}`); }
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const allowedOrder = new Set(select);
      let col = allowedOrder.has(String(orderBy)) ? String(orderBy) : (cols.updated_at ? 'updated_at' : (cols.created_at ? 'created_at' : 'id'));
      const dir = String(orderDir).toLowerCase() === 'asc' ? 'asc' : 'desc';

      const limit  = Math.max(1, Math.min(parseInt(pageSize,10)||50, 500));
      const pageNo = Math.max(1, parseInt(page,10)||1);
      const offset = (pageNo-1)*limit;

      const sqlItems = `
        SELECT ${select.join(', ')}
          FROM devolucoes
          ${whereSql}
         ORDER BY ${col} ${dir} NULLS LAST
         LIMIT $${p.length+1} OFFSET $${p.length+2}
      `;
      const sqlCount = `SELECT COUNT(*)::int AS count FROM devolucoes ${whereSql}`;

      const [itemsQ, countQ] = await Promise.all([
        query(sqlItems, [...p, limit, offset]),
        query(sqlCount, p),
      ]);

      res.json({ items: itemsQ.rows, total: countQ.rows[0]?.count || 0, page: pageNo, pageSize: limit });
    } catch (e) {
      console.error('[returns] list erro:', e);
      res.status(500).json(errPayload(e, 'Falha ao listar devoluções.'));
    }
  });

  /* ---------- LISTA AVANÇADA ---------- */
  app.get('/api/returns/search', async (req, res) => {
    try {
      const {
        from = '', to = '', q = '',
        page = '1', pageSize = '50',
        orderBy = 'created_at', orderDir = 'desc'
      } = req.query;

      const base = ['id','id_venda','cliente_nome','loja_nome','sku','status','log_status',
                    'valor_produto','valor_frete','motivo','descricao','nfe_numero','nfe_chave',
                    'data_compra','recebido_cd','recebido_resp','recebido_em','created_at','updated_at'];
      const cols = await tableHasColumns('devolucoes', base);
      const select = ['id', ...base.filter(c => c!=='id' && cols[c])];

      const p = []; const where = [];

      const fromY = parseDateYMD(from);
      const toY   = parseDateYMD(to);
      if (cols.created_at) {
        if (fromY && toY) {
          p.push(fromY); p.push(toY);
          where.push(`(created_at::date BETWEEN $${p.length-1} AND $${p.length})`);
        } else if (fromY) {
          p.push(fromY);
          where.push(`(created_at::date >= $${p.length})`);
        } else if (toY) {
          p.push(toY);
          where.push(`(created_at::date <= $${p.length})`);
        }
      }

      const needle = String(q || '').trim().toLowerCase();
      if (needle) {
        const like = `%${needle}%`;
        const fields = [
          cols.id_venda ? 'id_venda' : null,
          cols.cliente_nome ? 'cliente_nome' : null,
          cols.loja_nome ? 'loja_nome' : null,
          cols.sku ? 'sku' : null,
          cols.status ? 'status' : null,
          cols.log_status ? 'log_status' : null,
        ].filter(Boolean);
        if (fields.length) {
          const ors = fields.map(f => {
            p.push(like);
            return `LOWER(COALESCE(${f},'')) LIKE $${p.length}`;
          });
          where.push(`(${ors.join(' OR ')})`);
        }
      }

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const allowedOrder = new Set(select);
      let col = allowedOrder.has(String(orderBy)) ? String(orderBy) : (cols.created_at ? 'created_at' : 'id');
      const dir = String(orderDir).toLowerCase() === 'asc' ? 'asc' : 'desc';

      const limit  = Math.max(1, Math.min(parseInt(pageSize,10)||50, 500));
      const pageNo = Math.max(1, parseInt(page,10)||1);
      const offset = (pageNo-1)*limit;

      const sqlItems = `
        SELECT ${select.join(', ')}
          FROM devolucoes
          ${whereSql}
         ORDER BY ${col} ${dir} NULLS LAST
         LIMIT $${p.length+1} OFFSET $${p.length+2}
      `;
      const sqlCount = `SELECT COUNT(*)::int AS count FROM devolucoes ${whereSql}`;

      const [itemsQ, countQ] = await Promise.all([
        query(sqlItems, [...p, limit, offset]),
        query(sqlCount, p),
      ]);

      res.json({ items: itemsQ.rows, total: countQ.rows[0]?.count || 0, page: pageNo, pageSize: limit });
    } catch (e) {
      console.error('[returns] search erro:', e);
      res.status(500).json(errPayload(e, 'Falha ao pesquisar devoluções.'));
    }
  });

  /* ---------- LOGS DE CUSTO ---------- */
  app.get('/api/returns/logs', async (req, res) => {
    try {
      const {
        from = '', to = '',
        status = '', loja = '',
        q = '',
        page = '1', pageSize = '50',
        orderBy = 'event_at', orderDir = 'desc'
      } = req.query;

      const baseCols = [
        'id','id_venda','cliente_nome','loja_nome','sku',
        'status','log_status','motivo',
        'valor_produto','valor_frete',
        'recebido_em','created_at','updated_at'
      ];
      const cols = await tableHasColumns('devolucoes', baseCols);

      const col = (c, fallback='NULL') => (cols[c] ? c : fallback);
      const L = (c) => `LOWER(COALESCE(${col(c, "''")},''))`;

      const valProd = `COALESCE(${col('valor_produto','0')},0)`;
      const valFrt  = `COALESCE(${col('valor_frete','0')},0)`;
      const stCol   = L('status');
      const lgCol   = L('log_status');
      const motCol  = L('motivo');

      // Regras: Rejeitado=0; Motivo do cliente=0; Recebido_CD/Em_inspecao=só frete; senão produto+frete
      const totalExpr = `
        CASE
          WHEN ${stCol} LIKE 'rejeit%' THEN 0
          WHEN ${motCol} ~ '(cliente|arrepend|desist)' THEN 0
          WHEN ${lgCol} IN ('recebido_cd','em_inspecao') THEN ${valFrt}
          ELSE ${valProd} + ${valFrt}
        END
      `;

      const eventAtExpr = cols.recebido_em
        ? `COALESCE(${col('recebido_em')}, ${col('updated_at','NULL')}, ${col('created_at','NULL')})`
        : (cols.updated_at
            ? (cols.created_at ? `COALESCE(${col('updated_at')}, ${col('created_at')})` : col('updated_at'))
            : (cols.created_at ? col('created_at') : 'NOW()'));

      const selectFields = [
        `${col('id','NULL')} AS return_id`,
        `${col('id_venda','NULL')} AS numero_pedido`,
        `${col('cliente_nome','NULL')} AS cliente_nome`,
        `${col('loja_nome','NULL')} AS loja_nome`,
        `${col('status','NULL')} AS status`,
        `${totalExpr} AS total`,
        `${eventAtExpr} AS event_at`
      ];

      const p = [];
      const wh = [];

      const fromY = parseDateYMD(from);
      const toY   = parseDateYMD(to);
      if (fromY && toY) {
        p.push(fromY, toY);
        wh.push(`(${eventAtExpr}::date BETWEEN $${p.length-1} AND $${p.length})`);
      } else if (fromY) {
        p.push(fromY);
        wh.push(`(${eventAtExpr}::date >= $${p.length})`);
      } else if (toY) {
        p.push(toY);
        wh.push(`(${eventAtExpr}::date <= $${p.length})`);
      }

      if (status) {
        const s = String(status).toLowerCase().trim();
        const isLogish = new Set(['recebido_cd','em_inspecao','nao_recebido']).has(s);
        if (isLogish && cols.log_status) {
          p.push(s);
          wh.push(`${lgCol} = $${p.length}`);
        } else if (cols.status) {
          p.push(`%${s}%`);
          wh.push(`${stCol} LIKE $${p.length}`);
        }
      }

      if (loja && cols.loja_nome) {
        p.push(`%${String(loja).toLowerCase().trim()}%`);
        wh.push(`${L('loja_nome')} LIKE $${p.length}`);
      }

      if (q) {
        const needle = `%${String(q).toLowerCase().trim()}%`;
        const orFields = [];
        if (cols.id_venda)     { p.push(needle); orFields.push(`${L('id_venda')} LIKE $${p.length}`); }
        if (cols.cliente_nome) { p.push(needle); orFields.push(`${L('cliente_nome')} LIKE $${p.length}`); }
        if (cols.loja_nome)    { p.push(needle); orFields.push(`${L('loja_nome')} LIKE $${p.length}`); }
        if (cols.sku)          { p.push(needle); orFields.push(`${L('sku')} LIKE $${p.length}`); }
        if (cols.motivo)       { p.push(needle); orFields.push(`${L('motivo')} LIKE $${p.length}`); }
        if (orFields.length) wh.push(`(${orFields.join(' OR ')})`);
      }

      const whereSql = wh.length ? `WHERE ${wh.join(' AND ')}` : '';

      const limit  = Math.max(1, Math.min(parseInt(pageSize,10) || 50, 500));
      const pageNo = Math.max(1, parseInt(page,10) || 1);
      const offset = (pageNo - 1) * limit;

      const orderMap = new Map([
        ['event_at',  'event_at'],
        ['numero_pedido', 'numero_pedido'],
        ['cliente_nome', 'cliente_nome'],
        ['loja_nome', 'loja_nome'],
        ['status', 'status'],
        ['total', 'total']
      ]);
      const ob = orderMap.get(String(orderBy)) || 'event_at';
      const dir = String(orderDir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

      const sqlItems = `
        SELECT ${selectFields.join(', ')}
          FROM devolucoes
          ${whereSql}
         ORDER BY ${ob} ${dir} NULLS LAST
         LIMIT $${p.length+1} OFFSET $${p.length+2}
      `;
      const sqlCount = `SELECT COUNT(*)::int AS count FROM devolucoes ${whereSql}`;
      const sqlSum   = `SELECT COALESCE(SUM(${totalExpr}),0)::float8 AS sum_total FROM devolucoes ${whereSql}`;

      const [itemsQ, countQ, sumQ] = await Promise.all([
        query(sqlItems, [...p, limit, offset]),
        query(sqlCount, p),
        query(sqlSum, p),
      ]);

      res.json({
        items: itemsQ.rows,
        total: countQ.rows[0]?.count || 0,
        sum_total: Number(sumQ.rows[0]?.sum_total || 0),
        page: pageNo,
        pageSize: limit
      });
    } catch (e) {
      console.error('[returns] logs erro:', e);
      res.status(500).json({ error: 'Falha ao carregar logs', detail: e?.message });
    }
  });

  /* ---------- CRIAR ---------- */
  app.post('/api/returns', async (req, res) => {
    try {
      const cols = await tableHasColumns('devolucoes', POSSIVEIS_CAMPOS.concat(['created_at']));
      const data = sanitizeForInsert(req.body || {}, cols);

      const keys = Object.keys(data);
      let sql, params;
      if (!keys.length) {
        sql = 'INSERT INTO devolucoes DEFAULT VALUES RETURNING *';
        params = [];
      } else {
        const ph = keys.map((_,i)=>`$${i+1}`);
        params = keys.map(k=>data[k]);
        sql = `INSERT INTO devolucoes (${keys.join(',')}) VALUES (${ph.join(',')}) RETURNING *`;
      }

      const { rows } = await query(sql, params);
      res.status(201).json({ item: rows[0] });
    } catch (e) {
      console.error('[returns] create erro:', e);
      res.status(500).json(errPayload(e, 'Falha ao criar devolução.'));
    }
  });

  /* ---------- BUSCAR 1 ---------- */
  app.get('/api/returns/:id(\\d+)', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID inválido' });
      const { rows } = await query('SELECT * FROM devolucoes WHERE id=$1', [id]);
      if (!rows.length) return res.status(404).json({ error: 'Não encontrado' });
      res.json({ item: rows[0] });
    } catch (e) {
      console.error('[returns] getById erro:', e);
      res.status(500).json(errPayload(e, 'Falha ao carregar devolução.'));
    }
  });

  /* ---------- ATUALIZAR (PUT/PATCH) ---------- */
  async function updateReturn(req, res) {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID inválido' });

      const cols = await tableHasColumns('devolucoes', POSSIVEIS_CAMPOS.concat(['updated_at']));
      const data = sanitizeForUpdate(req.body || {}, cols);
      const keys = Object.keys(data);

      if (!keys.length && !cols.updated_at) {
        return res.status(400).json({ error: 'Nada para atualizar' });
      }

      const set = []; const params = [];
      keys.forEach((k,i)=>{ set.push(`${k}=$${i+1}`); params.push(data[k]); });
      if (cols.updated_at) set.push('updated_at=now()');

      params.push(id);
      const { rows } = await query(
        `UPDATE devolucoes SET ${set.join(', ')} WHERE id=$${params.length} RETURNING *`,
        params
      );
      if (!rows.length) return res.status(404).json({ error: 'Não encontrado' });
      res.json({ item: rows[0] });
    } catch (e) {
      console.error('[returns] update erro:', e);
      res.status(500).json(errPayload(e, 'Falha ao atualizar devolução.'));
    }
  }
  app.put('/api/returns/:id(\\d+)', updateReturn);
  app.patch('/api/returns/:id(\\d+)', updateReturn); // front usa PATCH

  /* ---------- EXCLUIR ---------- */
  app.delete('/api/returns/:id(\\d+)', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID inválido' });
      const { rowCount } = await query('DELETE FROM devolucoes WHERE id=$1', [id]);
      if (!rowCount) return res.status(404).json({ error: 'Não encontrado' });
      res.json({ ok: true });
    } catch (e) {
      console.error('[returns] delete erro:', e);
      res.status(500).json(errPayload(e, 'Falha ao excluir devolução.'));
    }
  });

  /* ---------- TIMELINE ---------- */
  app.get('/api/returns/:id(\\d+)/events', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID inválido' });
      if (!(await eventosTableExists())) return res.json({ items: [] }); // sem tabela → lista vazia

      const { rows } = await query(
        `SELECT id, return_id, type, title, message, meta, created_at
           FROM devolucao_eventos
          WHERE return_id=$1
          ORDER BY created_at DESC, id DESC
          LIMIT 200`,
        [id]
      );
      res.json({ items: rows });
    } catch (e) {
      console.error('[returns] events erro:', e);
      res.status(500).json(errPayload(e, 'Falha ao carregar eventos.'));
    }
  });

  /* ---------- AÇÕES DE CD ---------- */
  app.patch('/api/returns/:id(\\d+)/cd/receive', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID inválido' });

      const cols = await tableHasColumns('devolucoes', ['recebido_cd','recebido_resp','recebido_em','log_status','updated_at']);
      const when = req.body?.when ? new Date(req.body.when) : new Date();
      const resp = (req.body?.responsavel || 'cd').trim();

      const set = []; const params = [];
      if (cols.recebido_cd)  { set.push(`recebido_cd=true`); }
      if (cols.recebido_resp){ set.push(`recebido_resp=$${params.push(resp)}`); }
      if (cols.recebido_em)  { set.push(`recebido_em=$${params.push(when.toISOString())}`); }
      if (cols.log_status)   { set.push(`log_status='recebido_cd'`); }
      if (cols.updated_at)   { set.push(`updated_at=now()`); }
      params.push(id);

      const { rows } = await query(`UPDATE devolucoes SET ${set.join(', ')} WHERE id=$${params.length} RETURNING *`, params);
      if (!rows.length) return res.status(404).json({ error: 'Não encontrado' });

      await logEvento(id, 'status', 'Recebido no CD', `Responsável: ${resp}`, { cd:{ responsavel: resp, receivedAt: when }, log_status:'recebido_cd' });
      res.json({ item: rows[0] });
    } catch (e) {
      console.error('[returns] cd/receive erro:', e);
      res.status(500).json(errPayload(e, 'Falha ao marcar recebido.'));
    }
  });

  app.patch('/api/returns/:id(\\d+)/cd/unreceive', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID inválido' });

      const cols = await tableHasColumns('devolucoes', ['recebido_cd','recebido_resp','recebido_em','log_status','updated_at']);
      const when = req.body?.when ? new Date(req.body.when) : new Date();
      const resp = (req.body?.responsavel || 'cd').trim();

      const set = []; const params = [];
      if (cols.recebido_cd)  set.push(`recebido_cd=false`);
      if (cols.recebido_resp)set.push(`recebido_resp=NULL`);
      if (cols.recebido_em)  set.push(`recebido_em=NULL`);
      if (cols.log_status)   set.push(`log_status='nao_recebido'`);
      if (cols.updated_at)   set.push(`updated_at=now()`);
      params.push(id);

      const { rows } = await query(`UPDATE devolucoes SET ${set.join(', ')} WHERE id=$${params.length} RETURNING *`, params);
      if (!rows.length) return res.status(404).json({ error: 'Não encontrado' });

      await logEvento(id, 'status', 'Recebimento removido', `Responsável: ${resp}`, { cd:{ responsavel: resp, unreceivedAt: when }, log_status:'nao_recebido' });
      res.json({ item: rows[0] });
    } catch (e) {
      console.error('[returns] cd/unreceive erro:', e);
      res.status(500).json(errPayload(e, 'Falha ao remover marcação de recebido.'));
    }
  });

  app.patch('/api/returns/:id(\\d+)/cd/inspect', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID inválido' });

      const cols = await tableHasColumns('devolucoes', ['log_status','updated_at']);
      const result = String(req.body?.resultado || '').toLowerCase(); // 'aprovado' | 'rejeitado'
      const obs    = (req.body?.observacao || '').trim();
      const when   = req.body?.when ? new Date(req.body.when) : new Date();

      let finalLog = null;
      if (result.includes('aprov')) finalLog = 'em_inspecao';
      if (result.includes('rejeit')) finalLog = 'em_inspecao';

      if (finalLog && cols.log_status) {
        await query(
          `UPDATE devolucoes SET log_status=$1, updated_at=now() WHERE id=$2`,
          [finalLog, id]
        );
      }

      await logEvento(
        id,
        'status',
        result.includes('aprov') ? 'Inspeção aprovada' : 'Inspeção reprovada',
        obs || null,
        { cd:{ inspectedAt: when }, log_status: finalLog || undefined }
      );

      res.json({ ok: true });
    } catch (e) {
      console.error('[returns] cd/inspect erro:', e);
      res.status(500).json(errPayload(e, 'Falha ao registrar inspeção.'));
    }
  });

  /* ---------- ML: debug do return-cost por claim_id ---------- */
  app.get('/api/ml/claims/:claim_id/return-cost', async (req, res) => {
    try {
      const token = await getMLToken(req);
      if (!token) return res.status(501).json({ error: 'Token do ML ausente (defina ML_ACCESS_TOKEN ou configure integração).' });
      const claimId = req.params.claim_id;
      const j = await mlFetch(`/post-purchase/v1/claims/${encodeURIComponent(claimId)}/charges/return-cost`, token);
      res.json(j);
    } catch (e) {
      res.status(502).json({ error: 'Falha ao consultar return-cost no ML', detail: e.message, upstream: e.payload });
    }
  });

  /* ---------- SEED DEV ---------- */
  app.post('/api/dev/seed-return', async (req, res) => {
    try {
      if (process.env.NODE_ENV === 'production') {
        return res.status(403).json({ error: 'Seed desabilitado em produção.' });
      }
      const sample = {
        id_venda: 'TESTE-123',
        cliente_nome: 'Cliente de Teste',
        loja_nome: 'Mercado Livre',
        sku: 'SKU-TESTE-001',
        status: 'pendente',
        log_status: 'nao_recebido',
        valor_produto: 199.90,
        valor_frete: 19.90,
        motivo: 'defeito',
        descricao: 'Registro criado para testes automatizados'
      };

      const cols = await tableHasColumns('devolucoes', POSSIVEIS_CAMPOS.concat(['created_at']));
      const data = sanitizeForInsert({ ...sample, ...(req.body || {}) }, cols);

      const keys = Object.keys(data);
      const ph = keys.map((_,i)=>`$${i+1}`);
      const params = keys.map(k=>data[k]);

      const { rows } = await query(
        keys.length
          ? `INSERT INTO devolucoes (${keys.join(',')}) VALUES (${ph.join(',')}) RETURNING *`
          : 'INSERT INTO devolucoes DEFAULT VALUES RETURNING *',
        params
      );
      res.status(201).json({ item: rows[0] });
    } catch (e) {
      console.error('[returns] seed erro:', e);
      res.status(500).json(errPayload(e, 'Falha ao semear devolução.'));
    }
  });
};
