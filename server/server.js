'use strict';

/**
 * -------------------------------------------------------------
 *  Retorno Fácil – Servidor HTTP (Express)
 * -------------------------------------------------------------
 * Objetivo:
 *  - Servir a UI estática (pasta /public).
 *  - Expor APIs de negócio (KPIs, pendências, logs, eventos, etc.).
 *  - Receber e processar uploads CSV (rota em ./routes/csv-upload-extended.js).
 *  - Autenticar e conversar com o Mercado Livre (./routes/ml-auth).
 *  - Sincronização direta com ML (./routes/ml-sync) e webhook (./routes/ml-webhook).
 *
 * Observações de deploy:
 *  - Em produção (Render/Railway/Vercel) a variável PORT é injetada pelo provedor.
 *  - Variáveis sensíveis devem ser definidas no painel do provedor.
 *  - Em dev local usamos .env (dotenv).
 * -------------------------------------------------------------
 */

// Carrega variáveis do .env em dev
try {
  if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config();
    console.log('[BOOT] dotenv carregado (.env)');
  }
} catch (_) {
  console.log('[BOOT] dotenv não carregado (ok em produção)');
}

const express = require('express');
const path = require('path');
const dayjs = require('dayjs');
const { query } = require('./db');

// Cria a instância do Express
const app = express();

/* ============================================================
 *  MIDDLEWARES GLOBAIS
 * ============================================================ */

// Aceita JSON no corpo (até 1 MB)
app.use(express.json({ limit: '1mb' }));

// Servir /public como estático (HTML/CSS/JS)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Força Content-Type JSON/UTF-8 nas rotas /api (organização)
app.use('/api', (req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  next();
});

/* ============================================================
 *  CHECK DE VARIÁVEIS IMPORTANTES (apenas aviso em dev)
 * ============================================================ */
[
  'BLING_AUTHORIZE_URL',
  'BLING_TOKEN_URL',
  'BLING_API_BASE',
  'BLING_CLIENT_ID',
  'BLING_CLIENT_SECRET',
  'BLING_REDIRECT_URI',
  'DATABASE_URL',
  'ML_CLIENT_ID',
  'ML_CLIENT_SECRET',
  'ML_REDIRECT_URI',
].forEach(k => {
  if (!process.env[k]) console.warn(`[WARN] Variável de ambiente ausente: ${k}`);
});

/* ============================================================
 *  HELPERS COMPARTILHADOS
 * ============================================================ */
function safeParseJson(s) {
  if (s == null) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(String(s)); } catch { return null; }
}

/**
 * addReturnEvent (idempotente)
 * - Registra evento de auditoria em return_events.
 * - Se idempotency key já existir, retorna o existente.
 */
async function addReturnEvent({
  returnId,
  type,
  title = null,
  message = null,
  meta = null,
  createdBy = 'system',
  idempKey = null
}) {
  const metaStr = meta != null ? JSON.stringify(meta) : null;
  try {
    const { rows } = await query(
      `
      INSERT INTO return_events (return_id, type, title, message, meta, created_by, created_at, idemp_key)
      VALUES ($1,$2,$3,$4,$5,$6, now(), $7)
      RETURNING id, return_id AS "returnId", type, title, message, meta, created_by AS "createdBy", created_at AS "createdAt", idemp_key AS "idempotencyKey"
      `,
      [returnId, type, title, message, metaStr, createdBy, idempKey]
    );
    const ev = rows[0];
    ev.meta = safeParseJson(ev.meta);
    return ev;
  } catch (e) {
    if (String(e?.code) === '23505' && idempKey) {
      const { rows } = await query(
        `
        SELECT id, return_id AS "returnId", type, title, message, meta, created_by AS "createdBy", created_at AS "createdAt", idemp_key AS "idempotencyKey"
          FROM return_events
         WHERE idemp_key = $1
         LIMIT 1
        `,
        [idempKey]
      );
      if (rows[0]) {
        const ev = rows[0];
        ev.meta = safeParseJson(ev.meta);
        return ev;
      }
    }
    throw e;
  }
}

/* ============================================================
 *  ROTAS UTILITÁRIAS (opcionais)
 *  Se ./routes/utils existir e exportar um Router, montamos.
 * ============================================================ */
