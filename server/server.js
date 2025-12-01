// server/server.js
'use strict';

/**
 * -------------------------------------------------------------
 * Controle Facil – Servidor HTTP (Express)
 * -------------------------------------------------------------
 */

// Polyfill de fetch p/ Node < 18
if (typeof fetch !== 'function') {
  global.fetch = (...args) => import('node-fetch').then(m => m.default(...args));
}

// [BOOT] Verificação de variáveis de ambiente em dev
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

// [IMPORTANTE] Import do DB na mesma pasta (./)
const { query }  = require('./db');

// [IMPORTANTE] Import do Worker (deve estar em server/services/mlWorker.js)
const MlWorker   = require('./services/mlWorker');

const app = express();
app.disable('x-powered-by');

// Validação de variáveis críticas
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
    allowedHeaders: [
      'Content-Type',
      'Accept',
      'Idempotency-Key',
      'x-job-token',
      'x-seller-token',
      'x-owner',
      'x-seller-id',
      'x-seller-nick',
      'Authorization'
    ]
  }));
}

/* ================== Parsers ================== */
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// Tratador de JSON malformado
app.use((err, _req, res, next) => {
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ ok: false, error: 'invalid_json_payload' });
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
// Garante JSON sempre com charset
app.use('/api', (_req, res, next) => {
  const originalJson = res.json;
  res.json = function (body) {
    if (!res.get('Content-Type')) {
      res.set('Content-Type', 'application/json; charset=utf-8');
    }
    return originalJson.call(this, body);
  };
  next();
});

// Tenant Fallback simples
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
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, status: 'online', time: new Date() });
});

// Status do ML (Rota fantasma para compatibilidade antiga)
app.get('/api/ml/status', (_req, res) => {
  res.json({ ok: true, status: 'connected', timestamp: new Date() });
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (r) => r.ip
});
app.use('/api/auth/login', loginLimiter);

// --- ROTAS DE AUTENTICAÇÃO ---
app.use('/api/auth', require('./routes/auth'));

// Rotas de OAuth do Mercado Livre
try {
  app.use('/api/auth', require('./routes/ml-auth'));
  console.log('✅ [BOOT] Rotas ML Auth carregadas (/api/auth/ml/...)');
} catch (e) {
  console.error('❌ [BOOT] Falha ao carregar ml-auth:', e.message);
}

// Registro opcional extra de auth (por ex. convite, registro público)
try {
  require('./routes/auth-register')(app);
} catch {}

// Quem sou eu
app.get('/api/auth/me', (req, res) => {
  const u = req.session?.user;
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  res.json({ id: u.id, nome: u.nome, email: u.email, roles: u.roles || [] });
});

/* ================== Guard (Proteção /api) ================== */
app.use('/api', (req, res, next) => {
  const path = String(req.path || '').toLowerCase();

  // Permite /health, /auth/* (incluindo /auth/ml/login) e /ml/status
  if (path === '/health' || path.startsWith('/auth/') || path === '/ml/status') {
    return next();
  }

  const jobHeader = req.get('x-job-token');
  const envToken  = process.env.JOB_TOKEN || process.env.ML_JOB_TOKEN || 'dev-job';

  // Permite acesso se for o Worker local com token correto
  if (jobHeader && jobHeader === envToken) {
    return next();
  }

  if (req.session?.user) {
    return next();
  }

  return res.status(401).json({ error: 'Acesso negado' });
});

/* ================== Rotas Core ================== */
// Reclamações / devoluções via Claims (proxy ML)
app.use('/api/ml', require('./routes/ml-claims'));

// Devoluções internas (tabela devolucoes)
app.use('/api/returns', require('./routes/returns'));

