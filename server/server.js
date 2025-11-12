// server/server.js
'use strict';

/**
 * -------------------------------------------------------------
 *  Controle Facil – Servidor HTTP (Express) 
 * -------------------------------------------------------------
 */

// Polyfill de fetch p/ Node < 18
if (typeof fetch !== 'function') {
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
const { query }  = require('./db');

const app = express();
app.disable('x-powered-by');

/* ================== Segurança ================== */
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  referrerPolicy: { policy: 'no-referrer' }
}));

/* ================== CORS (dev) ================== */
if (process.env.NODE_ENV !== 'production') {
  app.use(cors({
    origin: true,
    credentials: true,
    methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
    allowedHeaders: [
      'Content-Type','Accept','Idempotency-Key','x-job-token',
      'x-seller-token','x-owner','x-seller-id','x-seller-nick','Authorization'
    ]
  }));
}

/* ================== Parsers ================== */
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use((err, _req, res, next) => {
  if (err?.type === 'entity.parse.failed' || (err instanceof SyntaxError && 'body' in err)) {
    return res.status(400).json({ ok:false, error:'invalid_json' });
  }
  next(err);
});

/* ================== Sessão ================== */
app.set('trust proxy', 1);
const reloginOnClose = /^true|1|yes$/i.test(process.env.SESSION_RELOGIN_ON_CLOSE || 'true');
const sessCookie = {
  httpOnly:true,
  sameSite:'lax',
  secure:process.env.NODE_ENV === 'production',
  ...(reloginOnClose ? {} : { maxAge: 12*60*60*1000 })
};
app.use(session({
  store: new ConnectPg({
    conString: process.env.DATABASE_URL,
    createTableIfMissing: true,
    tableName: 'session'
  }),
  name: process.env.SESSION_NAME || 'cf.sid',
  secret: process.env.SESSION_SECRET || 'dev-change-me',
  resave:false,
  saveUninitialized:false,
  cookie:sessCookie
}));

/* ================== Static & básicos ================== */
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/api/health', (_req, res) => res.json({ ok:true, time:new Date().toISOString() }));
app.get('/docs', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'docs', 'index.html')));
app.get('/docs/:slug', (req, res) => res.redirect(`/docs/index.html?g=${encodeURIComponent(req.params.slug||'')}`));
app.get('/', (req, res) => req.session?.user ? res.redirect('/home.html') : res.redirect('/login.html'));

/* ================== SSE (opcional) ================== */
try {
  const events = require('./events');
  if (typeof events?.sse === 'function') {
    app.get('/api/events', events.sse);
    app.get('/events', events.sse);
    console.log('[BOOT] SSE habilitado em /api/events');
  }
} catch (e) {
  console.warn('[BOOT] SSE desabilitado:', e?.message || e);
}

/* Força Content-Type JSON em /api */
app.use('/api', (_req, res, next) => {
  if (!res.locals.__jsonPatched) {
    const _json = res.json.bind(res);
    res.json = (body) => {
      if (!res.get('Content-Type')) res.set('Content-Type', 'application/json; charset=utf-8');
      return _json(body);
    };
    res.locals.__jsonPatched = true;
  }
  next();
});

/* ===== Shim de query para ML (aceitar recent_days como days) ===== */
app.use('/api/ml', (req, _res, next) => {
  try {
    if (req.query && req.query.recent_days && !req.query.days) req.query.days = req.query.recent_days;
    if (req.query && req.query._days && !req.query.days) req.query.days = req.query._days;
  } catch {}
  next();
});

/* ================== Auth públicas ================== */
try {
  const registerAuthRegister = require('./routes/auth-register');
  if (typeof registerAuthRegister === 'function') {
    registerAuthRegister(app);
    console.log('[BOOT] Rotas Auth Register ok');
  }
} catch (e) {
  console.warn('[BOOT] Auth Register opcional:', e?.message || e);
}

const loginLimiter = rateLimit({ windowMs: 15*60*1000, max:5, standardHeaders:true, legacyHeaders:false, keyGenerator:(r)=>r.ip });
app.use('/api/auth/login', loginLimiter);

const authRoutes = require('./routes/auth');
app.use('/api/auth', authRoutes);