try {
  const utilsRoutes = require('./routes/utils');
  app.use(utilsRoutes);
  console.log('[BOOT] Rotas /utils carregadas');
} catch {
  // arquivo não existe; segue sem quebrar
}

/* ============================================================
 *  REGISTRO DE ROTAS DA APLICAÇÃO
 * ============================================================ */

// 1) Upload CSV (coração do fluxo de conciliação do ML via arquivo)
try {
  const registerCsvUploadExtended = require('./routes/csv-upload-extended');
  registerCsvUploadExtended(app, { addReturnEvent });
  console.log('[BOOT] Rotas CSV registradas');
} catch (e) {
  console.warn('[BOOT] CSV indisponível:', e.message);
}

// 2) OAuth do Mercado Livre (login/callback/teste)
try {
  const registerMlAuth = require('./routes/ml-auth');
  if (typeof registerMlAuth === 'function') {
    registerMlAuth(app);
    console.log('[BOOT] Rotas ML (OAuth) registradas');
  }
} catch (e) {
  console.warn('[BOOT] ML (OAuth) indisponível:', e.message);
}

// 3) Sincronização direta com ML (import de claims/devoluções)
try {
  const registerMlSync = require('./routes/ml-sync');
  if (typeof registerMlSync === 'function') {
    registerMlSync(app);
    console.log('[BOOT] Rotas ML Sync registradas');
  }
} catch (e) {
  console.warn('[BOOT] ML Sync indisponível:', e.message);
}

// 4) Webhook do Mercado Livre (notificações: claims/returns/etc.)
try {
  const registerMlWebhook = require('./routes/ml-webhook');
  if (typeof registerMlWebhook === 'function') {
    registerMlWebhook(app);
    console.log('[BOOT] Webhook ML registrado');
  }
} catch (e) {
  console.warn('[BOOT] Webhook ML indisponível:', e.message);
}

/* ------------------------------------------------------------
 *  Auditoria: listar eventos por return_id
 * ------------------------------------------------------------ */
app.get('/api/returns/:id/events', async (req, res) => {
  try {
    const returnId = parseInt(req.params.id, 10);
    if (!Number.isInteger(returnId)) {
      return res.status(400).json({ error: 'return_id inválido' });
    }

    const limit  = Math.max(1, Math.min(parseInt(req.query.limit || '50', 10), 200));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10) || 0);

    const sql = `
      SELECT
        id,
        return_id AS "returnId",
        type,
        title,
        message,
        meta,
        created_by AS "createdBy",
        created_at AS "createdAt"
      FROM return_events
      WHERE return_id = $1
      ORDER BY created_at ASC, id ASC
      LIMIT $2 OFFSET $3
    `;
    const { rows } = await query(sql, [returnId, limit, offset]);
    const items = rows.map(r => ({ ...r, meta: safeParseJson(r.meta) }));
    res.json({ items, limit, offset });
  } catch (err) {
    console.error('GET /api/returns/:id/events error:', err);
    res.status(500).json({ error: 'Falha ao listar eventos' });
  }
});

