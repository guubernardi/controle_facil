// server/routes/returns.js
'use strict';

const { query } = require('../db');
const { broadcast } = require('../sql/events'); // opcional: SSE para front

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
  out.__cols = rows; // debug opcional
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
  // variações externas mapeadas para um permitido (ou null)
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
      else val = LOG_MAP.get(nrm(val)) ?? null; // null não viola o CHECK
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
  // aceita YYYY-MM-DD (ou qualquer coisa que Date entenda) e devolve YYYY-MM-DD
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0,10);
}

/* ===== helpers extras (fallbacks, eventos) ===== */
function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string') v = v.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
function siteIdToName(siteId) {
  const map = { MLB:'Mercado Livre', MLA:'Mercado Livre', MLM:'Mercado Libre', MCO:'Mercado Libre', MPE:'Mercado Libre', MLC:'Mercado Libre', MLU:'Mercado Libre' };
  return map[siteId] || 'Mercado Livre';
}

let __eventsTableMemo = null;
async function detectEventsTable() {
  if (__eventsTableMemo !== null) return __eventsTableMemo;
  const candidates = [
    { table: 'return_events',      id: 'return_id'     },
    { table: 'devolucoes_events',  id: 'devolucao_id'  },
    { table: 'events_returns',     id: 'return_id'     },
  ];
  for (const c of candidates) {
    try {
      const { rows } = await query(`SELECT to_regclass('public.${c.table}') AS ok`);
      if (rows[0]?.ok) { __eventsTableMemo = c; return c; }
    } catch (_) {}
  }
  __eventsTableMemo = null;
  return null;
}

