'use strict';

/**
 * Server HTTP (Express) do Retorno Fácil
 * 
 * Organização:
 * - Este arquivo sobe o app, configura middlewares globais, helpers, OAuth do Bling,
 *   endpoints de KPIs, pendências, log de custos e proxies utilitários.
 * - A **importação e conciliação de CSV do Mercado Livre** foi extraída para
 *   `./routes/csv-upload.js`, registrada por injeção de dependência (para podermos
 *   reutilizar a função de eventos com idempotência).
 *
 * Por que extrair o CSV para um módulo?
 * - Evita import circular (server ⇄ csv).
 * - Mantém a rota autocontida (faz seu próprio body-parser de texto).
 * - Fica claro para qualquer dev que toda a lógica de CSV está em um único lugar.
 */

require('dotenv').config();

const express = require('express');
const path = require('path');
const axios = require('axios');
const dayjs = require('dayjs');
const { query } = require('./db');

const app = express();

/** 
 * Middlewares globais
 * - Limitamos JSON para 1MB para evitar payloads acidentais gigantes.
 * - O body-parser de **texto** do CSV NÃO fica aqui; ele é configurado
 *   dentro do módulo `routes/csv-upload.js`, para não haver conflito.
 */
app.use(express.json({ limit: '1mb' }));

/** 
 * Servimos a pasta /public (HTML/CSS/JS do frontend).
 * Estrutura típica:
 *   /public
 *     /css
 *     /js
 *     *.html
 */
app.use(express.static(path.join(__dirname, '..', 'public')));

/**
 * Todas as rotas /api retornam JSON UTF-8 explícito.
 * (evita charset default diferente em alguns clientes)
 */
app.use('/api', (req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  next();
});

/**
 * Aviso se variáveis .env importantes estiverem faltando.
 */
[
  'BLING_AUTHORIZE_URL',
  'BLING_TOKEN_URL',
  'BLING_API_BASE',
  'BLING_CLIENT_ID',
  'BLING_CLIENT_SECRET',
  'BLING_REDIRECT_URI',
  'DATABASE_URL'
].forEach(k => {
  if (!process.env[k]) console.warn(`[WARN] .env faltando ${k}`);
});

/*  Helpers/utilitários compartilhados  */

/** Parse seguro de JSON em string (não explode). */
function seguroParseJson(s) {
  if (s == null) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(String(s)); } catch { return null; }
}
const safeParseJson = seguroParseJson; // alias

/** Lê um header Idempotency-Key (se usarmos futuramente em outras rotas). */
function pegarChaveIdempotencia(req) {
  const v = (req.get('Idempotency-Key') || '').trim();
  return v || null;
}
const getIdempKey = pegarChaveIdempotencia; // alias

/** Normaliza corpo de evento aceitando PT/EN (mantido para compat). */
function normalizarCorpoEvento(body = {}) {
  const typeRaw = body.type ?? body.tipo;
  const type = typeof typeRaw === 'string' ? typeRaw.toLowerCase() : undefined;

  const title =
    body.title ??
    body.titulo ??
    null;

  const message =
    body.message ??
    body.mensagem ??
    null;

  // meta pode vir como objeto ou string JSON
  let meta = body.meta ?? body.metadados ?? body.dados ?? null;
  if (typeof meta === 'string') {
    const parsed = seguroParseJson(meta);
    if (parsed !== null) meta = parsed;
  }

  const created_by =
    body.created_by ??
    body.criado_por ??
    body.usuario ??
    'system';

  return { type, title, message, meta, created_by };
}
const normalizeEventBody = normalizarCorpoEvento; // alias

/**
 * addReturnEvent (com idempotência)
 * - É a função oficial de registro de eventos (auditoria) de uma devolução.
 * - O módulo de CSV usa **esta** função por injeção de dependência, garantindo:
 *   - formato único de eventos;
 *   - idempotência via `idemp_key` (evita duplicidade em reenvios).
 */
