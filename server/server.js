// server/server.js
'use strict';

/**
 * -------------------------------------------------------------
 * Controle Facil – Servidor HTTP (Express)
 * -------------------------------------------------------------
 */

// [MELHORIA] Verificação de variáveis de ambiente em dev
try {
  if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config({ override: true });
    console.log('✅ [BOOT] dotenv carregado (.env)');
  }
} catch (_) {
  console.log('ℹ️ [BOOT] dotenv não carregado (produção)');
}

const express    = require('express');
const path       = require('path');
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const session    = require('express-session');
const ConnectPg  = require('connect-pg-simple')(session);

// [CORREÇÃO] Import do DB na mesma pasta (./)
const { query }  = require('./db'); 

// [NOVO] Import do Worker de Background (certifique-se que o arquivo existe em services/)
const MlWorker   = require('./services/mlWorker');

const app = express();
app.disable('x-powered-by');

// [MELHORIA] Validação de variáveis críticas
const REQUIRED_ENVS = ['DATABASE_URL', 'ML_CLIENT_ID', 'ML_CLIENT_SECRET'];
const missingEnvs = REQUIRED_ENVS.filter(k => !process.env[k]);
if (missingEnvs.length > 0) {
  console.error(`❌ [BOOT] Faltam variáveis de ambiente: ${missingEnvs.join(', ')}`);
}

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
    allowedHeaders: ['Content-Type','Accept','Idempotency-Key','x-job-token','x-seller-token','Authorization']
  }));
}

/* ================== Parsers ================== */
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((err, _req, res, next) => {
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ ok:false, error:'invalid_json_payload' });
  }
  next(err);
});

/* ================== Sessão ================== */
app.set('trust proxy', 1);
const sessCookie = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 12 * 60 * 60 * 1000 // 12h
};

app.use(session({
  store: new ConnectPg({
    conString: process.env.DATABASE_URL,
    createTableIfMissing: true,
    tableName: 'session'
  }),
  name: process.env.SESSION_NAME || 'cf.sid',
  secret: process.env.SESSION_SECRET || 'dev-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: sessCookie
}));

/* ================== Middlewares Globais ================== */
app.use('/api', (_req, res, next) => {
  const originalJson = res.json;
  res.json = function (body) {
    if (!res.get('Content-Type')) res.set('Content-Type', 'application/json; charset=utf-8');
    return originalJson.call(this, body);
  };
  next();
});

// Tenant Fallback
app.use('/api', (req, _res, next) => {
  if (req.session?.user) {
    req.tenant = req.tenant || {};
    if (!req.tenant.id && req.session.user.tenant_id) {
      req.tenant.id = req.session.user.tenant_id;
    }
  }
  next();
});

/* ================== Rotas Públicas e Auth ================== */
app.get('/api/health', (_req, res) => res.json({ ok: true, status: 'online', time: new Date() }));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (r) => r.ip
});
app.use('/api/auth/login', loginLimiter);

app.use('/api/auth', require('./routes/auth'));
try { require('./routes/auth-register')(app); } catch {}

app.get('/api/auth/me', (req, res) => {
  const u = req.session?.user;
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  res.json({ id: u.id, nome: u.nome, email: u.email, roles: u.roles || [] });
});

/* ================== Guard (Proteção /api) ================== */
app.use('/api', (req, res, next) => {
  const path = req.path.toLowerCase();
  if (path === '/health' || path.startsWith('/auth/')) return next();

  const jobHeader = req.get('x-job-token');
  const envToken  = process.env.JOB_TOKEN || process.env.ML_JOB_TOKEN;
  
  // Permite acesso se for o Worker local com token correto
  if (jobHeader && envToken && jobHeader === envToken) return next();

  if (req.session?.user) return next();

  return res.status(401).json({ error: 'Acesso negado' });
});

/* ================== Rotas Core ================== */
app.use('/api/ml', require('./routes/ml-claims'));   
app.use('/api/returns', require('./routes/returns')); 

// Rotas Opcionais
try { app.use('/api/ml', require('./routes/ml-shipping')); } catch (e) { console.warn('⚠️ [MOD] ML Shipping off'); }
try { app.use('/api/dashboard', require('./routes/dashboard')); } catch (e) { console.warn('⚠️ [MOD] Dashboard off'); }
try { app.use('/api/uploads', require('./routes/uploads')); } catch (e) { console.warn('⚠️ [MOD] Uploads off'); }
try { app.use('/api/ml', require('./routes/ml-chat')); } catch (e) { console.warn('⚠️ [MOD] ML Chat off'); }

try {
  require('./routes/csv-upload-extended')(app, { 
    addReturnEvent: require('./events').addReturnEvent || (async () => {}) 
  });
} catch {}

/* ================== Static & SPA ================== */
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/', (req, res) => {
  res.redirect(req.session?.user ? '/home.html' : '/login.html');
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint não encontrado' }));

app.use((err, req, res, _next) => {
  console.error('🔥 [SERVER ERROR]', err);
  const msg = process.env.NODE_ENV === 'production' ? 'Erro interno do servidor' : (err.message || String(err));
  if (!res.headersSent) res.status(500).json({ error: msg });
});

/* ================== Inicialização ================== */
const port = process.env.PORT || 3000;
const host = '0.0.0.0';

const server = app.listen(port, host, () => {
  console.log(`🚀 [BOOT] Servidor rodando em http://${host}:${port}`);
  
  // [CORREÇÃO] Inicia o Worker separado passando a porta
  try {
    MlWorker.start(port);
  } catch (e) {
    console.error('❌ Falha ao iniciar Workers:', e.message);
  }
});

module.exports = app;