app.get('/api/auth/session', (req, res) => {
  const u = req.session?.user || null;
  res.json(u ? { id:u.id, nome:u.nome, email:u.email, roles:u.roles||[] } : null);
});
app.get('/api/auth/me', (req, res) => {
  const u = req.session?.user || null;
  if (!u) return res.status(401).json({ error:'unauthorized' });
  res.json({ id:u.id, nome:u.nome, email:u.email, roles:u.roles||[] });
});

/* ================== Guard /api ================== */
app.use('/api', (req, res, next) => {
  const p = String(req.path||'');
  const orig = String(req.originalUrl||'').toLowerCase();
  const isOpen = p === '/health' || p === '/db/ping' || orig.startsWith('/api/auth/');
  const jobHeader = req.get('x-job-token');
  const jobToken  = process.env.JOB_TOKEN || process.env.ML_JOB_TOKEN;
  const isJob = (
    orig.startsWith('/api/ml/claims/import') ||
    orig.startsWith('/api/ml/refresh')
  ) && jobHeader && jobToken && jobHeader === jobToken;

  if (isOpen || isJob) return next();
  if (req.session?.user) return next();
  return res.status(401).json({ error:'Não autorizado' });
});

app.post('/login', (_req, res) => res.redirect(307, '/api/auth/login'));

/* ================== Tenant & RBAC ================== */
try {
  const tenantMw = require('./middleware/tenant-mw');
  app.use('/api', tenantMw());
  console.log('[BOOT] Tenant RLS ok');
} catch (e) {
  console.warn('[BOOT] Tenant RLS opcional:', e?.message || e);
}

try {
  let authMw = null;
  try { authMw = require('./middleware/auth'); } catch (_) {}
  if (!authMw) { try { authMw = require('./middlewares/auth'); } catch (_) {} }
  const { rbacEnforce } = authMw || {};
  if (typeof rbacEnforce === 'function') {
    app.use('/api', rbacEnforce());
    console.log('[BOOT] RBAC enforce ok');
  }
} catch (e) {
  console.warn('[BOOT] RBAC opcional:', e?.message || e);
}

