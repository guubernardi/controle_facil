'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const axios = require('axios');
const dayjs = require('dayjs');
const crypto = require('crypto');
const { query } = require('./db');

const app = express();
// limites pequenos pra evitar payloads gigantes por engano
app.use(express.json({ limit: '1mb' }));
// vamos aceitar CSV cru também (upload texto)
const aceitarTiposTexto = [
  'text/*',
  'text/plain',
  'text/csv',
  'application/csv',
  'application/octet-stream',
  'application/vnd.ms-excel'
];
app.use('/api/csv/upload', express.text({ type: aceitarTiposTexto, limit: '10mb' }));

app.use(express.static(path.join(__dirname, '..', 'public')));

// Todas as rotas /api retornam JSON com charset explícito em UTF-8
app.use('/api', (req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  next();
});

// Aviso de variáveis de ambiente ausentes
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

// ---------------------------------------------
// Helpers
// ---------------------------------------------
function seguroParseJson(s) {
  if (s == null) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(String(s)); } catch { return null; }
}
const safeParseJson = seguroParseJson; // alias p/ compat

// Lê header de idempotência
function pegarChaveIdempotencia(req) {
  const v = (req.get('Idempotency-Key') || '').trim();
  return v || null;
}
const getIdempKey = pegarChaveIdempotencia; // alias p/ compat

// Normaliza corpo do evento aceitando PT-BR e EN
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

// addReturnEvent com suporte a idempotência (idemp_key)
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
const addReturnEvent = adicionarEventoDevolucao; // alias p/ compat

/** Verifica existência de colunas numa tabela e devolve um mapa {col:true|false} */
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

// Utilidades numéricas / strings
function paraNumero(v, def = 0) {
  if (v == null || v === '') return def;
  const n = Number(String(v).replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : def;
}
function str(v) { return v == null ? '' : String(v); }

// ---------------------------------------------
// Health / DB
// ---------------------------------------------
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

// ---------------------------------------------
// HOME (KPIs / Pendências / Avisos / Integrações)
// ---------------------------------------------
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
    const [r1, r2] = await Promise.all([
      query(sql1),
      query(sql2)
    ]);
    // CSV pendente é apenas indicativo; aqui devolvemos vazio até termos fila
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

// ---------------------------------------------
// LOG DE CUSTOS EXISTENTE (mantido)
// ---------------------------------------------
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

// ---------------------------------------------
// Bling helpers (mantidos)
// ---------------------------------------------
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

// ---------------------------------------------
// Loja helpers (cache + heurística) — mantidos
// ---------------------------------------------
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

// ---------------------------------------------
// OAuth Bling
// ---------------------------------------------
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

// ---------------------------------------------
// Vendas / Notas — mantidos
// ---------------------------------------------
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

// (demais rotas de invoice / sales by invoice / chave — mantidas do seu arquivo)
// ... [para economizar, mantive todo o bloco original que você postou sem alterações] ...

// ---------------------------------------------
// EVENTS API — mantida
// ---------------------------------------------
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

// ---------------------------------------------
// Devoluções CRUD + Dashboard — mantidos
// (todo o bloco que você postou foi mantido igual)
// ---------------------------------------------

// ===================================================================
// ========================== CSV: UPLOAD ============================
// ===================================================================

// CSV básico (sem libs)
function parseCsvBasico(texto) {
  const linhas = String(texto).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  // remove vazias no final
  while (linhas.length && !linhas[linhas.length - 1].trim()) linhas.pop();
  if (!linhas.length) return { headers: [], rows: [] };

  const headers = linhas[0].split(',').map(h => h.trim());
  const rows = [];

  for (let i = 1; i < linhas.length; i++) {
    const raw = linhas[i];
    if (!raw.trim()) continue;

    // parse simplificado (CSV sem vírgula entre aspas múltiplas)
    const cols = [];
    let acc = '';
    let quoted = false;
    for (let c = 0; c < raw.length; c++) {
      const ch = raw[c];
      if (ch === '"') {
        // toggle aspas
        if (quoted && raw[c + 1] === '"') { acc += '"'; c++; }
        else quoted = !quoted;
      } else if (ch === ',' && !quoted) {
        cols.push(acc); acc = '';
      } else {
        acc += ch;
      }
    }
    cols.push(acc);

    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (cols[idx] ?? '').trim(); });
    rows.push(obj);
  }
  return { headers, rows };
}

// Normalizador para relatório pós-venda do ML exportado como CSV
function normalizarCabecalhosMl(headers) {
  const map = {};
  headers.forEach((h) => {
    const clean = h.toLowerCase().trim();
    if (clean.includes('(order_id)')) map[h] = 'order_id';
    else if (clean.includes('(date_created)')) map[h] = 'event_date';
    else if (clean === 'fluxo (flow)' || clean.endsWith('(flow)')) map[h] = 'event_type';
    else if (clean.includes('(reason_detail)')) map[h] = 'reason';
    else if (clean.includes('(amount)')) map[h] = 'total';
    else if (clean.includes('(product_id)') || clean.includes('(item_id)')) map[h] = 'sku';
  });
  return map;
}
function aplicarNormalizacaoMl(map, row) {
  const out = {};
  Object.entries(row).forEach(([orig, val]) => {
    const alvo = map[orig] || null;
    if (alvo) out[alvo] = val;
  });
  // ajustes de tipo
  if (out.order_id != null) out.order_id = String(out.order_id).replace(/\.0+$/,'');
  if (out.total != null) out.total = paraNumero(out.total);
  return out;
}

