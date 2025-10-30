// server/server.js
'use strict';

/**
 * -------------------------------------------------------------
 *  Retorno Fácil – Servidor HTTP (Express)
 * -------------------------------------------------------------
 */

// Polyfill de fetch p/ Node < 18
if (typeof fetch !== 'function') {
  // carregamento dinâmico para evitar dependência dura em prod
  global.fetch = (...args) => import('node-fetch').then(m => m.default(...args));
}

try {
  if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config({ override: true });
    console.log('[BOOT] dotenv carregado (.env) [override]');
  }
} catch (_) {
  console.log('[BOOT] dotenv não carregado (ok em produção)');
}

const express    = require('express');
const path       = require('path');
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const session    = require('express-session');
const ConnectPg  = require('connect-pg-simple')(session);
const { query }  = require('./db'); // fallback

const app = express();
app.disable('x-powered-by');

/** ================== Segurança base ================== */
app.use(helmet({
  contentSecurityPolicy: false, // para não quebrar inline scripts do front atual
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  referrerPolicy: { policy: 'no-referrer' }
}));

/** ================== CORS (apenas dev) ================== */
if (process.env.NODE_ENV !== 'production') {
  app.use(cors({
    origin: true,           // ecoa origem do navegador
    credentials: true,      // permite cookie de sessão
    methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
    allowedHeaders: ['Content-Type','Accept','Idempotency-Key','x-job-token']
  }));
}

/** Parsers globais (ANTES das rotas) */
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Tratador de JSON inválido (logo após os parsers)
app.use((err, _req, res, next) => {
  if (err?.type === 'entity.parse.failed' || (err instanceof SyntaxError && 'body' in err)) {
    return res.status(400).json({ ok: false, error: 'invalid_json' });
  }
  next(err);
});

/**
 * Sessão (antes do static e de qualquer rota)
 */
app.set('trust proxy', 1);

const reloginOnClose = /^true|1|yes$/i.test(process.env.SESSION_RELOGIN_ON_CLOSE || 'true');
const sessCookie = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  ...(reloginOnClose ? {} : { maxAge: 12 * 60 * 60 * 1000 }), // 12h
};

app.use(session({
  store: new ConnectPg({
    conString: process.env.DATABASE_URL,
    createTableIfMissing: true,
    tableName: 'session'
  }),
  name: process.env.SESSION_NAME || 'cf.sid',
  secret: process.env.SESSION_SECRET || 'dev-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: sessCookie
}));

const dashboardRoutes = require('./routes/dashboard');

app.use('/api/dashboard', dashboardRoutes);

/** Static (raiz /public) */
app.use(express.static(path.join(__dirname, '..', 'public')));

require('./routes/dashboard')(app);

app.get('/api/health', (_req, res) => res.json({ ok: true }));

/** Aliases para documentação estática */
app.get('/docs', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'docs', 'index.html'));
});
app.get('/docs/:slug', (req, res) => {
  const slug = encodeURIComponent(req.params.slug || '');
  res.redirect(`/docs/index.html?g=${slug}`);
});

/** Página raiz (depois da sessão) */
app.get('/', (req, res) => {
  if (req.session?.user) return res.redirect('/home.html');
  return res.redirect('/login.html');
});

/** SSE (antes do middleware que toca Content-Type) */
try {
  const events = require('./events');
  if (typeof events?.sse === 'function') {
    app.get('/api/events', events.sse);
    app.get('/events', events.sse);
    console.log('[BOOT] SSE habilitado em /api/events (alias: /events)');
  } else {
    console.warn('[BOOT] SSE desabilitado: função sse não encontrada em ./events');
  }
} catch (e) {
  console.warn('[BOOT] SSE desabilitado (./events ausente):', e?.message || e);
}

/**
 * Patch seguro: ao usar res.json em /api, garante Content-Type JSON
 * (sem afetar endpoints binários como /api/uploads).
 */
app.use('/api', (_req, res, next) => {
  if (!res.locals.__jsonPatched) {
    const _json = res.json.bind(res);
    res.json = (body) => {
      if (!res.get('Content-Type')) {
        res.set('Content-Type', 'application/json; charset=utf-8');
      }
      return _json(body);
    };
    res.locals.__jsonPatched = true;
  }
  next();
});

