// server/server.js
'use strict';

/**
 * -------------------------------------------------------------
 *  Retorno Fácil – Servidor HTTP (Express)
 * -------------------------------------------------------------
 */

try {
  if (process.env.NODE_ENV !== 'production') {
    // override: true = .env SOBRESCREVE variáveis já existentes
    require('dotenv').config({ override: true });
    console.log('[BOOT] dotenv carregado (.env) [override]');
  }
} catch (_) {
  console.log('[BOOT] dotenv não carregado (ok em produção)');
}

const express = require('express');
const path = require('path');
const { query } = require('./db');

/* === Sessão === */
const session = require('express-session');
const ConnectPg = require('connect-pg-simple')(session);

const app = express();
app.disable('x-powered-by');

// após registrar os middlewares estáticos
app.get('/', (req, res) => {
  if (req.session?.user) return res.redirect('/home.html');
  return res.redirect('/login.html');
});

/** Parsers globais (ANTES das rotas) */
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Tratador de JSON inválido (evita 500)
app.use((err, _req, res, next) => {
  if (err?.type === 'entity.parse.failed' || (err instanceof SyntaxError && 'body' in err)) {
    return res.status(400).json({ ok: false, error: 'invalid_json' });
  }
  next(err);
});

/** Sessão (antes do static e de qualquer rota) */
app.set('trust proxy', 1);
app.use(session({
  store: new ConnectPg({
    conString: process.env.DATABASE_URL,
    createTableIfMissing: true,
    tableName: 'session'
  }),
  name: 'rf.sid',
  secret: process.env.SESSION_SECRET || 'dev-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 12 * 60 * 60 * 1000 // 12h (sobrescrito pelo "remember me")
  }
}));

/** Static (raiz /public) */
app.use(express.static(path.join(__dirname, '..', 'public')));

/** Aliases para documentação estática */
app.get('/docs', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'docs', 'index.html'));
});
app.get('/docs/:slug', (req, res) => {
  const slug = encodeURIComponent(req.params.slug || '');
  res.redirect(`/docs/index.html?g=${slug}`);
});

/** SSE (opcional) */
try {
  const events = require('./events');
  if (typeof events?.sse === 'function') {
    app.get('/events', events.sse);
    console.log('[BOOT] SSE /events habilitado');
  } else {
    console.warn('[BOOT] SSE desabilitado: função sse não encontrada em ./events');
  }
} catch (e) {
  console.warn('[BOOT] SSE desabilitado (./events ausente):', e?.message || e);
}

/** Cabeçalho de resposta JSON nas rotas /api */
app.use('/api', (_req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  next();
});

/** Rotas de autenticação */
const authRoutes = require('./routes/auth');
app.use('/api/auth', authRoutes);

/* ========= Auth - Registro de usuário (cadastro) ========= */
try {
  const registerAuthRegister = require('./routes/auth-register');
  if (typeof registerAuthRegister === 'function') {
    registerAuthRegister(app);
    console.log('[BOOT] Rotas Auth Register registradas (/api/auth/register, /api/auth/check-email)');
  }
} catch (e) {
  console.warn('[BOOT] Rotas Auth Register não carregadas (opcional):', e?.message || e);
}

/** Compatibilidade: front antigo que POSTava em /login */
app.post('/login', (req, res) => res.redirect(307, '/api/auth/login'));

/** Guard de autenticação para /api (exceto rotas abertas) */
app.use('/api', (req, res, next) => {
  const p = req.path; // '/health', '/db/ping', '/auth/login', etc.
  if (
    p === '/health' ||        // GET /api/health
    p === '/db/ping' ||       // GET /api/db/ping
    p.startsWith('/auth/')    // /api/auth/*
  ) {
    return next();
  }

  // Exceção segura: permite o job interno chamar /api/ml/claims/import com token
  const jobHeader = req.get('x-job-token');
  const jobToken  = process.env.JOB_TOKEN || process.env.ML_JOB_TOKEN;
  if (p === '/ml/claims/import' && jobHeader && jobToken && jobHeader === jobToken) {
    return next();
  }

  if (req.session?.user) return next();
  return res.status(401).json({ error: 'Não autorizado' });
});

