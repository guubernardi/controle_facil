'use strict';

/**
 * -------------------------------------------------------------
 *  Retorno Fácil – Servidor HTTP (Express)
 * -------------------------------------------------------------
 */

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
const { query } = require('./db');
const events = require('./events');

const app = express();

/** Middlewares globais */
app.use(express.json({ limit: '1mb' }));

// Tratador de JSON inválido (evita 500)
app.use((err, _req, res, next) => {
  if (err?.type === 'entity.parse.failed' || (err instanceof SyntaxError && 'body' in err)) {
    return res.status(400).json({ ok: false, error: 'invalid_json' });
  }
  next(err);
});

/** Static */
app.use(express.static(path.join(__dirname, '..', 'public')));

// rota SSE
app.get('/events', events.sse);

/** JSON UTF-8 nas rotas /api */
app.use('/api', (_req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  next();
});

/** Rotas utilitárias */
try {
  const utilsRoutes = require('./routes/utils');
  app.use(utilsRoutes);
  console.log('[BOOT] Rotas /utils carregadas');
} catch (e) {
  console.warn('[BOOT] Falha ao carregar rotas /utils:', e?.message || e);
}

/* ===========================
 *  CHECK DE VARIÁVEIS (aviso)
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

/* Helpers compartilhados */
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

/**
 * addReturnEvent (idempotente)
 */
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

/* ========= ROTAS CSV ========= */
try {
  const registerCsvUploadExtended = require('./routes/csv-upload-extended');
  registerCsvUploadExtended(app, { addReturnEvent }); // injeta addReturnEvent
  console.log('[BOOT] Rotas CSV carregadas');
} catch (e) {
  console.warn('[BOOT] Falha ao carregar rotas CSV:', e?.message || e);
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

/* ========= OAuth Mercado Livre =========
   Tentamos vários caminhos. Se nada existir, criamos
   um fallback mínimo de /auth/ml/login e /auth/ml/callback
======================================== */
let mlAuthRegistered = false;
const tryRegister = (p) => {
  try {
    const mod = require(p);
    if (typeof mod === 'function') {
      mod(app);
      console.log('[BOOT] Rotas ML OAuth carregadas de', p);
      mlAuthRegistered = true;
    }
  } catch (_) { /* ignore */ }
};
tryRegister('./routes/ml-auth');   // server/routes/ml-auth.js
tryRegister('./ml-auth');          // server/ml-auth.js
tryRegister('../ml-auth');         // raiz/ml-auth.js

if (!mlAuthRegistered) {
  console.warn('[BOOT] Rotas ML OAuth não encontradas — usando fallback mínimo.');

  // Alias compatível com links antigos
  app.get('/integrations/mercadolivre/connect', (_req, res) => res.redirect('/auth/ml/login'));

  // Fallback: monta a URL de autorização e redireciona
  app.get('/auth/ml/login', (req, res) => {
    const clientId = process.env.ML_CLIENT_ID;
    const baseAuth = 'https://auth.mercadolivre.com.br/authorization';
    if (!clientId) return res.status(500).send('ML_CLIENT_ID não configurado');

    const redirectUri =
      process.env.ML_REDIRECT_URI ||
      `${req.protocol}://${req.get('host')}/auth/ml/callback`;

    // um state simples só pra teste/local
    const state = Buffer.from(JSON.stringify({ t: Date.now() })).toString('base64url');

    const url = `${baseAuth}?response_type=code` +
      `&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${encodeURIComponent(state)}`;

    res.redirect(url);
  });

  // Fallback de callback — apenas ecoa o código; o handler real pode vir depois
  app.get('/auth/ml/callback', (req, res) => {
    const { code, state, error, error_description } = req.query || {};
    if (error) {
      return res.status(400).send(`Erro do ML: ${error} - ${error_description || ''}`);
    }
    res
      .status(200)
      .send(
        `<pre>OK (fallback)\ncode=${code}\nstate=${state}\n\n` +
        `Configure ./routes/ml-auth.js para trocar o code por tokens.</pre>`
      );
  });
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
 *  Dashboard & Home (mesmo que antes)
 * ------------------------------------------------------------ */
// ... (mantive exatamente seus handlers de /api/dashboard, /api/home/kpis,
//     /api/home/pending, /api/home/announcements sem alterações; para
//     economizar espaço, você pode manter os seus originais aqui.)
// === Início bloco original ===
/* (cole aqui exatamente os handlers /api/dashboard, /api/home/kpis, 
   /api/home/pending e /api/home/announcements do seu arquivo atual,
   pois não mudaram) */
// === Fim bloco original ===

/* ===========================
 *  START
 * =========================== */
const port = process.env.PORT || 3000;
const host = '0.0.0.0';

const server = app.listen(port, host, () => {
  console.log(`[BOOT] Server listening on http://${host}:${port}`);
});

/* ===========================
 *  ERROS NÃO TRATADOS
 * =========================== */
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));
process.on('uncaughtException',  err => console.error('[uncaughtException]', err));

module.exports = app;