/* ========= Auth Register (público/optativo) ========= */
try {
  const registerAuthRegister = require('./routes/auth-register');
  if (typeof registerAuthRegister === 'function') {
    registerAuthRegister(app);
    console.log('[BOOT] Rotas Auth Register registradas (/api/auth/register, /api/auth/check-email)');
  }
} catch (e) {
  console.warn('[BOOT] Rotas Auth Register não carregadas (opcional):', e?.message || e);
}

/** ========== Rate limit no login (5 tentativas / 15min p/ IP) ========== */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip
});
app.use('/api/auth/login', loginLimiter);

/** ========== Rotas de autenticação gerais ========== */
const authRoutes = require('./routes/auth');
app.use('/api/auth', authRoutes);

/** Sessão leve/ME p/ front (antes do guard) */
app.get('/api/auth/session', (req, res) => {
  const u = req.session?.user || null;
  res.json(u ? { id: u.id, nome: u.nome, email: u.email, roles: u.roles || [] } : null);
});
// Compat com requisito: /api/auth/me
app.get('/api/auth/me', (req, res) => {
  const u = req.session?.user || null;
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  res.json({ id: u.id, nome: u.nome, email: u.email, roles: u.roles || [] });
});

/** -----------------------------------------------------------------
 *  Guard /api — DEPOIS das rotas abertas
 * ----------------------------------------------------------------- */
app.use('/api', (req, res, next) => {
  const p         = String(req.path || '');
  const origLower = String(req.originalUrl || '').toLowerCase();

  const isOpen =
    p === '/health' ||
    p === '/db/ping' ||
    origLower.startsWith('/api/auth/');

  const jobHeader = req.get('x-job-token');
  const jobToken  = process.env.JOB_TOKEN || process.env.ML_JOB_TOKEN;
  const isJob     = origLower.startsWith('/api/ml/claims/import') && jobHeader && jobToken && jobHeader === jobToken;

  if (isOpen || isJob) return next();
  if (req.session?.user) return next();

  console.warn('[GUARD 401]', req.method, req.originalUrl, 'path=', req.path);
  return res.status(401).json({ error: 'Não autorizado' });
});

/** Compat: front antigo que POSTava em /login */
app.post('/login', (_req, res) => res.redirect(307, '/api/auth/login'));

/** --------- MULTI-TENANT (RLS) --------- */
try {
  const tenantMw = require('./middleware/tenant-mw');
  app.use('/api', tenantMw());
  console.log('[BOOT] Tenant RLS habilitado em /api');
} catch (e) {
  console.warn('[BOOT] Tenant RLS não carregado (./middleware/tenant-mw):', e?.message || e);
}

/** --------- RBAC enforce nas rotas /api PATCH --------- */
try {
  const { rbacEnforce } = require('./middlewares/auth'); // se existir
  if (typeof rbacEnforce === 'function') {
    app.use('/api', rbacEnforce());
    console.log('[BOOT] RBAC enforce aplicado em /api (PATCH rules)');
  }
} catch (e) {
  console.warn('[BOOT] RBAC middleware não encontrado (./middlewares/auth):', e?.message || e);
}

/** --------- Helpers --------- */
const qOf = (req) => (req?.q || query);

function safeParseJson(s) {
  if (s == null) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(String(s)); } catch { return null; }
}

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

/** --------- Fallback de Tenant (DEV/seguro) --------- */
app.use('/api', (req, _res, next) => {
  try {
    const user = req.session?.user || {};
    req.tenant = req.tenant || {};
    const emailPrefix = (user.email || '').split('@')[0] || null;

    if (!req.tenant.slug) {
      req.tenant.slug = process.env.TENANT_TEXT_FALLBACK || user.company || emailPrefix || 'default';
    }
    if (req.tenant.id == null && user.tenant_id != null) {
      req.tenant.id = user.tenant_id;
    }

    next();
  } catch {
    next();
  }
});