// ML Sync (importa claims/returns para a tabela devolucoes)
try {
  const registerMlSync = require('./routes/ml-sync');
  const events = require('./events');
  const addReturnEvent = events.addReturnEvent || (async () => {});

  // lista de contas do ML para o ml-sync (multi-conta)
  const listMlAccounts = async (req) => {
    const { rows } = await query(`
      SELECT user_id, nickname, access_token, expires_at
        FROM ml_tokens
       WHERE access_token IS NOT NULL
         AND access_token <> ''
       ORDER BY updated_at DESC
    `);

    const makeHttp = (token) => ({
      // interface compatível com axios.get: http.get(path, { params })
      get: async (path, opts = {}) => {
        const base = 'https://api.mercadolibre.com';
        const url = new URL(base + path);
        const params = opts.params || {};
        for (const [k, v] of Object.entries(params)) {
          if (v === undefined || v === null || v === '') continue;
          url.searchParams.set(k, String(v));
        }

        const resp = await fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        });

        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          const err = new Error(`ML HTTP ${resp.status}`);
          err.status = resp.status;
          err.body = body;
          throw err;
        }

        const data = await resp.json().catch(() => ({}));
        return { data };
      }
    });

    return rows.map((row) => ({
      http: makeHttp(row.access_token),
      account: {
        user_id: row.user_id,
        nickname: row.nickname || `Conta ${row.user_id}`,
        site_id: 'MLB',
        expires_at: row.expires_at
      }
    }));
  };

  registerMlSync(app, { addReturnEvent, listMlAccounts });
  console.log('✅ [BOOT] ML Sync carregado (/api/ml/claims/import)');
} catch (e) {
  console.warn('⚠️ [BOOT] ML Sync não carregado:', e.message || e);
}

// ML Enrich (enriquecer devolução específica com dados do ML)
try {
  const registerMlEnrich = require('./routes/ml-enrich');
  registerMlEnrich(app);
  console.log('✅ [BOOT] ML Enrich carregado (/api/ml/returns/:id/enrich)');
} catch (e) {
  console.warn('⚠️ [BOOT] ML Enrich não carregado:', e.message || e);
}

// Rotas Opcionais
try { app.use('/api/ml', require('./routes/ml-shipping')); } catch (e) { console.warn('⚠️ [MOD] ML Shipping off:', e.message || e); }
try { app.use('/api/dashboard', require('./routes/dashboard')); } catch (e) { console.warn('⚠️ [MOD] Dashboard off:', e.message || e); }
try { app.use('/api/uploads', require('./routes/uploads')); } catch (e) { console.warn('⚠️ [MOD] Uploads off:', e.message || e); }
try { app.use('/api/ml', require('./routes/ml-chat')); } catch (e) { console.warn('⚠️ [MOD] ML Chat off:', e.message || e); }

try {
  const events = require('./events');
  const addReturnEvent = events.addReturnEvent || (async () => {});
  require('./routes/csv-upload-extended')(app, { addReturnEvent });
} catch {}

/* ================== Static & SPA ================== */
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/', (req, res) => {
  res.redirect(req.session?.user ? '/home.html' : '/login.html');
});

// 404 para qualquer /api que não casou antes
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Endpoint não encontrado' });
});

// Handler de erro final
app.use((err, _req, res, _next) => {
  console.error('🔥 [SERVER ERROR]', err);
  const msg = process.env.NODE_ENV === 'production'
    ? 'Erro interno do servidor'
    : (err.message || String(err));
  if (!res.headersSent) {
    res.status(500).json({ error: msg });
  }
});

/* ================== Inicialização ================== */
const port = process.env.PORT || 3000;
const host = '0.0.0.0';

const server = app.listen(port, host, () => {
  console.log(`🚀 [BOOT] Servidor rodando em http://${host}:${port}`);

  try {
    MlWorker.start(port);
  } catch (e) {
    console.error('❌ Falha ao iniciar Workers:', e.message);
  }
});

// Logs de erros não tratados no processo
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});
process.on('uncaughtException',  (err) => {
  console.error('[uncaughtException]', err);
});

module.exports = app;