async function adicionarEventoDevolucao({
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
    ev.meta = seguroParseJson(ev.meta);
    return ev;
  } catch (e) {
    // 23505 = unique_violation (índice único parcial em idemp_key)
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
        ev.meta = seguroParseJson(ev.meta);
        return ev;
      }
    }
    throw e;
  }
}
const addReturnEvent = adicionarEventoDevolucao; // alias

/* Verifica existência de colunas numa tabela (ajuda a ser resiliente a migrações). */
async function tabelaTemColunas(table, columns) {
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
const tableHasColumns = tabelaTemColunas; // alias

/** Utils de número/string, tolerantes a BR (1.234,56). */
function paraNumero(v, def = 0) {
  if (v == null || v === '') return def;
  const n = Number(String(v).replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : def;
}
function str(v) { return v == null ? '' : String(v); }

/*   Rotas de CSV (Mercado Livre pós-venda) */
/**
 * Importante:
 * - NÃO iplementei aqui a rota /api/csv/upload nem body-parser de texto.
 * - Tudo isso vive no módulo abaixo. Ele já faz:
 *   - parse heurístico do CSV,
 *   - normalização de cabeçalhos,
 *   - conciliação em `devolucoes`,
 *   - auditoria de import (quando não é dry-run),
 *   - e aceita `?dry=1` para simulação (dry-run).
 */
const registrarRotasCsv = require('./routes/csv-upload');
registrarRotasCsv(app, { addReturnEvent });

/*   Health / DB  */
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

/*  HOME (KPIs / Pendências / Avisos / Integrações)  */
app.get('/api/home/kpis', async (req, res) => {
  try {
    const { from, to } = req.query;
    const where = [];
    const params = [];
    if (from) { params.push(from); where.push(`created_at >= $${params.length}`); }
    if (to)   { params.push(to);   where.push(`created_at <  $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const cols = await tabelaTemColunas('devolucoes', ['conciliado_em']);
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
    const cols = await tabelaTemColunas('devolucoes', ['log_status','cd_inspecionado_em','conciliado_em']);
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
    // Bling OK se houver token salvo
    const q = await query(`select count(*)::int as n from bling_accounts`);
    const blingOk = (q.rows[0]?.n || 0) > 0;
    // Mercado Livre ainda sem OAuth: usar CSV
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

/*  Log de custos (view/tabela agregada) */
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

    if (status) {
      params.push(String(status).toLowerCase());
      where.push(`LOWER(status) = $${params.length}`);
    }
    if (log_status) {
      params.push(String(log_status).toLowerCase());
      where.push(`LOWER(log_status) = $${params.length}`);
    }
    if (responsavel) {
      params.push(String(responsavel).toLowerCase());
      where.push(`LOWER(responsavel_custo) = $${params.length}`);
    }
    if (loja) {
      params.push(`%${loja}%`);
      where.push(`loja_nome ILIKE $${params.length}`);
    }
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

    const hasCols = await tabelaTemColunas('v_return_cost_log', ['return_id','log_status','total','event_at']);
    const usarViewComReturnId = hasCols.return_id === true;

    let sqlItems, sqlCount, sqlSum, paramsItems, paramsCount;

    if (usarViewComReturnId) {
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

/*   Bling: OAuth + helpers HTTP  */
function cabecalhoBasicAuth() {
  const cru = `${process.env.BLING_CLIENT_ID}:${process.env.BLING_CLIENT_SECRET}`;
  const base64 = Buffer.from(cru).toString('base64');
  return `Basic ${base64}`;
}

async function salvarTokens({ apelido, access_token, refresh_token, expires_in }) {
  const expires_at = dayjs().add(expires_in, 'second').toDate();
  const sql = `
    insert into bling_accounts (apelido, access_token, refresh_token, expires_at)
    values ($1, $2, $3, $4)
    returning id, apelido, expires_at
  `;
  const { rows } = await query(sql, [apelido, access_token, refresh_token, expires_at]);
  return rows[0];
}

async function getAccessTokenValido(apelido) {
  const { rows } = await query(
    `select id, access_token, refresh_token, expires_at
       from bling_accounts
      where apelido=$1
      order by id desc
      limit 1`,
    [apelido]
  );
  if (!rows[0]) throw new Error('Nenhum token encontrado. Autorize a conta primeiro.');

  const t = rows[0];
  const expiraMs = new Date(t.expires_at).getTime() - Date.now();
  const margemMs = 120 * 1000;

  if (expiraMs > margemMs) return t.access_token;
  return await refreshAccessToken(apelido, t.refresh_token);
}

async function refreshAccessToken(apelido, refresh_token) {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token });
  const { data } = await axios.post(process.env.BLING_TOKEN_URL, body.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': '1.0',
      'Authorization': cabecalhoBasicAuth()
    },
    timeout: 15000
  });

  await salvarTokens({
    apelido,
    access_token: data.access_token,
    refresh_token: data.refresh_token || refresh_token,
    expires_in: data.expires_in
  });

  return data.access_token;
}

async function blingGet(apelido, url) {
  let token = await getAccessTokenValido(apelido);

  const doGet = (tok) =>
    axios.get(url, {
      headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json' },
      timeout: 15000
    });

  try {
    const r = await doGet(token);
    return r.data;
  } catch (e) {
    const st  = e?.response?.status;
    const msg = e?.response?.data;
    const precisaRefresh = st === 401 || (msg && String(msg).includes('invalid_token'));
    if (!precisaRefresh) throw e;

    const rtk = await query(
      `select refresh_token from bling_accounts 
        where apelido=$1 order by id desc limit 1`,
      [apelido]
    );
    if (!rtk.rows[0]?.refresh_token) throw e;

    token = await refreshAccessToken(apelido, rtk.rows[0].refresh_token);
    const r2 = await doGet(token);
    return r2.data;
  }
}

/*   Loja helpers (cache + heurística)  */
async function pegarNomeLojaPorId(apelido, lojaId) {
  if (lojaId === null || lojaId === undefined) return null;

  const cache = await query('select nome from lojas_bling where id = $1', [lojaId]);
  if (cache.rows[0]?.nome) return cache.rows[0].nome;

  const base = process.env.BLING_API_BASE;

  try {
    const data = await blingGet(apelido, `${base}/lojas/${encodeURIComponent(lojaId)}`);
    const item = data?.data;
    const nomeApi = item?.nome || item?.descricao || item?.apelido || null;
    if (nomeApi) {
      await query(
        `insert into lojas_bling (id, nome)
         values ($1, $2)
         on conflict (id) do update set nome = excluded.nome, updated_at = now()`,
        [lojaId, nomeApi]
      );
      return nomeApi;
    }
  } catch (err) {
    const st = err?.response?.status;
    if (st && st !== 404) {
      console.warn('[LOJA LOOKUP] /lojas/{id} status:', st, 'payload:', err?.response?.data || err.message);
    }
  }

  const baseUrl = `${base}/lojas`;
  for (let pagina = 1; pagina <= 5; pagina++) {
    try {
      const data = await blingGet(apelido, `${baseUrl}?pagina=${pagina}&limite=100`);
      const arr = Array.isArray(data?.data) ? data.data : [];
      const item = arr.find((x) => String(x.id) === String(lojaId));
      const nomeApi = item?.nome || item?.descricao || item?.apelido || null;
      if (nomeApi) {
        await query(
          `insert into lojas_bling (id, nome)
           values ($1, $2)
           on conflict (id) do update set nome = excluded.nome, updated_at = now()`,
          [lojaId, nomeApi]
        );
        return nomeApi;
      }
      if (arr.length < 100) break;
    } catch (err) {
      console.warn('[LOJA LOOKUP] listagem status:', err?.response?.status, 'payload:', err?.response?.data || err.message);
      break;
    }
  }
  return null;
}

function deduzirNomeLojaPelosPadroes(numeroLoja, sugestaoAtual = null) {
  if (sugestaoAtual) return sugestaoAtual;
  const s = String(numeroLoja || '').toUpperCase().trim();
  if (!s) return null;

  const PADROES_LOJAS = [
    { nome: 'Mercado Livre RLD',  test: (t) => t.includes('RLD') },
    { nome: 'Mercado Livre',      test: (t) => t.startsWith('MLB') || t.includes('MERCADO LIVRE') },
    { nome: 'Magazine Luiza',     test: (t) => t.includes('MAGALU') || t.includes(' MAG ') || t.startsWith('MGLU') },
    { nome: 'Shopee',             test: (t) => t.includes('SHOPEE') || t.startsWith('SHP') },
    { nome: 'Amazon',             test: (t) => t.includes('AMAZON') || t.startsWith('AMZ') || t.includes('BRD') },
    { nome: 'Americanas',         test: (t) => t.includes('AMERICANAS') || t.includes('B2W') || t.includes('LAME') },
    { nome: 'Submarino',          test: (t) => t.includes('SUBMARINO') },
    { nome: 'Shoptime',           test: (t) => t.includes('SHOPTIME') },
    { nome: 'Casas Bahia',        test: (t) => t.includes('CASAS BAHIA') || t.includes('VIA VAREJO') || t.includes('CB') },
    { nome: 'Ponto',              test: (t) => t.includes('PONTO FRIO') || t.includes(' PONTO ') },
    { nome: 'Carrefour',          test: (t) => t.includes('CARREFOUR') },
    { nome: 'Netshoes',           test: (t) => t.includes('NETSHOES') || t.includes('ZATTINI') },
    { nome: 'Dafiti',             test: (t) => t.includes('DAFITI') },
    { nome: 'MadeiraMadeira',     test: (t) => t.includes('MADEIRAMADEIRA') || t.includes(' MM ') },
    { nome: 'Nuvemshop',          test: (t) => t.includes('NUVEMSHOP') || t.includes(' NS ') },
    { nome: 'Tray',               test: (t) => t.includes('TRAY') },
    { nome: 'Shopify',            test: (t) => t.includes('SHOPIFY') }
  ];

  const hit = PADROES_LOJAS.find((p) => p.test(s));
  return hit ? hit.nome : null;
}

/*  OAuth Bling (autorizar e callback) */
app.get('/auth/bling', (req, res) => {
  const apelido = String(req.query.account || 'Conta de Teste');
  const url = new URL(process.env.BLING_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', process.env.BLING_CLIENT_ID);
  url.searchParams.set('state', encodeURIComponent(apelido));
  return res.redirect(url.toString());
});

app.get('/callback', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;
    if (error) return res.status(400).send(`<h3>Erro</h3><pre>${error}: ${error_description || ''}</pre>`);
    if (!code) return res.status(400).send('Faltou o "code".');

    const apelido = decodeURIComponent(state || 'Conta de Teste');

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.BLING_REDIRECT_URI
    });

    const { data } = await axios.post(process.env.BLING_TOKEN_URL, body.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': '1.0',
        'Authorization': cabecalhoBasicAuth()
      }
    });

    const salvo = await salvarTokens({
      apelido,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in
    });

    res.send(`
      <h2>Autorizado com sucesso!</h2>
      <p>Conta: <b>${apelido}</b></p>
      <p>Token expira em: <b>${dayjs(salvo.expires_at).format('YYYY-MM-DD HH:mm:ss')}</b></p>
      <a href="/">Voltar para o app</a>
    `);
  } catch (e) {
    const payload = e?.response?.data || e.message;
    console.error('Erro no callback:', payload);
    res.status(500).send(`<pre>${JSON.stringify(payload, null, 2)}</pre>`);
  }
});

/*  Vendas / Notas — exemplo de consulta   */
async function handlerBuscarVenda(req, res) {
  try {
    const idOuNumero = String(req.params.id);
    const apelido = String(req.query.account || 'Conta de Teste');
    const base = process.env.BLING_API_BASE;

    let pedido = null;
    try {
      const d1 = await blingGet(apelido, `${base}/pedidos/vendas/${encodeURIComponent(idOuNumero)}`);
      pedido = d1?.data || null;
    } catch (e1) {
      if (e1?.response?.status && e1.response.status !== 404) {
        console.error('Erro consultando por ID interno:', e1?.response?.data || e1);
      }
    }

    if (!pedido) {
      try {
        const d2 = await blingGet(apelido, `${base}/pedidos/vendas?numero=${encodeURIComponent(idOuNumero)}`);
        const lista = Array.isArray(d2?.data) ? d2.data : [];
        pedido = lista[0] || null;
      } catch (e2) {
        if (e2?.response?.status && e2.response.status !== 404) {
          console.error('Erro consultando por número:', e2?.response?.data || e2);
        }
      }
    }

    if (!pedido) {
      return res.status(404).json({
        error: `Pedido não encontrado: tente com o ID interno ou use o 'numero' visível no Bling (ex.: /api/sales/1).`
      });
    }

    const lojaId     = pedido?.loja?.id ?? null;
    const numeroLoja = pedido?.numeroLoja ?? '';
    const numero     = pedido?.numero ?? null;

    let lojaNome = pedido?.loja?.nome || pedido?.loja?.descricao || null;
    if (!lojaNome && lojaId !== null) {
      lojaNome = await pegarNomeLojaPorId(apelido, lojaId);
    }
    lojaNome = deduzirNomeLojaPelosPadroes(numeroLoja, lojaNome);
    if (!lojaNome && (lojaId === 0 || lojaId === null)) lojaNome = 'Pedido manual (sem loja)';
    if (!lojaNome && lojaId) lojaNome = `Loja #${lojaId}`;

    const clienteNome =
      pedido?.cliente?.nome ||
      pedido?.contato?.nome ||
      pedido?.destinatario?.nome ||
      pedido?.cliente_nome ||
      pedido?.cliente?.fantasia ||
      null;

    return res.json({
      idVenda: String(pedido.id || idOuNumero),
      numeroPedido: numero,
      lojaId,
      lojaNome,
      numeroLoja,
      clienteNome,
      debug: { usadoParametro: idOuNumero }
    });
  } catch (e) {
    console.error('Falha ao consultar venda:', e?.response?.data || e);
    const status = e?.response?.status || 400;
    return res.status(status).json({ error: 'Falha ao consultar venda no Bling.' });
  }
}
app.get('/api/sales/:id',  handlerBuscarVenda);
app.get('/api/vendas/:id', handlerBuscarVenda);

/*  Events API — listar eventos por return_id (auditoria) */
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
    const items = rows.map(r => ({ ...r, meta: seguroParseJson(r.meta) }));
    res.json({ items, limit, offset });
  } catch (err) {
    console.error('GET /api/returns/:id/events error:', err);
    res.status(500).json({ error: 'Falha ao listar eventos' });
  }
});

/*  Start */
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
});

/**
 * - Upload CSV do ML: POST /api/csv/upload  (módulo routes/csv-upload.js)
 *   - `?dry=1` = dry-run (simula tudo, não grava nada).
 * - Template CSV: GET /api/csv/template (também no módulo de CSV).
 * - Eventos de auditoria: tabela return_events; use addReturnEvent() para manter idempotência.
 * - KPIs/Home/Logs: rotas /api/home/* e /api/returns/logs.
 * - Integração Bling: OAuth em /auth/bling -> /callback; use blingGet() para chamadas.
 */