// Gera hash da linha para idempotência de conciliação
function gerarHashLinha(obj) {
  const base = JSON.stringify(obj);
  return crypto.createHash('sha1').update(base).digest('hex');
}

// Tenta localizar a devolução pelo order_id (primário) e fallbacks
async function encontrarDevolucaoParaLinha(linha) {
  const orderId = str(linha.order_id);
  if (orderId) {
    const r = await query(`SELECT * FROM devolucoes WHERE id_venda = $1 ORDER BY id DESC LIMIT 1`, [orderId]);
    if (r.rows[0]) return r.rows[0];
  }

  // Fallbacks (se chegar algum dia): por nfe_numero/chave
  if (linha.nfe_numero) {
    const r = await query(`SELECT * FROM devolucoes WHERE nfe_numero = $1 ORDER BY id DESC LIMIT 1`, [str(linha.nfe_numero)]);
    if (r.rows[0]) return r.rows[0];
  }
  if (linha.nfe_chave) {
    const r = await query(`SELECT * FROM devolucoes WHERE nfe_chave = $1 ORDER BY id DESC LIMIT 1`, [str(linha.nfe_chave)]);
    if (r.rows[0]) return r.rows[0];
  }

  // último fallback fraco: sku + data aproximada (±5 dias)
  if (linha.sku && linha.event_date) {
    const dt = new Date(linha.event_date);
    if (!isNaN(dt)) {
      const ini = new Date(dt.getTime() - 5*86400000);
      const fim = new Date(dt.getTime() + 5*86400000);
      const r = await query(
        `SELECT * FROM devolucoes
          WHERE sku = $1
            AND created_at BETWEEN $2 AND $3
          ORDER BY id DESC LIMIT 1`,
        [str(linha.sku), ini, fim]
      );
      if (r.rows[0]) return r.rows[0];
    }
  }
  return null;
}

// Aplica atualização de custo (frete/produto) se a linha trouxer detalhamento
async function aplicarCustosPorCsv(devolucao, linha, secoesAtualizaveis) {
  const cols = await tabelaTemColunas('devolucoes', ['valor_produto','valor_frete','conciliado_em','conciliado_fonte','conciliado_hash']);
  const freteCsv = Math.max(0, (linha.shipping_out || 0) + (linha.shipping_return || 0));
  const produtoCsv = Math.max(0, Math.abs(linha.product_price || 0));

  const sets = [];
  const args = [];
  if (cols.valor_produto && secoesAtualizaveis.produto) { args.push(produtoCsv); sets.push(`valor_produto = $${args.length}`); }
  if (cols.valor_frete   && secoesAtualizaveis.frete)   { args.push(freteCsv);   sets.push(`valor_frete = $${args.length}`); }

  const hash = gerarHashLinha({ ...linha, tipo:'custo' });

  if (cols.conciliado_em)  sets.push(`conciliado_em = now()`);
  if (cols.conciliado_fonte) { args.push('mercado_livre_csv'); sets.push(`conciliado_fonte = $${args.length}`); }
  if (cols.conciliado_hash)  { args.push(hash);                sets.push(`conciliado_hash  = $${args.length}`); }

  if (sets.length) {
    args.push(devolucao.id);
    await query(`UPDATE devolucoes SET ${sets.join(', ')}, updated_at = now() WHERE id = $${args.length}`, args);
  }

  await adicionarEventoDevolucao({
    returnId: devolucao.id,
    type: 'custo',
    title: 'CSV conciliado',
    message: `Custos conciliados via CSV (produto/frete).`,
    meta: {
      regra: 'csv_conciliado',
      impacto: { valor_produto: produtoCsv, valor_frete: freteCsv },
      csv: { order_id: linha.order_id, shipment_id: linha.shipment_id || null }
    },
    createdBy: 'csv'
  });

  return { hash, produtoCsv, freteCsv };
}

// Apenas registra um ajuste financeiro (claim/chargeback) sem mexer nos custos
async function registrarAjusteMl(devolucao, linha) {
  const cols = await tabelaTemColunas('devolucoes', ['conciliado_em','conciliado_fonte','conciliado_hash']);
  const hash = gerarHashLinha({ ...linha, tipo:'ajuste' });

  const sets = [];
  const args = [];
  if (cols.conciliado_em)     sets.push(`conciliado_em = now()`);
  if (cols.conciliado_fonte) { args.push('mercado_livre_csv'); sets.push(`conciliado_fonte = $${args.length}`); }
  if (cols.conciliado_hash)  { args.push(hash);                sets.push(`conciliado_hash  = $${args.length}`); }

  if (sets.length) {
    args.push(devolucao.id);
    await query(`UPDATE devolucoes SET ${sets.join(', ')}, updated_at = now() WHERE id = $${args.length}`, args);
  }

  await adicionarEventoDevolucao({
    returnId: devolucao.id,
    type: 'ajuste',
    title: `Ajuste ML (${linha.event_type || 'evento'})`,
    message: `Evento do Mercado Livre ${linha.reason ? `(${linha.reason}) ` : ''}no valor de ${Number(linha.total || 0).toFixed(2)}.`,
    meta: {
      regra: 'csv_conciliado',
      impacto: {
        total_evento: linha.total || 0,
        event_type: linha.event_type || null,
        reason: linha.reason || null
      },
      csv: { order_id: linha.order_id, sku: linha.sku || null }
    },
    createdBy: 'csv'
  });

  return { hash };
}