/** RBAC por prefixo */
app.use('/api/csv', authRoutes.roleRequired?.('admin', 'gestor') || ((_, __, next) => next()));
app.use('/api/settings', authRoutes.roleRequired?.('admin', 'gestor') || ((_, __, next) => next()));

/* ===========================
 *  HELPERS / UTIL
 * =========================== */
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

function safeParseJson(s) {
  if (s == null) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(String(s)); } catch { return null; }
}

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

/** addReturnEvent (idempotente) */
async function addReturnEvent({
  returnId, type, title = null, message = null, meta = null,
  createdBy = 'system', idempKey = null
}) {
  const metaStr = meta != null ? JSON.stringify(meta) : null;
  try {
    const { rows } = await query(
      `INSERT INTO return_events
         (return_id, type, title, message, meta, created_by, created_at, idemp_key)
       VALUES ($1,$2,$3,$4,$5,$6, now(), $7)
       RETURNING id, return_id AS "returnId", type, title, message, meta,
                 created_by AS "createdBy", created_at AS "createdAt",
                 idemp_key AS "idempotencyKey"`,
      [returnId, type, title, message, metaStr, createdBy, idempKey]
    );
    const ev = rows[0];
    ev.meta = safeParseJson(ev.meta);
    return ev;
  } catch (e) {
    if (String(e?.code) === '23505' && idempKey) {
      const { rows } = await query(
        `SELECT id, return_id AS "returnId", type, title, message, meta,
                created_by AS "createdBy", created_at AS "createdAt",
                idemp_key AS "idempotencyKey"
           FROM return_events
          WHERE idemp_key = $1
          LIMIT 1`,
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

/* ========= Rotas utilitárias ========= */
try {
  const utilsRoutes = require('./routes/utils');
  app.use(utilsRoutes);
  console.log('[BOOT] Rotas /utils carregadas');
} catch (e) {
  console.warn('[BOOT] Falha ao carregar rotas /utils:', e?.message || e);
}

/* ========= CSV (upload estendido) ========= */
try {
  const registerCsvUploadExtended = require('./routes/csv-upload-extended');
  registerCsvUploadExtended(app, { addReturnEvent });
  console.log('[BOOT] Rotas CSV carregadas');
} catch (e) {
  console.warn('[BOOT] Falha ao carregar rotas CSV:', e?.message || e);
}

/* ========= Central (overview) ========= */
try {
  const registerCentral = require('./routes/central');
  if (typeof registerCentral === 'function') {
    registerCentral(app);
    console.log('[BOOT] Rotas Central registradas');
  }
} catch (e) {
  console.warn('[BOOT] Rotas Central não carregadas (opcional):', e?.message || e);
}

/* ========= Returns (listagem genérica) ========= */
try {
  const registerReturns = require('./routes/returns');
  if (typeof registerReturns === 'function') {
    registerReturns(app);
    console.log('[BOOT] Rotas Returns registradas');
  }
} catch (e) {
  console.warn('[BOOT] Rotas Returns não carregadas (opcional):', e?.message || e);
}

/* ========= Webhook Mercado Livre ========= */
try {
  const registerMlWebhook = require('./routes/ml-webhook');
  if (typeof registerMlWebhook === 'function') {
    registerMlWebhook(app);
    console.log('[BOOT] Webhook ML registrado');
  }
} catch (e) {
  console.warn('[BOOT] Webhook ML não carregado (opcional):', e?.message || e);
}

/* ========= OAuth Mercado Livre ========= */
try {
  const registerMlAuth = require('./routes/ml-auth');
  if (typeof registerMlAuth === 'function') {
    registerMlAuth(app);
    console.log('[BOOT] Rotas ML OAuth registradas');
  }
} catch (e) {
  console.warn('[BOOT] Rotas ML OAuth não carregadas (opcional):', e?.message || e);
}

/* ========= API Mercado Livre (stores/contas) ========= */
try {
  const registerMlApi = require('./routes/ml-api');
  if (typeof registerMlApi === 'function') {
    registerMlApi(app);
    console.log('[BOOT] Rotas ML API registradas');
  }
} catch (e) {
  console.warn('[BOOT] Rotas ML API não carregadas (opcional):', e?.message || e);
}

/* ========= Importador Mercado Livre (Sync Claims -> devolucoes) ========= */
let _mlSyncRegistered = false;
try {
  const registerMlSync = require('./routes/ml-sync'); // deve expor /api/ml/claims/import
  if (typeof registerMlSync === 'function') {
    registerMlSync(app, { addReturnEvent });
    _mlSyncRegistered = true;
    console.log('[BOOT] Importador ML registrado (/api/ml/claims/import)');
  }
} catch (e) {
  console.warn('[BOOT] Importador ML não carregado (opcional):', e?.message || e);
}

/* ------------------------------------------------------------
 *  Healthchecks
 * ------------------------------------------------------------ */
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));
app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
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
 *  Events API — listar eventos por return_id (auditoria)
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
 *  Log de custos (com suporte a ?return_id=)
 * ------------------------------------------------------------ */
app.get('/api/returns/logs', async (req, res) => {
  try {
    const {
      from, to, status, log_status, responsavel, loja, q,
      return_id,
      page = '1', pageSize = '50',
      orderBy = 'event_at', orderDir = 'desc'
    } = req.query;

    const params = [];
    const where = [];

    if (from)       { params.push(from);                   where.push(`event_at >= $${params.length}`); }
    if (to)         { params.push(to);                     where.push(`event_at <  $${params.length}`); }
    if (status)     { params.push(String(status).toLowerCase());     where.push(`LOWER(status) = $${params.length}`); }
    if (log_status) { params.push(String(log_status).toLowerCase()); where.push(`LOWER(log_status) = $${params.length}`); }
    if (responsavel){ params.push(String(responsavel).toLowerCase());where.push(`LOWER(responsavel_custo) = $${params.length}`); }
    if (loja)       { params.push(`%${loja}%`);                        where.push(`loja_nome ILIKE $${params.length}`); }
    if (return_id)  { params.push(parseInt(return_id,10));             where.push(`return_id = $${params.length}`); }
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

    const hasViewCols = await tableHasColumns('v_return_cost_log', ['return_id','event_at','total']);

    let sqlItems, sqlCount, sqlSum, paramsItems, paramsCount;

    if (hasViewCols.return_id) {
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
      sum_total: sumQ.rows[0]?.sum || 0,
      page: pageNum,
      pageSize: limit
    });
  } catch (e) {
    console.error('GET /api/returns/logs erro:', e);
    res.status(500).json({ error: 'Falha ao buscar registro.' });
  }
});

/* ------------------------------------------------------------
 *  DASHBOARD (dados consolidados)
 * ------------------------------------------------------------ */
app.get('/api/dashboard', async (req, res) => {
  const mock = () => {
    const today = new Date();
    const daily = Array.from({ length: 30 }).map((_, i) => {
      const d = new Date(today.getTime() - (29 - i) * 86400000);
      return { date: d.toISOString().slice(0, 10), prejuizo: Math.round(Math.random() * 2000) };
    });
    const monthly = Array.from({ length: 6 }).map((_, i) => {
      const dt = new Date(today.getFullYear(), today.getMonth() - 5 + i, 1);
      return { month: dt.toLocaleString('pt-BR', { month: 'short', year: 'numeric' }), prejuizo: Math.round(Math.random() * 8000) };
    });
    const status = { pendente: 12, aprovado: 34, rejeitado: 7 };
    const top_items = Array.from({ length: Number(req.query.limitTop || 5) }).map((_, i) => ({
      sku: 'SKU-' + (1000 + i),
      devolucoes: Math.floor(Math.random() * 20) + 1,
      prejuizo: Math.round(Math.random() * 1500)
    }));
    const totals = {
      total: 120,
      pendentes: 12,
      aprovadas: 80,
      rejeitadas: 28,
      prejuizo_total: monthly.reduce((s, m) => s + Number(m.prejuizo || 0), 0)
    };
    return { daily, monthly, status, top_items, totals };
  };

  try {
    const { from, to, limitTop = '5' } = req.query;
    const lim = Math.max(1, Math.min(parseInt(limitTop, 10) || 5, 20));

    const now = new Date();
    const defaultTo = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString().slice(0, 10);
    const defaultFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29).toISOString().slice(0, 10);

    const pFrom = from || defaultFrom;
    const pTo   = to   || defaultTo;

    const cols = await tableHasColumns('devolucoes', ['tipo_reclamacao','reclamacao','log_status','valor_produto','valor_frete','status','created_at','sku']);

    if (!cols.created_at) {
      return res.json(mock());
    }

    const params = [pFrom, pTo];

    const qDaily = await query(
      `
      WITH base AS (
        SELECT
          created_at::date AS day,
          LOWER(COALESCE(status,'')) AS st,
          LOWER(COALESCE(log_status,'')) AS ls,
          COALESCE(valor_produto,0) AS vp,
          COALESCE(valor_frete,0) AS vf,
          COALESCE(tipo_reclamacao, reclamacao, '') AS motivo
        FROM devolucoes
        WHERE created_at >= $1 AND created_at < $2
      ),
      calc AS (
        SELECT day,
          CASE
            WHEN st LIKE '%rej%' OR st LIKE '%neg%' THEN 0
            WHEN LOWER(motivo) ~ '(arrepend|cliente|nao serviu|não serviu|mudou de ideia|compra errad|tamanho|cor errad|engano)' THEN 0
            WHEN ls IN ('recebido_cd','em_inspecao') THEN vf
            ELSE vp + vf
          END::numeric(12,2) AS custo
        FROM base
      )
      SELECT day::text AS date, COALESCE(SUM(custo),0)::numeric AS prejuizo
      FROM calc
      GROUP BY 1
      ORDER BY 1
      `,
      params
    );

    const qMonthly = await query(
      `
      WITH base AS (
        SELECT
          date_trunc('month', created_at)::date AS m,
          LOWER(COALESCE(status,'')) AS st,
          LOWER(COALESCE(log_status,'')) AS ls,
          COALESCE(valor_produto,0) AS vp,
          COALESCE(valor_frete,0) AS vf,
          COALESCE(tipo_reclamacao, reclamacao, '') AS motivo
        FROM devolucoes
        WHERE created_at >= $1 AND created_at < $2
      ),
      calc AS (
        SELECT m,
          CASE
            WHEN st LIKE '%rej%' OR st LIKE '%neg%' THEN 0
            WHEN LOWER(motivo) ~ '(arrepend|cliente|nao serviu|não serviu|mudou de ideia|compra errad|tamanho|cor errad|engano)' THEN 0
            WHEN ls IN ('recebido_cd','em_inspecao') THEN vf
            ELSE vp + vf
          END::numeric(12,2) AS custo
        FROM base
      )
      SELECT to_char(m, 'Mon YYYY') AS month, COALESCE(SUM(custo),0)::numeric AS prejuizo
      FROM calc
      GROUP BY 1
      ORDER BY MIN(m)
      `,
      params
    );

    const qStatus = await query(
      `
      WITH base AS (
        SELECT LOWER(COALESCE(status,'')) AS st
        FROM devolucoes
        WHERE created_at >= $1 AND created_at < $2
      )
      SELECT
        SUM(CASE WHEN st LIKE '%pend%' THEN 1 ELSE 0 END)::int  AS pendente,
        SUM(CASE WHEN st LIKE '%aprov%' THEN 1 ELSE 0 END)::int AS aprovado,
        SUM(CASE WHEN st LIKE '%rej%' OR st LIKE '%neg%' THEN 1 ELSE 0 END)::int AS rejeitado
      FROM base
      `,
      params
    );

    const qTotals = await query(
      `
      WITH base AS (
        SELECT
          LOWER(COALESCE(status,'')) AS st,
          LOWER(COALESCE(log_status,'')) AS ls,
          COALESCE(valor_produto,0) AS vp,
          COALESCE(valor_frete,0) AS vf,
          COALESCE(tipo_reclamacao, reclamacao, '') AS motivo
        FROM devolucoes
        WHERE created_at >= $1 AND created_at < $2
      ),
      calc AS (
        SELECT
          CASE
            WHEN st LIKE '%rej%' OR st LIKE '%neg%' THEN 0
            WHEN LOWER(motivo) ~ '(arrepend|cliente|nao serviu|não serviu|mudou de ideia|compra errad|tamanho|cor errad|engano)' THEN 0
            WHEN ls IN ('recebido_cd','em_inspecao') THEN vf
            ELSE vp + vf
          END::numeric(12,2) AS custo,
          st
        FROM base
      )
      SELECT
        (SELECT COUNT(*)::int FROM calc)                                               AS total,
        (SELECT COUNT(*)::int FROM calc WHERE st LIKE '%pend%')                        AS pendentes,
        (SELECT COUNT(*)::int FROM calc WHERE st LIKE '%aprov%')                       AS aprovadas,
        (SELECT COUNT(*)::int FROM calc WHERE st LIKE '%rej%' OR st LIKE '%neg%')      AS rejeitadas,
        (SELECT COALESCE(SUM(custo),0)::numeric FROM calc)                              AS prejuizo_total
      `,
      params
    );

    const qTop = await query(
      `
      WITH base AS (
        SELECT
          sku,
          COALESCE(tipo_reclamacao, reclamacao, '') AS motivo,
          LOWER(COALESCE(status,'')) AS st,
          LOWER(COALESCE(log_status,'')) AS ls,
          COALESCE(valor_produto,0) AS vp,
          COALESCE(valor_frete,0) AS vf,
          created_at
        FROM devolucoes
        WHERE created_at >= $1 AND created_at < $2
      ),
      calc AS (
        SELECT
          sku,
          motivo,
          CASE
            WHEN st LIKE '%rej%' OR st LIKE '%neg%' THEN 0
            WHEN LOWER(motivo) ~ '(arrepend|cliente|nao serviu|não serviu|mudou de ideia|compra errad|tamanho|cor errad|engano)' THEN 0
            WHEN ls IN ('recebido_cd','em_inspecao') THEN vf
            ELSE vp + vf
          END::numeric(12,2) AS custo
        FROM base
      ),
      agg AS (
        SELECT
          sku,
          COUNT(*)::int AS devolucoes,
          COALESCE(SUM(custo),0)::numeric AS prejuizo
        FROM calc
        GROUP BY sku
      ),
      motivo_rank AS (
        SELECT
          sku, motivo,
          ROW_NUMBER() OVER (PARTITION BY sku ORDER BY COUNT(*) DESC) AS rn
        FROM calc
        GROUP BY sku, motivo
      )
      SELECT a.sku, a.devolucoes, a.prejuizo, mr.motivo
      FROM agg a
      LEFT JOIN motivo_rank mr ON mr.sku = a.sku AND mr.rn = 1
      WHERE a.sku IS NOT NULL AND A.sku <> ''
      ORDER BY a.devolucoes DESC, a.prejuizo DESC
      LIMIT $3
      `,
      [pFrom, pTo, lim]
    );

    const data = {
      daily: qDaily.rows,
      monthly: qMonthly.rows,
      status: qStatus.rows[0] || { pendente: 0, aprovado: 0, rejeitado: 0 },
      top_items: qTop.rows,
      totals: qTotals.rows[0] || { total: 0, pendentes: 0, aprovadas: 0, rejeitadas: 0, prejuizo_total: 0 }
    };

    return res.json(data);
  } catch (e) {
    console.error('GET /api/dashboard erro:', e);
    return res.json(mock());
  }
});