async function insertEvent(returnId, type, title, message, meta) {
  const evt = await detectEventsTable();
  if (!evt) return false;
  await query(
    `
      INSERT INTO ${evt.table} (${evt.id}, type, title, message, meta, created_at)
      VALUES ($1, $2, $3, $4, $5, now())
    `,
    [returnId, type || 'status', title || null, message || null, meta || null]
  );
  try { broadcast('return_event', { returnId, type, title, message, meta }); } catch (_e) {}
  return true;
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

  /* ---------- LISTA SIMPLES (por status, paginação) ---------- */
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

  /* ---------- LISTA AVANÇADA /search (from, to, q) ---------- */
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

      // janela de datas em created_at
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

      // busca textual leve
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

  /* ---------- BUSCAR 1 (com normalização de valores) ---------- */
  app.get('/api/returns/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID inválido' });

      const { rows } = await query('SELECT * FROM devolucoes WHERE id=$1', [id]);
      if (!rows.length) return res.status(404).json({ error: 'Não encontrado' });

      const r = rows[0];

      const valor_produto =
        toNum(r.valor_produto) ??
        toNum(r.valor_produtos) ??
        toNum(r.valor_item) ??
        toNum(r.produto_valor) ??
        toNum(r.valor_total) ??
        toNum(r.subtotal) ??
        toNum(r.item_value) ??
        toNum(r.amount_item) ??
        toNum(r.amount) ??
        null;

      const valor_frete =
        toNum(r.valor_frete) ??
        toNum(r.frete) ??
        toNum(r.shipping_value) ??
        toNum(r.shipping_cost) ??
        toNum(r.logistics_cost) ??
        null;

      const loja_nome = r.loja_nome || (r.site_id ? siteIdToName(r.site_id) : null);

      const item = { ...r, valor_produto, valor_frete, loja_nome };

      res.json({ item });
    } catch (e) {
      console.error('[returns] getById erro:', e);
      res.status(500).json(errPayload(e, 'Falha ao carregar devolução.'));
    }
  });

  /* ---------- ATUALIZAR (PUT) ---------- */
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
  app.put('/api/returns/:id', updateReturn);

  /* ---------- ATUALIZAR (PATCH alias) ---------- */
  app.patch('/api/returns/:id', updateReturn);

  /* ---------- EXCLUIR ---------- */
  app.delete('/api/returns/:id', async (req, res) => {
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

  /* ---------- TIMELINE: lista de eventos ---------- */
  app.get('/api/returns/:id/events', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID inválido' });

      const tbl = await detectEventsTable();
      if (!tbl) return res.json({ items: [] });

      const limit  = Math.min(Math.max(parseInt(req.query.limit || '100', 10), 1), 200);
      const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);

      const { rows } = await query(
        `
          SELECT type, title, message, meta, created_at
            FROM ${tbl.table}
           WHERE ${tbl.id} = $1
           ORDER BY created_at DESC
           LIMIT $2 OFFSET $3
        `,
        [id, limit, offset]
      );

      const items = rows.map(r => ({
        type: (r.type || 'status').toLowerCase(),
        title: r.title || null,
        message: r.message || null,
        meta: r.meta || null,
        createdAt: r.created_at
      }));

      res.json({ items });
    } catch (e) {
      console.error('[returns] events erro:', e);
      res.status(500).json(errPayload(e, 'Falha ao listar eventos.'));
    }
  });

  /* ---------- CD: marcar como recebido ---------- */
  app.patch('/api/returns/:id/cd/receive', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID inválido' });

      const { responsavel = 'cd', when } = req.body || {};
      const quando = when ? new Date(when) : new Date();

      await query(
        `
          UPDATE devolucoes
             SET recebido_cd = TRUE,
                 recebido_resp = $2,
                 recebido_em = $3,
                 log_status = 'recebido_cd',
                 updated_at = now()
           WHERE id = $1
        `,
        [id, String(responsavel).trim() || 'cd', quando.toISOString()]
      );

      await insertEvent(
        id,
        'status',
        'Recebido no CD',
        `Responsável: ${responsavel || 'cd'}`,
        { cd: { responsavel: responsavel || 'cd', receivedAt: quando.toISOString() } }
      );

      res.json({ ok: true });
    } catch (e) {
      console.error('[returns] cd/receive erro:', e);
      res.status(500).json(errPayload(e, 'Falha ao marcar como recebido.'));
    }
  });

  /* ---------- CD: desfazer recebido ---------- */
  app.patch('/api/returns/:id/cd/unreceive', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID inválido' });

      const { responsavel = 'cd', when } = req.body || {};
      const quando = when ? new Date(when) : new Date();

      await query(
        `
          UPDATE devolucoes
             SET recebido_cd = FALSE,
                 recebido_resp = NULL,
                 recebido_em = NULL,
                 log_status = 'nao_recebido',
                 updated_at = now()
           WHERE id = $1
        `,
        [id]
      );

      await insertEvent(
        id,
        'status',
        'Recebimento removido',
        `Responsável: ${responsavel || 'cd'}`,
        { cd: { unreceivedAt: quando.toISOString() } }
      );

      res.json({ ok: true });
    } catch (e) {
      console.error('[returns] cd/unreceive erro:', e);
      res.status(500).json(errPayload(e, 'Falha ao desfazer recebido.'));
    }
  });

  /* ---------- Inspeção (aprovar/reprovar) ---------- */
  app.patch('/api/returns/:id/cd/inspect', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID inválido' });

      const { resultado, observacao = '', when } = req.body || {};
      const quando = when ? new Date(when) : new Date();

      // mantemos 'em_inspecao' no log_status; o resultado vai na timeline
      await query(
        `
          UPDATE devolucoes
             SET log_status = 'em_inspecao',
                 updated_at = now()
           WHERE id = $1
        `,
        [id]
      );

      await insertEvent(
        id,
        'status',
        `Inspeção: ${resultado || 'sem-resultado'}`,
        observacao || null,
        { cd: { inspectedAt: quando.toISOString(), result: resultado || null } }
      );

      res.json({ ok: true });
    } catch (e) {
      console.error('[returns] cd/inspect erro:', e);
      res.status(500).json(errPayload(e, 'Falha ao registrar inspeção.'));
    }
  });

  /* ---------- SEED DEV (sem recursão) ---------- */
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
        log_status: 'nao_recebido', // ✅ compatível com CHECK
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