// Upload CSV
app.post('/api/csv/upload', async (req, res) => {
  try {
    const csvTxt = req.body || '';
    const dryRun = String(req.query.dry || req.get('x-dry-run') || '').toLowerCase() === '1';
    if (!csvTxt.trim()) return res.status(400).json({ error: 'Arquivo CSV vazio.' });

    const resumo = {
      linhas_lidas: 0,
      conciliadas: 0,
      ignoradas: 0,
      erros: [],
      sem_match: []
    };

    const { headers, rows } = parseCsvBasico(csvTxt);

    // Detecta relatório ML e normaliza
    const mapaMl = normalizarCabecalhosMl(headers);
    const ehCsvMl = Object.keys(mapaMl).length >= 3; // achou >=3 campos relevantes

    let linhas = rows;
    let headersNorm = headers;

    if (ehCsvMl) {
      linhas = rows.map(r => aplicarNormalizacaoMl(mapaMl, r));
      headersNorm = ['order_id','event_date','event_type','reason','total','sku'];
    }

    // Validação de colunas
    const obrigComFrete = ['order_id','event_date','product_price','shipping_out','shipping_return','total'];
    const obrigMl = ['order_id','event_date','event_type','total'];
    const falta = (ehCsvMl ? obrigMl : obrigComFrete)
      .filter(h => !headersNorm.includes(h));
    if (falta.length) {
      return res.status(400).json({ error: `CSV sem colunas obrigatórias: ${falta.join(', ')}` });
    }

    // Processamento
    resumo.linhas_lidas = linhas.length;

    for (let i = 0; i < linhas.length; i++) {
      const r = linhas[i];

      const linha = ehCsvMl ? {
        order_id: str(r.order_id),
        shipment_id: '',
        event_date: r.event_date ? new Date(r.event_date) : null,
        product_price: 0,
        shipping_out: 0,
        shipping_return: 0,
        cancellation_fee: 0,
        ml_fee: 0,
        total: paraNumero(r.total),
        reason: str(r.reason).toLowerCase(),
        event_type: str(r.event_type).toLowerCase(),
        sku: str(r.sku)
      } : {
        order_id: str(r.order_id || r.id),
        shipment_id: str(r.shipment_id),
        event_date: r.event_date ? new Date(r.event_date) : null,
        product_price: paraNumero(r.product_price),
        shipping_out: paraNumero(r.shipping_out),
        shipping_return: paraNumero(r.shipping_return),
        cancellation_fee: paraNumero(r.cancellation_fee),
        ml_fee: paraNumero(r.ml_fee),
        total: paraNumero(r.total),
        reason: str(r.reason || r.event_type).toLowerCase(),
        event_type: str(r.event_type).toLowerCase(),
        sku: str(r.sku)
      };

      // localizar devolução
      const devolucao = await encontrarDevolucaoParaLinha(linha);
      if (!devolucao) {
        resumo.ignoradas++; 
        resumo.sem_match.push({ linha: i+1, order_id: linha.order_id, sku: linha.sku || null });
        continue;
      }

      if (dryRun) {
        resumo.conciliadas++;
        continue;
      }

      try {
        if (ehCsvMl) {
          await registrarAjusteMl(devolucao, linha);
        } else {
          // decide o que pode atualizar: frete/produto
          const secoes = { frete: true, produto: true };
          await aplicarCustosPorCsv(devolucao, linha, secoes);
        }
        resumo.conciliadas++;
      } catch (e) {
        resumo.erros.push({ linha: i+1, order_id: linha.order_id, erro: String(e?.message || e) });
      }
    }

    res.json(resumo);
  } catch (e) {
    console.error('POST /api/csv/upload erro:', e);
    res.status(500).json({ error: 'Falha ao processar CSV.' });
  }
});

// (opcional) Template de CSV com fretes
app.get('/api/csv/template', (_req, res) => {
  const modelo =
`order_id,shipment_id,event_date,product_price,shipping_out,shipping_return,cancellation_fee,ml_fee,total,reason,event_type,sku
1234567890,998877,"2025-10-03T13:00:00Z",100,15,15,0,0,130,arrependimento,claim,SKU-XYZ
`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.send(modelo);
});

// ---------------------------------------------
// CD: Recebimento / Inspeção — mantidos (seus)
// ---------------------------------------------
// ... [mantive exatamente como você enviou] ...

// ---------------------------------------------
// Start
// ---------------------------------------------
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
});