/* ================== Helpers ================== */
const { query: _query } = require('./db');
const qOf = (req) => (req?.q || query);
const safeParseJson = (s) => {
  if (s == null) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(String(s)); } catch { return null; }
};
async function tableHasColumns(table, columns, req) {
  const q = qOf(req);
  const { rows } = await q(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1`, [table]
  );
  const set = new Set(rows.map(r => r.column_name));
  const out = {}; for (const c of columns) out[c] = set.has(c);
  return out;
}

/* Fallback de tenant (dev) */
app.use('/api', (req, _res, next) => {
  try {
    const user = req.session?.user || {};
    req.tenant = req.tenant || {};
    const emailPrefix = (user.email||'').split('@')[0] || null;
    if (!req.tenant.slug) req.tenant.slug = process.env.TENANT_TEXT_FALLBACK || user.company || emailPrefix || 'default';
    if (req.tenant.id == null && user.tenant_id != null) req.tenant.id = user.tenant_id;
    next();
  } catch { next(); }
});

/* ================== ENV warnings ================== */
[
  'BLING_AUTHORIZE_URL','BLING_TOKEN_URL','BLING_API_BASE','BLING_CLIENT_ID','BLING_CLIENT_SECRET','BLING_REDIRECT_URI',
  'DATABASE_URL','ML_CLIENT_ID','ML_CLIENT_SECRET','ML_REDIRECT_URI','MELI_OWNER_TOKEN','TENANT_TEXT_FALLBACK'
].forEach(k => { if (!process.env[k]) console.warn('[WARN] falta env:', k); });

/* ================== addReturnEvent ================== */
async function addReturnEvent(args = {}, req) {
  const { returnId, type, title=null, message=null, meta=null, createdBy='system', idempKey=null, q:injectedQ } = args;
  const q = injectedQ || (req && qOf(req)) || query;
  const metaStr = meta != null ? JSON.stringify(meta) : null;
  try {
    const { rows } = await q(
      `INSERT INTO return_events
         (return_id,type,title,message,meta,created_by,created_at,idemp_key)
       VALUES ($1,$2,$3,$4,$5,$6,now(),$7)
       RETURNING id,return_id AS "returnId",type,title,message,meta,
                 created_by AS "createdBy",created_at AS "createdAt",
                 idemp_key AS "idempotencyKey"`,
      [returnId,type,title,message,metaStr,createdBy,idempKey]
    );
    const ev = rows[0]; ev.meta = safeParseJson(ev.meta); return ev;
  } catch (e) {
    if (String(e?.code) === '23505' && idempKey) {
      const { rows } = await q(
        `SELECT id,return_id AS "returnId",type,title,message,meta,
                created_by AS "createdBy",created_at AS "CreatedAt",
                idemp_key AS "idempotencyKey"
           FROM return_events WHERE idemp_key=$1 LIMIT 1`, [idempKey]
      );
      if (rows[0]) { const ev = rows[0]; ev.meta = safeParseJson(ev.meta); return ev; }
    }
    throw e;
  }
}

/* ================== Rotas ================== */
try { app.use(require('./routes/utils')); } catch (e) { console.warn('[BOOT] utils opcional:', e?.message || e); }

/* === NOVAS ROTAS DE RECLAMAÇÕES (messages/attachments/resolutions/evidences) === */
app.use('/api/ml', require('./routes/ml-claims'));

/* === NOVAS ROTAS DE SHIPPING (status, by-order, sync, etc.) === */
try {
  app.use('/api/ml', require('./routes/ml-shipping'));
  console.log('[BOOT] ML Shipping ok');
} catch (e) {
  console.warn('[BOOT] ML Shipping opcional:', e?.message || e);
}

/* Demais módulos */
try {
  const registerCsvUploadExtended = require('./routes/csv-upload-extended');
  registerCsvUploadExtended(app, { addReturnEvent });
  console.log('[BOOT] CSV ok');
} catch (e) { console.warn('[BOOT] CSV opcional:', e?.message || e); }

try {
  const registerCentral = require('./routes/central');
  if (typeof registerCentral === 'function') registerCentral(app);
  console.log('[BOOT] Central ok');
} catch (e) { console.warn('[BOOT] Central opcional:', e?.message || e); }

/* ========= Returns principal (robusto + fallback) ========= */
let __returnsMounted = false;
try {
  const candidates = [
    './routes/returns',
    './routes/returns.js',
    './routes/returns/index.js',
    './routes/Returns',
    './routes/returns-router.js'
  ];
  let mod = null, usedPath = null;
  for (const p of candidates) { try { mod = require(p); usedPath = p; break; } catch {} }
  if (!mod) throw new Error('módulo ./routes/returns não encontrado');

  const isFn = (typeof mod === 'function');
  const isRouterLike = !!mod && (mod.stack || typeof mod.use === 'function' || mod.name === 'router');

  if (isRouterLike) { app.use('/api', mod); app.use('/api/returns', mod); __returnsMounted = true; console.log(`[BOOT] Returns ok (Router) via ${usedPath}`); }
  else if (isFn)    { mod(app); __returnsMounted = true; console.log(`[BOOT] Returns ok (registrador) via ${usedPath}`); }
  else              { throw new Error(`export inválido do módulo (${typeof mod}). Esperado função ou Router`); }
} catch (e) {
  console.warn('[BOOT] Returns falhou (vai usar fallback):', e?.message || e);
}

/** ---- Fallback mínimo (se router NÃO montou) ---- */
if (!__returnsMounted) {
  const fallback = express.Router();
  fallback.get(['/', '/search'], async (req, res) => {
    try {
      const limitQ  = parseInt(req.query.pageSize || req.query.limit || '200', 10);
      const pageQ   = parseInt(req.query.page || '1', 10);
      const limit   = Math.max(1, Math.min(Number.isFinite(limitQ) ? limitQ : 200, 200));
      const page    = Math.max(1, Number.isFinite(pageQ) ? pageQ : 1);
      const offset  = (page - 1) * limit;

      const orderByReq  = String(req.query.orderBy || 'created_at');
      const orderDir    = (String(req.query.orderDir || 'desc').toLowerCase() === 'asc') ? 'asc' : 'desc';
      const rangeDays   = parseInt(req.query.range_days || req.query.rangeDays || '0', 10) || 0;

      const baseCols = ['id','id_venda','cliente_nome','loja_nome','sku','status','log_status','status_operacional','valor_produto','valor_frete','created_at','updated_at'];
      const opt = await tableHasColumns('devolucoes', ['ml_return_status','ml_shipping_status','shipping_status'], req);

      const selectCols = [...baseCols];
      if (opt.ml_return_status)   selectCols.push('ml_return_status');
      if (opt.ml_shipping_status) selectCols.push('ml_shipping_status');
      else if (opt.shipping_status) selectCols.push('shipping_status AS ml_shipping_status');

      const params = [];
      let whereSql = '';
      if (rangeDays > 0) { params.push(String(rangeDays)); whereSql = `WHERE created_at >= now() - ($1 || ' days')::interval`; }

      params.push(limit, offset);
      const { rows } = await query(
        `SELECT ${selectCols.join(', ')}
           FROM devolucoes
          ${whereSql}
          ORDER BY ${orderByReq} ${orderDir} NULLS LAST
          LIMIT $${params.length-1} OFFSET $${params.length}`,
        params
      );
      const { rows: countRows } = await query(`SELECT COUNT(*)::int AS n FROM devolucoes ${whereSql ? 'WHERE created_at >= now() - ($1 || \' days\')::interval' : ''}`, whereSql ? [String(rangeDays)] : []);
      const total = countRows[0]?.n || 0;

      res.json({
        items: rows.map(r => ({
          id: r.id,
          id_venda: r.id_venda,
          cliente_nome: r.cliente_nome,
          loja_nome: r.loja_nome,
          sku: r.sku,
          status: r.status,
          log_status: r.log_status ?? null,
          ml_return_status: r.ml_return_status ?? null,
          ml_shipping_status: r.ml_shipping_status ?? null,
          valor_produto: r.valor_produto,
          valor_frete: r.valor_frete,
          created_at: r.created_at ?? r.updated_at ?? null
        })),
        total,
        page,
        pageSize: limit,
        totalPages: Math.max(1, Math.ceil(total / limit))
      });
    } catch (e) {
      console.error('[returns:fallback] erro:', e);
      res.status(500).json({ error:'Falha ao listar devoluções (fallback)' });
    }
  });
  app.use('/api/returns', fallback);
  console.log('[BOOT] Returns Fallback ON');
}

/* ========= Returns Compat Shim ON (sempre) =========
   Garante /api/returns e /api/returns/search mesmo se o router oficial
   estiver montado mas não tratar a raiz (evita 404). */
{
  const compat = express.Router();
  const listHandler = async (req, res, next) => {
    // Só atende GET raiz; se não for GET, passa
    if (req.method !== 'GET') return next();
    try {
      const limitQ  = parseInt(req.query.pageSize || req.query.limit || '200', 10);
      const pageQ   = parseInt(req.query.page || '1', 10);
      const limit   = Math.max(1, Math.min(Number.isFinite(limitQ) ? limitQ : 200, 200));
      const page    = Math.max(1, Number.isFinite(pageQ) ? pageQ : 1);
      const offset  = (page - 1) * limit;

      const orderByReq  = String(req.query.orderBy || 'created_at');
      const orderDir    = (String(req.query.orderDir || 'desc').toLowerCase() === 'asc') ? 'asc' : 'desc';
      const rangeDays   = parseInt(req.query.range_days || req.query.rangeDays || '0', 10) || 0;

      const baseCols = ['id','id_venda','cliente_nome','loja_nome','sku','status','log_status','status_operacional','valor_produto','valor_frete','created_at','updated_at'];
      const opt = await tableHasColumns('devolucoes', ['ml_return_status','ml_shipping_status','shipping_status'], req);

      const selectCols = [...baseCols];
      if (opt.ml_return_status)   selectCols.push('ml_return_status');
      if (opt.ml_shipping_status) selectCols.push('ml_shipping_status');
      else if (opt.shipping_status) selectCols.push('shipping_status AS ml_shipping_status');

      const params = [];
      let whereSql = '';
      if (rangeDays > 0) { params.push(String(rangeDays)); whereSql = `WHERE created_at >= now() - ($1 || ' days')::interval`; }

      params.push(limit, offset);
      const { rows } = await query(
        `SELECT ${selectCols.join(', ')}
           FROM devolucoes
          ${whereSql}
          ORDER BY ${orderByReq} ${orderDir} NULLS LAST
          LIMIT $${params.length-1} OFFSET $${params.length}`,
        params
      );

      const { rows: countRows } = await query(`SELECT COUNT(*)::int AS n FROM devolucoes ${whereSql ? 'WHERE created_at >= now() - ($1 || \' days\')::interval' : ''}`, whereSql ? [String(rangeDays)] : []);
      const total = countRows[0]?.n || 0;

      return res.json({
        items: rows.map(r => ({
          id: r.id,
          id_venda: r.id_venda,
          cliente_nome: r.cliente_nome,
          loja_nome: r.loja_nome,
          sku: r.sku,
          status: r.status,
          log_status: r.log_status ?? null,
          ml_return_status: r.ml_return_status ?? null,
          ml_shipping_status: r.ml_shipping_status ?? null,
          valor_produto: r.valor_produto,
          valor_frete: r.valor_frete,
          created_at: r.created_at ?? r.updated_at ?? null
        })),
        total,
        page,
        pageSize: limit,
        totalPages: Math.max(1, Math.ceil(total / limit))
      });
    } catch (e) {
      // Se der erro aqui, deixa o router “oficial” tentar
      return next();
    }
  };
  compat.get('/', listHandler);
  compat.get('/search', listHandler);
  app.use('/api/returns', compat);
  console.log('[BOOT] Returns Compat Shim ON');
}

/* ========= Returns LOGS ========= */
try {
  const returnsLogRouter = require('./routes/returns-log');
  app.use('/api/returns', (req, res, next) => {
    if (/^\/\d+\/logs(\/.*)?$/i.test(req.path || '')) return returnsLogRouter(req, res, next);
    return next();
  });
  console.log('[BOOT] Returns Log ok');
} catch (e) {
  console.warn('[BOOT] Returns Log opcional:', e?.message || e);
}

/* ========= Chat por devolução ========= */
try {
  const chatCandidates = [
    './routes/returns-messages',
    './routes/returnsMessages',
    './routes/returns-messages/index.js'
  ];
  let cmod = null, used = null;
  for (const p of chatCandidates) { try { cmod = require(p); used = p; break; } catch {} }
  if (cmod) {
    if (typeof cmod === 'function') cmod(app);
    else { app.use('/api', cmod); app.use('/api/returns', cmod); }
    console.log(`[BOOT] Chat por Devolução ok via ${used}`);
  } else {
    console.warn('[BOOT] Chat por Devolução não encontrado');
  }
} catch (e) { console.warn('[BOOT] Chat por Devolução opcional:', e?.message || e); }

/* Uploads */
try { app.use('/api/uploads', require('./routes/uploads')); console.log('[BOOT] Uploads ok'); }
catch (e) { console.warn('[BOOT] Uploads opcional:', e?.message || e); }

/* Webhook / OAuth / APIs ML */
try { const r = require('./routes/ml-webhook'); if (typeof r === 'function') r(app); console.log('[BOOT] ML webhook ok'); }
catch (e) { console.warn('[BOOT] ML webhook opcional:', e?.message || e); }

try { const r = require('./routes/ml-auth'); if (typeof r === 'function') r(app); console.log('[BOOT] ML OAuth ok'); }
catch (e) { console.warn('[BOOT] ML OAuth opcional:', e?.message || e); }

try { const r = require('./routes/ml-api'); if (typeof r === 'function') r(app); console.log('[BOOT] ML API ok'); }
catch (e) { console.warn('[BOOT] ML API opcional:', e?.message || e); }

try { const r = require('./routes/ml-amounts'); if (typeof r === 'function') r(app); console.log('[BOOT] ML Amounts ok'); }
catch (e) { console.warn('[BOOT] ML Amounts opcional:', e?.message || e); }

try {
  const r = require('./routes/ml-enrich');
  if (typeof r === 'function') (r.length >= 2 ? r(app, { addReturnEvent }) : r(app));
  console.log('[BOOT] ML Enrich ok');
} catch (e) { console.warn('[BOOT] ML Enrich opcional:', e?.message || e); }

/* === ML Chat / Communications (aggregador) === */
try {
  let mlChatRoutes = null;
  try { mlChatRoutes = require('./routes/mlChat.js'); } catch (_) {}
  if (!mlChatRoutes) { try { mlChatRoutes = require('./routes/ml-chat.js'); } catch (_) {} }
  if (mlChatRoutes) {
    app.use('/api/ml', mlChatRoutes);
    console.log('[BOOT] ML Chat/Comms ok (/api/ml/...)');
  } else {
    console.warn('[BOOT] ML Chat não encontrado');
  }
} catch (e) {
  console.warn('[BOOT] ML Chat falhou:', e?.message || e);
}

/* === Importador ML (claims -> devoluções) === */
let _mlSyncRegistered = false;
try {
  const registerMlSync = require('./routes/ml-sync'); // /api/ml/claims/import
  if (typeof registerMlSync === 'function') {
    registerMlSync(app, { addReturnEvent });
    _mlSyncRegistered = true;
    console.log('[BOOT] ML Sync ok');
  }
} catch (e) { console.warn('[BOOT] ML Sync opcional:', e?.message || e); }

/* === ML RETURNS (router + agendador) === */
try {
  const mlReturnsMod = require('./routes/ml-returns');
  const isRouter = !!mlReturnsMod && (typeof mlReturnsMod === 'function') &&
                   (mlReturnsMod.stack || typeof mlReturnsMod.use === 'function' || mlReturnsMod.name === 'router');

  if (isRouter) app.use('/api/ml', mlReturnsMod);
  else if (typeof mlReturnsMod === 'function') mlReturnsMod(app);
  else { console.warn('[BOOT] ml-returns export inesperado'); app.use('/api/ml', mlReturnsMod); }

  if (mlReturnsMod && typeof mlReturnsMod.scheduleMlReturnsSync === 'function') {
    mlReturnsMod.scheduleMlReturnsSync(app);
    console.log('[BOOT] ML Returns agendador ON');
  }
  console.log('[BOOT] ML Returns ok');
} catch (e) {
  console.warn('[BOOT] ML Returns opcional:', e?.message || e);
}

/* === Extras que não conflitam com /api/returns === */
try { app.use('/api/ml', require('./routes/ml-reenrich')); console.log('[BOOT] ML Re-enrich ok'); }
catch (e) { console.warn('[BOOT] ML Re-enrich opcional:', e?.message || e); }

try { app.use('/api/dashboard', require('./routes/dashboard')); console.log('[BOOT] Dashboard ok'); }
catch (e) { console.warn('[BOOT] Dashboard opcional:', e?.message || e); }

/* ================== Health extra & debug ================== */
app.get('/api/db/ping', async (req, res) => {
  try { const r = await qOf(req)('select now() as now'); res.json({ ok:true, now:r.rows[0].now }); }
  catch (e) { res.status(500).json({ ok:false, error:String(e) }); }
});

app.get('/api/_debug/routes', (_req, res) => {
  const acc = [];
  const dump = (stack, base='') => {
    stack?.forEach(layer => {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods || {}).filter(m => layer.route.methods[m]);
        acc.push({ path: base + layer.route.path, methods });
      } else if (layer.name === 'router' && layer.handle?.stack) {
        dump(layer.handle.stack, base);
      }
    });
  };
  dump(app._router?.stack, '');
  res.json(acc);
});

app.get('/api/_debug/tenant', async (req, res) => {
  try {
    const q = qOf(req);
    const r = await q(`SELECT current_setting('app.tenant_id',true) AS tenant_id,
                              current_setting('app.tenant_slug',true) AS tenant_slug`);
    const { rows } = await q('SELECT COUNT(*)::int AS n FROM devolucoes');
    res.json({ ...r.rows[0], devolucoes_visiveis: rows[0]?.n || 0 });
  } catch (e) {
    res.status(500).json({ error:String(e?.message||e) });
  }
});

/* ================== 404 /api (sempre por último!) ================== */
app.use('/api', (req, res) => res.status(404).json({ error:'Not found' }));

/* ================== Error handler ================== */
app.use((err, req, res, _next) => {
  console.error('[API ERROR]', err);
  const reveal = String(process.env.REVEAL_ERRORS ?? 'false').toLowerCase() === 'true';
  const msg = reveal ? (err?.detail || err?.message || String(err)) : 'Erro interno';
  if (req.path?.startsWith('/api')) res.status(500).json({ error: msg });
  else res.status(500).send('Erro interno');
});

/* ================== START ================== */
const port = process.env.PORT || 3000;
const host = '0.0.0.0';
const server = app.listen(port, host, () => {
  console.log(`[BOOT] Server listening on http://${host}:${port}`);
  setupMlAutoSync();
  setupMlAutoRefresh();
});

/* ================== ML AutoSync ================== */
let _mlAuto_lastRun = null;
function setupMlAutoSync() {
  // ... (mesma implementação que te enviei)
}

/* ================== ML AutoRefresh de Tokens ================== */
let _mlRefresh_lastRun = null;
function setupMlAutoRefresh() {
  // ... (mesma implementação que te enviei)
}

process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));
process.on('uncaughtException',  err => console.error('[uncaughtException]', err));

module.exports = app;