/* ------------------------------------------------------------
 *  Healthchecks e ping de DB
 * ------------------------------------------------------------ */
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get('/api/db/ping', async (_req, res) => {
  try {
    const r = await query('select now() as now');
    res.json({ ok: true, now: r.rows[0].now });
  } catch (e) {
    console.error('DB PING ERRO:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/* ------------------------------------------------------------
 *  Home: KPIs / Pendências / Avisos / Integrações
 *  (para o dashboard)
 * ------------------------------------------------------------ */
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

app.get('/api/home/kpis', async (req, res) => {
  try {
    const { from, to } = req.query;
    const where = [];
    const params = [];
    if (from) { params.push(from); where.push(`created_at >= $${params.length}`); }
    if (to)   { params.push(to);   where.push(`created_at <  $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const cols = await tableHasColumns('devolucoes', ['conciliado_em']);
    const sql = `
      WITH base AS (
        SELECT
          LOWER(COALESCE(status,'')) AS st,
          ${cols.conciliado_em ? 'conciliado_em' : 'NULL::timestamp'} AS conciliado_em
        FROM devolucoes
        ${whereSql}
      )
      SELECT
        COUNT(*)::int                                                        AS total,
        SUM(CASE WHEN st LIKE '%pend%' THEN 1 ELSE 0 END)::int              AS pendentes,
        SUM(CASE WHEN st LIKE '%aprov%' THEN 1 ELSE 0 END)::int             AS aprovadas,
        SUM(CASE WHEN st LIKE '%rej%' OR st LIKE '%neg%' THEN 1 ELSE 0 END)::int AS rejeitadas,
        SUM(CASE WHEN conciliado_em IS NULL THEN 1 ELSE 0 END)::int         AS a_conciliar
      FROM base
    `;
    const r = await query(sql, params);
    res.json(r.rows[0] || { total:0, pendentes:0, aprovadas:0, rejeitadas:0, a_conciliar:0 });
  } catch (e) {
    console.error('GET /api/home/kpis erro:', e);
    res.status(500).json({ error: 'Falha ao calcular KPIs.' });
  }
});

app.get('/api/home/pending', async (_req, res) => {
  try {
    const cols = await tableHasColumns('devolucoes', ['log_status','cd_inspecionado_em','conciliado_em']);
    const whereSemInspecao = [];
    if (cols.log_status) whereSemInspecao.push(`log_status IN ('recebido_cd','em_inspecao')`);
    if (cols.cd_inspecionado_em) whereSemInspecao.push(`cd_inspecionado_em IS NULL`);
    const sql1 = `
      SELECT id, id_venda, loja_nome, sku
      FROM devolucoes
      ${whereSemInspecao.length ? 'WHERE ' + whereSemInspecao.join(' AND ') : 'WHERE 1=0'}
      ORDER BY id DESC LIMIT 20
    `;
    const sql2 = `
      SELECT id, id_venda, loja_nome, sku
      FROM devolucoes
      ${cols.conciliado_em ? 'WHERE conciliado_em IS NULL' : ''}
      ORDER BY id DESC LIMIT 20
    `;
    const [r1, r2] = await Promise.all([ query(sql1), query(sql2) ]);
    res.json({
      recebidos_sem_inspecao: r1.rows || [],
      sem_conciliacao_csv: (cols.conciliado_em ? r2.rows : []) || [],
      csv_pendente: []
    });
  } catch (e) {
    console.error('GET /api/home/pending erro:', e);
    res.status(500).json({ error: 'Falha ao listar pendências.' });
  }
});

app.get('/api/home/announcements', (_req, res) => {
  res.json({
    items: [
      'Conciliação por CSV do Mercado Livre disponível.',
      'Integração direta com ML em breve (fase beta).'
    ]
  });
});

app.get('/api/integrations/health', async (_req, res) => {
  try {
    const q = await query(`select count(*)::int as n from bling_accounts`);
    const blingOk = (q.rows[0]?.n || 0) > 0;
    res.json({
      bling: { ok: blingOk, mode: 'oauth' },
      mercado_livre: { ok: false, mode: 'csv' }
    });
  } catch (e) {
    res.json({
      bling: { ok: false, error: 'indisponível' },
      mercado_livre: { ok: false, mode: 'csv' }
    });
  }
});

/* ------------------------------------------------------------
 *  Log de custos (lista paginada, com filtros e soma total)
 * ------------------------------------------------------------ */
app.get('/api/returns/logs', async (req, res) => {
  try {
    const {
      from, to, status, log_status, responsavel, loja, q,
      page = '1', pageSize = '50',
      orderBy = 'event_at', orderDir = 'desc'
    } = req.query;

    const params = [];
    const where = [];

    if (from) { params.push(from); where.push(`event_at >= $${params.length}`); }
    if (to)   { params.push(to);   where.push(`event_at <  $${params.length}`); }
    if (status)      { params.push(String(status).toLowerCase());      where.push(`LOWER(status) = $${params.length}`); }
    if (log_status)  { params.push(String(log_status).toLowerCase());  where.push(`LOWER(log_status) = $${params.length}`); }
    if (responsavel) { params.push(String(responsavel).toLowerCase()); where.push(`LOWER(responsavel_custo) = $${params.length}`); }
    if (loja)        { params.push(`%${loja}%`);                       where.push(`loja_nome ILIKE $${params.length}`); }
    if (q) {
      const like = `%${q}%`;
      params.push(like, like, like, like);
      where.push(`(
        numero_pedido ILIKE $${params.length - 3} OR
        cliente_nome  ILIKE $${params.length - 2} OR
        sku           ILIKE $${params.length - 1} OR
        reclamacao    ILIKE $${params.length}
      )`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const allowedOrder = new Set([
      'event_at','status','log_status','numero_pedido','cliente_nome','loja_nome',
      'valor_produto','valor_frete','total'
    ]);
    const col = allowedOrder.has(String(orderBy)) ? String(orderBy) : 'event_at';
    const dir = String(orderDir).toLowerCase() === 'asc' ? 'asc' : 'desc';

    const limit   = Math.max(1, Math.min(parseInt(pageSize, 10) || 50, 200));
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const offset  = (pageNum - 1) * limit;

    async function viewHasColumns() {
      const cols = await tableHasColumns('v_return_cost_log', ['return_id','log_status','total','event_at']);
      return cols.return_id === true;
    }

    let sqlItems, sqlCount, sqlSum, paramsItems, paramsCount;

    if (await viewHasColumns()) {
      const baseSql = `FROM public.v_return_cost_log ${whereSql}`;
      sqlItems = `SELECT * ${baseSql} ORDER BY ${col} ${dir} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      sqlCount = `SELECT COUNT(*)::int AS count ${baseSql}`;
      sqlSum   = `SELECT COALESCE(SUM(total),0)::numeric AS sum ${baseSql}`;
      paramsItems = [...params, limit, offset];
      paramsCount = [...params];
    } else {
      const baseSql = `
        FROM (
          SELECT
            d.id                               AS return_id,
            d.created_at                       AS event_at,
            COALESCE(d.id_venda, d.nfe_numero) AS numero_pedido,
            d.cliente_nome,
            d.loja_nome,
            LOWER(COALESCE(d.status,''))       AS status,
            LOWER(COALESCE(d.log_status,''))   AS log_status,
            d.valor_produto,
            d.valor_frete,
            d.sku,
            COALESCE(d.tipo_reclamacao, d.reclamacao) AS reclamacao,
            CASE
              WHEN LOWER(COALESCE(d.status,'')) LIKE '%rej%' OR LOWER(COALESCE(d.status,'')) LIKE '%neg%' THEN 0
              WHEN LOWER(COALESCE(d.tipo_reclamacao,'')) LIKE '%cliente%' OR LOWER(COALESCE(d.reclamacao,'')) LIKE '%cliente%' THEN 0
              WHEN LOWER(COALESCE(d.log_status,'')) IN ('recebido_cd','em_inspecao') THEN COALESCE(d.valor_frete,0)
              ELSE COALESCE(d.valor_produto,0) + COALESCE(d.valor_frete,0)
            END::numeric(12,2) AS total,
            NULL::text AS responsavel_custo
          FROM devolucoes d
        ) v
        ${whereSql}
      `;
      sqlItems = `SELECT * ${baseSql} ORDER BY ${col} ${dir} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      sqlCount = `SELECT COUNT(*)::int AS count ${baseSql}`;
      sqlSum   = `SELECT COALESCE(SUM(total),0)::numeric AS sum ${baseSql}`;
      paramsItems = [...params, limit, offset];
      paramsCount = [...params];
    }

    const [itemsQ, countQ, sumQ] = await Promise.all([
      query(sqlItems, paramsItems),
      query(sqlCount, paramsCount),
      query(sqlSum,   paramsCount),
    ]);

    res.json({
      items: itemsQ.rows,
      total: countQ.rows[0]?.count || 0,
      sum_total: sumQ.rows[0]?.sum || 0
    });
  } catch (e) {
    console.error('GET /api/returns/logs erro:', e);
    res.status(500).json({ error: 'Falha ao buscar registro.' });
  }
});

/* ============================================================
 *  START DO SERVIDOR
 * ============================================================ */
const port = process.env.PORT || 3000; // Render injeta PORT
const host = '0.0.0.0';                // ouvir em todas as interfaces

const server = app.listen(port, host, () => {
  console.log(`[BOOT] Server listening on http://${host}:${port}`);
});

/* ============================================================
 *  CAPTURA DE ERROS NÃO TRATADOS
 * ============================================================ */
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

// Exporta app para testes automáticos, se desejar
module.exports = app;