/* ===========================
 *  HELPERS / UTIL (env checks)
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
  'MELI_OWNER_TOKEN',
  'TENANT_TEXT_FALLBACK'
].forEach(k => {
  if (!process.env[k]) console.warn(`[WARN] Variável de ambiente ausente: ${k}`);
});

/** addReturnEvent (idempotente) — respeita RLS se receber req.q */
async function addReturnEvent(args = {}, req) {
  const {
    returnId, type, title = null, message = null, meta = null,
    createdBy = 'system', idempKey = null, q: injectedQ
  } = args;

  const q = injectedQ || (req && qOf(req)) || query;
  const metaStr = meta != null ? JSON.stringify(meta) : null;

  try {
    const { rows } = await q(
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
      const { rows } = await q(
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

/* ========= Chat por Devolução (mensagens) ========= */
try {
  const registerReturnMessages = require('./routes/returns-messages');
  if (typeof registerReturnMessages === 'function') {
    registerReturnMessages(app);
  } else {
    app.use('/api', registerReturnMessages);
  }
  console.log('[BOOT] Rotas Chat por Devolução registradas (/api/returns/:id/messages)');
} catch (e) {
  console.warn('[BOOT] Rotas Chat por Devolução não carregadas (opcional):', e?.message || e);
}

/* ========= Uploads (imagens) ========= */
try {
  const uploadsRoutes = require('./routes/uploads');
  app.use('/api/uploads', uploadsRoutes);
  console.log('[BOOT] Rotas Uploads registradas (/api/uploads)');
} catch (e) {
  console.warn('[BOOT] Rotas Uploads não carregadas (opcional):', e?.message || e);
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

/* ========= ML – Amounts (preview de valores) ========= */
try {
  const registerMlAmounts = require('./routes/ml-amounts');
  if (typeof registerMlAmounts === 'function') {
    registerMlAmounts(app);
    console.log('[BOOT] Rotas ML Amounts registradas (/api/ml/returns/:id/fetch-amounts)');
  }
} catch (e) {
  console.warn('[BOOT] Rotas ML Amounts não carregadas (opcional):', e?.message || e);
}

/* ========= ML – Enriquecimento de devolução (valores) ========= */
try {
  const registerMlEnrich = require('./routes/ml-enrich');
  if (typeof registerMlEnrich === 'function') {
    // suporta assinatura opcional (app, { addReturnEvent })
    if (registerMlEnrich.length >= 2) registerMlEnrich(app, { addReturnEvent });
    else registerMlEnrich(app);
    console.log('[BOOT] Rota ML Enrich registrada (/api/ml/returns/:id/enrich)');
  }
} catch (e) {
  console.warn('[BOOT] ML Enrich não carregado (opcional):', e?.message || e);
}

/* ========= ML – Chat/Returns/Reviews (NOVO / opcional) ========= */
try {
  const mlChatRoutes = require('./routes/ml-chat');
  if (mlChatRoutes) {
    app.use('/api/ml', mlChatRoutes);
    console.log('[BOOT] Rotas ML Chat registradas (/api/ml/...)');
  }
} catch (e) {
  console.warn('[BOOT] Rotas ML Chat não carregadas (opcional):', e?.message || e);
}

/* ========= Importador Mercado Livre (Sync Claims -> devolucoes) ========= */
let _mlSyncRegistered = false;
try {
  const registerMlSync = require('./routes/ml-sync'); // expõe /api/ml/claims/import
  if (typeof registerMlSync === 'function') {
    registerMlSync(app, { addReturnEvent });
    _mlSyncRegistered = true;
    console.log('[BOOT] Importador ML registrado (/api/ml/claims/import)');
  }
} catch (e) {
  console.warn('[BOOT] Importador ML não carregado (opcional):', e?.message || e);
}

/* ========= >>> Rotas auxiliares ========= */
try {
  const returnsLogRouter  = require('./routes/returns-log');   // PATCH /api/returns/:id/log
  app.use('/api/returns', returnsLogRouter);
  console.log('[BOOT] Rota Returns Log registrada (/api/returns/:id/log)');
} catch (e) {
  console.warn('[BOOT] Rota Returns Log não carregada (opcional):', e?.message || e);
}

try {
  const mlReenrichRouter  = require('./routes/ml-reenrich');   // POST /api/ml/returns/re-enrich
  app.use('/api/ml', mlReenrichRouter);
  console.log('[BOOT] Rota ML Re-enrich registrada (/api/ml/returns/re-enrich)');
} catch (e) {
  console.warn('[BOOT] Rota ML Re-enrich não carregada (opcional):', e?.message || e);
}

/* ------------------------------------------------------------
 *  Healthchecks
 * ------------------------------------------------------------ */
app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get('/api/db/ping', async (req, res) => {
  try {
    const q = qOf(req);
    const r = await q('select now() as now');
    res.json({ ok: true, now: r.rows[0].now });
  } catch (e) {
    console.error('DB PING ERRO:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/* ------------------------------------------------------------
 *  DEBUG do tenant (útil pra validar RLS)
 * ------------------------------------------------------------ */
app.get('/api/_debug/tenant', async (req, res) => {
  try {
    const q = qOf(req);
    const r = await q(`
      SELECT
        current_setting('app.tenant_id',   true) AS tenant_id,
        current_setting('app.tenant_slug', true) AS tenant_slug
    `);
    const { rows } = await q('SELECT COUNT(*)::int AS n FROM devolucoes');
    res.json({ ...r.rows[0], devolucoes_visiveis: rows[0]?.n || 0 });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/* ------------------------------------------------------------
 *  Events API — listar eventos por return_id (auditoria)
 * ------------------------------------------------------------ */
app.get('/api/returns/:id/events', async (req, res) => {
  try {
    const q = qOf(req);
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
    const { rows } = await q(sql, [returnId, limit, offset]);
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
    const q = qOf(req);
    const {
      from, to, status, log_status, responsavel, loja, q: qstr,
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
    if (qstr) {
      const like = `%${qstr}%`;
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

    const hasViewCols = await tableHasColumns('v_return_cost_log', ['return_id','event_at','total'], req);

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
      q(sqlItems, paramsItems),
      q(sqlCount, paramsCount),
      q(sqlSum,   paramsCount),
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

/* ---------- 404 JSON para qualquer /api não mapeado ---------- */
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

/** ----- Handler de erro final ----- */
app.use((err, req, res, _next) => {
  console.error('[API ERROR]', err);
  const reveal = String(process.env.REVEAL_ERRORS ?? 'false').toLowerCase() === 'true';
  const msg = reveal ? (err?.detail || err?.message || String(err)) : 'Erro interno';
  if (req.path?.startsWith('/api')) {
    res.status(500).json({ error: msg });
  } else {
    res.status(500).send('Erro interno');
  }
});

/* ===========================
 *  START
 * =========================== */
const port = process.env.PORT || 3000;
const host = '0.0.0.0';

const server = app.listen(port, host, () => {
  console.log(`[BOOT] Server listening on http://${host}:${port}`);
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

  const enabled = String(process.env.ML_AUTO_SYNC_ENABLED ?? 'true').toLowerCase() === 'true';
  if (!enabled) {
    console.log('[ML AUTO] Desabilitado por ML_AUTO_SYNC_ENABLED=false');
    return;
  }

  const intervalMs = Math.max(60_000, parseInt(process.env.ML_AUTO_SYNC_INTERVAL_MS || '600000', 10) || 600_000);
  const windowDays = Math.max(1, parseInt(process.env.ML_AUTO_SYNC_WINDOW_DAYS || '14', 10) || 14);
  const runOnStart = String(process.env.ML_AUTO_SYNC_ON_START ?? 'true').toLowerCase() === 'true';
  const jobToken   = process.env.JOB_TOKEN || process.env.ML_JOB_TOKEN || 'dev-job';

  let running = false;

  const run = async (reason = 'timer') => {
    if (running) return;
    running = true;
    const t0 = Date.now();
    const url = `http://127.0.0.1:${port}/api/ml/claims/import?days=${encodeURIComponent(windowDays)}&silent=1`;

    try {
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

  if (runOnStart) setTimeout(() => run('boot'), 2000);
  const handle = setInterval(run, intervalMs);
  process.on('SIGINT',  () => clearInterval(handle));
  process.on('SIGTERM', () => clearInterval(handle));

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

app.use('/api/dashboard', require('./routes/dashboard'));


/* ===========================
 *  ERROS NÃO TRATADOS
 * =========================== */
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));
process.on('uncaughtException',  err => console.error('[uncaughtException]', err));

module.exports = app;
