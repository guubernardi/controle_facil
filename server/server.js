// server/server.js
'use strict';

/**
 * -------------------------------------------------------------
 *  Retorno Fácil – Servidor HTTP (Express)
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
      'x-seller-token','x-owner','x-seller-id','Authorization'
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
  const isJob = orig.startsWith('/api/ml/claims/import') && jobHeader && jobToken && jobHeader === jobToken;
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
                created_by AS "createdBy",created_at AS "createdAt",
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
app.use('/api/ml', require('./routes/ml-claims')); // <= AQUI

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

try { const r = require('./routes/returns'); if (typeof r === 'function') r(app); console.log('[BOOT] Returns ok'); }
catch (e) { console.warn('[BOOT] Returns opcional:', e?.message || e); }

try {
  const r = require('./routes/returns-messages');
  if (typeof r === 'function') r(app); else app.use('/api', r);
  console.log('[BOOT] Chat por Devolução ok');
} catch (e) { console.warn('[BOOT] Chat por Devolução opcional:', e?.message || e); }

try { app.use('/api/uploads', require('./routes/uploads')); console.log('[BOOT] Uploads ok'); }
catch (e) { console.warn('[BOOT] Uploads opcional:', e?.message || e); }

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
    console.warn('[BOOT] ML Chat não encontrado (routes/mlChat.js ou routes/ml-chat.js)');
  }
} catch (e) {
  console.warn('[BOOT] ML Chat falhou:', e?.message || e);
}

/* === Importador ML (claims -> devoluções) === */
let _mlSyncRegistered = false;
try {
  const registerMlSync = require('./routes/ml-sync'); // expõe /api/ml/claims/import
  if (typeof registerMlSync === 'function') {
    registerMlSync(app, { addReturnEvent });
    _mlSyncRegistered = true;
    console.log('[BOOT] ML Sync ok (/api/ml/claims/import)');
  }
} catch (e) { console.warn('[BOOT] ML Sync opcional:', e?.message || e); }

/* === Rotas auxiliares === */
try { app.use('/api/returns', require('./routes/returns-log')); console.log('[BOOT] Returns Log ok'); }
catch (e) { console.warn('[BOOT] Returns Log opcional:', e?.message || e); }

try { app.use('/api/ml', require('./routes/ml-reenrich')); console.log('[BOOT] ML Re-enrich ok'); }
catch (e) { console.warn('[BOOT] ML Re-enrich opcional:', e?.message || e); }

try { app.use('/api/dashboard', require('./routes/dashboard')); console.log('[BOOT] Dashboard ok'); }
catch (e) { console.warn('[BOOT] Dashboard opcional:', e?.message || e); }

/* ================== Health extra & debug ================== */
app.get('/api/db/ping', async (req, res) => {
  try { const r = await qOf(req)('select now() as now'); res.json({ ok:true, now:r.rows[0].now }); }
  catch (e) { res.status(500).json({ ok:false, error:String(e) }); }
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
});

/* ================== ML AutoSync ================== */
let _mlAuto_lastRun = null; // exposto em /api/ml/claims/last-run
function setupMlAutoSync() {
  if (!_mlSyncRegistered) {
    console.warn('[ML AUTO] Importador ML não registrado; AutoSync off.');
    return;
  }
  const enabled = String(process.env.ML_AUTO_SYNC_ENABLED ?? 'true').toLowerCase() === 'true';
  if (!enabled) { console.log('[ML AUTO] Desabilitado por env'); return; }

  const intervalMs = Math.max(60_000, parseInt(process.env.ML_AUTO_SYNC_INTERVAL_MS || '600000',10) || 600_000);
  const windowDays = Math.max(1, parseInt(process.env.ML_AUTO_SYNC_WINDOW_DAYS || '14',10) || 14);
  const runOnStart = String(process.env.ML_AUTO_SYNC_ON_START ?? 'true').toLowerCase() === 'true';
  const jobToken   = process.env.JOB_TOKEN || process.env.ML_JOB_TOKEN || 'dev-job';

  let running = false;
  const run = async (reason='timer') => {
    if (running) return; running = true;
    const t0 = Date.now();
    const url = `http://127.0.0.1:${port}/api/ml/claims/import?days=${encodeURIComponent(windowDays)}&silent=1`;
    try {
      const r = await fetch(url, { headers: { 'x-job-token': jobToken } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || r.statusText || 'Falha no import');
      _mlAuto_lastRun = { when:new Date().toISOString(), reason, ok:true, tookMs:Date.now()-t0, result:j };
      console.log(`[ML AUTO] Import OK (${reason}) em ${_mlAuto_lastRun.tookMs}ms`);
    } catch (e) {
      _mlAuto_lastRun = { when:new Date().toISOString(), reason, ok:false, tookMs:Date.now()-t0, error:String(e?.message||e) };
      console.error('[ML AUTO] Falha no import:', _mlAuto_lastRun.error);
    } finally { running = false; }
  };

  if (runOnStart) setTimeout(() => run('boot'), 2000);
  const handle = setInterval(run, intervalMs);
  process.on('SIGINT',  () => clearInterval(handle));
  process.on('SIGTERM', () => clearInterval(handle));

  app.get('/api/ml/claims/last-run', (_req, res) => {
    res.json({ enabled, intervalMs, windowDays, runOnStart, registered: _mlSyncRegistered, lastRun:_mlAuto_lastRun });
  });

  console.log(`[BOOT] ML AutoSync ON: intervalo=${intervalMs}ms, janela=${windowDays}d`);
}

/* ================== Unhandled ================== */
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));
process.on('uncaughtException',  err => console.error('[uncaughtException]', err));

module.exports = app;