/* ------------------------------------------------------------
 *  KPIs / Pendências / Integrações (Home)
 * ------------------------------------------------------------ */
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
      FROM base`;
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
  } catch {
    res.json({
      bling: { ok: false, error: 'indisponível' },
      mercado_livre: { ok: false, mode: 'csv' }
    });
  }
});

/* ===========================
 *  START
 * =========================== */
const port = process.env.PORT || 3000;
const host = '0.0.0.0';

const server = app.listen(port, host, () => {
  console.log(`[BOOT] Server listening on http://${host}:${port}`);
  // Inicia o AutoSync do ML após o servidor subir
  setupMlAutoSync();
});

/* ===========================
 *  AUTO SYNC (ML) — JOB PERIÓDICO
 * =========================== */
let _mlAuto_lastRun = null; // exposto em /api/ml/claims/last-run

function setupMlAutoSync() {
  if (!_mlSyncRegistered) {
    console.warn('[ML AUTO] Importador ML não está registrado; AutoSync desabilitado.');
    return;
  }

  // Habilitado por padrão — pode ser desativado via env
  const enabled = String(process.env.ML_AUTO_SYNC_ENABLED ?? 'true').toLowerCase() === 'true';
  if (!enabled) {
    console.log('[ML AUTO] Desabilitado por ML_AUTO_SYNC_ENABLED=false');
    return;
  }

  const intervalMs = Math.max(60_000, parseInt(process.env.ML_AUTO_SYNC_INTERVAL_MS || '600000', 10) || 600_000); // 10 min
  const windowDays = Math.max(1, parseInt(process.env.ML_AUTO_SYNC_WINDOW_DAYS || '14', 10) || 14);
  const runOnStart = String(process.env.ML_AUTO_SYNC_ON_START ?? 'true').toLowerCase() === 'true';
  const jobToken   = process.env.JOB_TOKEN || process.env.ML_JOB_TOKEN || 'dev-job';

  let running = false;

  const run = async (reason = 'timer') => {
    if (running) {
      console.log('[ML AUTO] Já existe uma execução em andamento; pulando.');
      return;
    }
    running = true;
    const t0 = Date.now();
    const url = `http://127.0.0.1:${port}/api/ml/claims/import?days=${encodeURIComponent(windowDays)}&silent=1`;

    try {
      // Node 18+ possui fetch global
      const r = await fetch(url, { headers: { 'x-job-token': jobToken } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || r.statusText || 'Falha no import');

      _mlAuto_lastRun = {
        when: new Date().toISOString(),
        reason,
        ok: true,
        tookMs: Date.now() - t0,
        result: j
      };
      console.log(`[ML AUTO] Import OK (${reason}) em ${_mlAuto_lastRun.tookMs}ms`, j);
    } catch (e) {
      _mlAuto_lastRun = {
        when: new Date().toISOString(),
        reason,
        ok: false,
        tookMs: Date.now() - t0,
        error: String(e?.message || e)
      };
      console.error('[ML AUTO] Falha no import:', _mlAuto_lastRun.error);
    } finally {
      running = false;
    }
  };

  // Primeiro disparo
  if (runOnStart) setTimeout(() => run('boot'), 2000);

  // Intervalo fixo
  const handle = setInterval(run, intervalMs);
  process.on('SIGINT',  () => clearInterval(handle));
  process.on('SIGTERM', () => clearInterval(handle));

  // Endpoint de diagnóstico do AutoSync (requer sessão)
  app.get('/api/ml/claims/last-run', (_req, res) => {
    res.json({
      enabled,
      intervalMs,
      windowDays,
      runOnStart,
      registered: _mlSyncRegistered,
      lastRun: _mlAuto_lastRun
    });
  });

  console.log(`[BOOT] ML AutoSync habilitado: intervalo=${intervalMs}ms, janela=${windowDays}d`);
}

/* ===========================
 *  ERROS NÃO TRATADOS
 * =========================== */
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));
process.on('uncaughtException',  err => console.error('[uncaughtException]', err));

module.exports = app;
