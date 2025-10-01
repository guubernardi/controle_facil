'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const axios = require('axios');
const dayjs = require('dayjs');
const { query } = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

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
function safeParseJson(s) {
  if (s == null) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(String(s)); } catch { return null; }
}

async function addReturnEvent({ returnId, type, title = null, message = null, meta = null, createdBy = 'system' }) {
  const metaStr = meta ? JSON.stringify(meta) : null;
  const sql = `
    INSERT INTO return_events (return_id, type, title, message, meta, created_by, created_at)
    VALUES ($1,$2,$3,$4,$5,$6, now())
    RETURNING id, return_id AS "returnId", type, title, message, meta, created_by AS "createdBy", created_at AS "createdAt"
  `;
  const { rows } = await query(sql, [returnId, type, title, message, metaStr, createdBy]);
  const ev = rows[0];
  ev.meta = safeParseJson(ev.meta);
  return ev;
}

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
// GET /api/returns/logs  (Log de custos)
// ---------------------------------------------
app.get('/api/returns/logs', async (req, res) => {
  try {
    const {
      from, to, status, responsavel, loja, q,
      page = 1, pageSize = 50,
      orderBy = 'event_at', orderDir = 'desc'
    } = req.query;

    const params = [];
    const where = [];

    if (from) { params.push(from); where.push(`event_at >= $${params.length}`); }
    if (to)   { params.push(to);   where.push(`event_at <  $${params.length}`); } // 'to' exclusivo

    if (status) {
      params.push(String(status).toLowerCase());
      where.push(`LOWER(status) = $${params.length}`);
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
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
      where.push(`(
        numero_pedido ILIKE $${params.length-3} OR
        cliente_nome  ILIKE $${params.length-2} OR
        sku           ILIKE $${params.length-1} OR
        reclamacao    ILIKE $${params.length}
      )`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // ordenação segura
    const orderCols = new Set(['event_at','status','total','valor_produto','valor_frete']);
    const col = orderCols.has(orderBy) ? orderBy : 'event_at';
    const dir = String(orderDir).toLowerCase() === 'asc' ? 'asc' : 'desc';

    const offset = (Number(page) - 1) * Number(pageSize);
    params.push(pageSize, offset);

    const baseSql = `
      FROM public.v_return_cost_log
      ${whereSql}
    `;

    const { rows: items } = await query(
      `SELECT *
       ${baseSql}
       ORDER BY ${col} ${dir}
       LIMIT $${params.length-1} OFFSET $${params.length}`,
      params
    );

    const { rows: [{ count }] } = await query(
      `SELECT COUNT(*)::int AS count ${baseSql}`,
      params.slice(0, params.length - 2)
    );

    const { rows: [{ sum }] } = await query(
      `SELECT COALESCE(SUM(total),0)::numeric AS sum ${baseSql}`,
      params.slice(0, params.length - 2)
    );

    res.json({ items, total: count, sum_total: sum });
  } catch (e) {
    console.error('GET /api/returns/logs erro:', e);
    res.status(500).json({ error: 'Falha ao buscar registro.' });
  }
});

// ---------------------------------------------
// Bling helpers
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
// Loja helpers (cache + heurística)
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
// Vendas por ID/numero
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

// ----------------------------------------------------------------------------
// Consulta por Nota Fiscal (NFe)
// ----------------------------------------------------------------------------
async function handlerBuscarNotaPorNumero(req, res) {
  try {
    const numero = String(req.params.numero);
    const apelido = String(req.query.account || 'Conta de Teste');
    const base = process.env.BLING_API_BASE;

    let nota = null;

    try {
      const r1 = await blingGet(apelido, `${base}/notas?numero=${encodeURIComponent(numero)}`);
      const arr = Array.isArray(r1?.data) ? r1.data : [];
      nota = arr[0] || null;
    } catch (_) {}

    if (!nota) {
      try {
        const r2 = await blingGet(apelido, `${base}/pedidos/vendas?numeroNota=${encodeURIComponent(numero)}`);
        const arr = Array.isArray(r2?.data) ? r2.data : [];
        nota = arr[0] || null;
      } catch (_) {}
    }

    if (!nota) return res.status(404).json({ error: 'Nota não encontrada' });

    const lojaNome   = nota?.loja?.nome || nota?.loja?.descricao || null;
    const cliente    = nota?.cliente?.nome || nota?.destinatario?.nome || nota?.cliente_nome || null;
    const valor_total= nota?.valor_total || nota?.total || null;
    const chave      = nota?.chave || nota?.access_key || null;

    res.json({ lojaNome, cliente, valor_total, chave, debug: { found: true } });
  } catch (e) {
    console.error('Erro ao buscar nota por número:', e?.response?.data || e);
    res.status(500).json({ error: 'Falha ao consultar nota.' });
  }
}

async function handlerBuscarNotaPorChave(req, res) {
  try {
    const chave = String(req.params.chave);
    const apelido = String(req.query.account || 'Conta de Teste');
    const base = process.env.BLING_API_BASE;

    try {
      const r = await blingGet(apelido, `${base}/notas/${encodeURIComponent(chave)}`);
      const nota = r?.data || null;
      if (nota) {
        const lojaNome   = nota?.loja?.nome || nota?.loja?.descricao || null;
        const cliente    = nota?.cliente?.nome || nota?.destinatario?.nome || nota?.cliente_nome || null;
        const valor_total= nota?.valor_total || nota?.total || null;
        return res.json({ lojaNome, cliente, valor_total, chave });
      }
    } catch (_) {}

    try {
      const r2 = await blingGet(apelido, `${base}/notas?chave=${encodeURIComponent(chave)}`);
      const arr = Array.isArray(r2?.data) ? r2.data : [];
      const nota = arr[0] || null;
      if (!nota) return res.status(404).json({ error: 'Nota não encontrada' });
      const lojaNome   = nota?.loja?.nome || nota?.loja?.descricao || null;
      const cliente    = nota?.cliente?.nome || nota?.destinatario?.nome || nota?.cliente_nome || null;
      const valor_total= nota?.valor_total || nota?.total || null;
      return res.json({ lojaNome, cliente, valor_total, chave });
    } catch (e) {
      console.error('Erro ao buscar nota por chave:', e?.response?.data || e);
      return res.status(500).json({ error: 'Falha ao consultar nota por chave.' });
    }
  } catch (e) {
    console.error('Erro geral invoice/chave:', e);
    res.status(500).json({ error: 'Falha ao consultar nota por chave.' });
  }
}

app.get('/api/invoice/:numero', handlerBuscarNotaPorNumero);
app.get('/api/invoice/chave/:chave', handlerBuscarNotaPorChave);

// ---------- localizar PEDIDO pela NFe (por número ou por chave) ----------
async function resolverPedidoAPartirDaNota(apelido, notaOuVenda) {
  const base = process.env.BLING_API_BASE;

  if (notaOuVenda?.itens && (notaOuVenda?.numero || notaOuVenda?.id)) {
    return notaOuVenda;
  }

  const possiveisIds = [
    notaOuVenda?.pedido?.id,
    notaOuVenda?.pedidoVenda?.id,
    notaOuVenda?.id_pedido,
    notaOuVenda?.venda_id,
  ].filter(Boolean);

  for (const cand of possiveisIds) {
    try {
      const d = await blingGet(apelido, `${base}/pedidos/vendas/${encodeURIComponent(cand)}`);
      if (d?.data) return d.data;
    } catch (_) {}
  }

  const numeroNota = notaOuVenda?.numero || notaOuVenda?.numero_nota || notaOuVenda?.nota_numero;
  if (numeroNota) {
    try {
      const r = await blingGet(apelido, `${base}/pedidos/vendas?numeroNota=${encodeURIComponent(numeroNota)}`);
      const arr = Array.isArray(r?.data) ? r.data : [];
      if (arr[0]) return arr[0];
    } catch (_) {}
  }

  const chave = notaOuVenda?.chave || notaOuVenda?.access_key;
  if (chave) {
    try {
      const r = await blingGet(apelido, `${base}/pedidos/vendas?chave=${encodeURIComponent(chave)}`);
      const arr = Array.isArray(r?.data) ? r.data : [];
      if (arr[0]) return arr[0];
    } catch (_) {}
  }

  return null;
}

async function responderPedidoPadronizado(apelido, pedido, res, debugExtra = {}) {
  try {
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
      idVenda: String(pedido.id || ''),
      numeroPedido: numero,
      lojaId,
      lojaNome,
      numeroLoja,
      clienteNome,
      debug: debugExtra
    });
  } catch (e) {
    console.error('responderPedidoPadronizado erro:', e);
    return res.status(500).json({ error: 'Falha ao formatar resposta.' });
  }
}

app.get('/api/sales/by-invoice/:numero', async (req, res) => {
  try {
    const numero = String(req.params.numero);
    const apelido = String(req.query.account || 'Conta de Teste');

    let nota = null;
    try {
      const r1 = await blingGet(apelido, `${process.env.BLING_API_BASE}/notas?numero=${encodeURIComponent(numero)}`);
      const arr = Array.isArray(r1?.data) ? r1.data : [];
      nota = arr[0] || null;
    } catch (_) {}

    if (!nota) {
      const r2 = await blingGet(apelido, `${process.env.BLING_API_BASE}/pedidos/vendas?numeroNota=${encodeURIComponent(numero)}`);
      const arr = Array.isArray(r2?.data) ? r2.data : [];
      if (!arr[0]) return res.status(404).json({ error: 'Nenhum pedido encontrado para esta nota.' });
      return await responderPedidoPadronizado(apelido, arr[0], res, { via: 'vendas?numeroNota' });
    }

    const pedido = await resolverPedidoAPartirDaNota(apelido, nota);
    if (!pedido) return res.status(404).json({ error: 'Não foi possível relacionar esta nota a um pedido.' });

    return await responderPedidoPadronizado(apelido, pedido, res, { via: 'nota->pedido' });
  } catch (e) {
    console.error('by-invoice erro:', e?.response?.data || e);
    res.status(500).json({ error: 'Falha ao localizar pedido pela nota.' });
  }
});

app.get('/api/sales/by-chave/:chave', async (req, res) => {
  try {
    const chave = String(req.params.chave);
    const apelido = String(req.query.account || 'Conta de Teste');
    const base = process.env.BLING_API_BASE;

    let nota = null;
    try {
      const r = await blingGet(apelido, `${base}/notas/${encodeURIComponent(chave)}`);
      nota = r?.data || null;
    } catch (_) {
      try {
        const r2 = await blingGet(apelido, `${base}/notas?chave=${encodeURIComponent(chave)}`);
        const arr = Array.isArray(r2?.data) ? r2.data : [];
        nota = arr[0] || null;
      } catch (_) {}
    }

    if (!nota) {
      const r3 = await blingGet(apelido, `${base}/pedidos/vendas?chave=${encodeURIComponent(chave)}`);
      const arr = Array.isArray(r3?.data) ? r3.data : [];
      if (!arr[0]) return res.status(404).json({ error: 'Nenhum pedido encontrado para esta chave.' });
      return await responderPedidoPadronizado(apelido, arr[0], res, { via: 'vendas?chave' });
    }

    const pedido = await resolverPedidoAPartirDaNota(apelido, nota);
    if (!pedido) return res.status(404).json({ error: 'Não foi possível relacionar esta chave a um pedido.' });

    return await responderPedidoPadronizado(apelido, pedido, res, { via: 'nota->pedido' });
  } catch (e) {
    console.error('by-chave erro:', e?.response?.data || e);
    res.status(500).json({ error: 'Falha ao localizar pedido pela chave da nota.' });
  }
});

// ---------------------------------------------
// Autocomplete/Produtos/Estoque (Bling)
// ---------------------------------------------
const _cache = new Map();
const setCache = (k, v, ttl = 10000) => _cache.set(k, { v, exp: Date.now() + ttl });
const getCache = (k) => {
  const h = _cache.get(k);
  if (!h) return null;
  if (Date.now() > h.exp) { _cache.delete(k); return null; }
  return h.v;
};

app.get('/api/bling/products', async (req, res) => {
  try {
    const q       = String(req.query.q || '').trim();
    const pagina  = Math.max(parseInt(req.query.pagina || '1', 10), 1);
    const limit   = Math.max(1, Math.min(parseInt(req.query.limit || '10', 10), 50));
    const apelido = String(req.query.account || 'Conta de Teste');
    if (!q) return res.json([]);

    const key = `prod:${apelido}:${q}:${pagina}:${limit}`;
    const hit = getCache(key);
    if (hit) return res.json(hit);

    const base = process.env.BLING_API_BASE;
    const out  = [];

    for (let p = pagina; p < pagina + 3; p++) {
      const url = `${base}/produtos?descricao=${encodeURIComponent(q)}&pagina=${p}&limite=${limit}`;
      try {
        const r   = await blingGet(apelido, url);
        const arr = Array.isArray(r?.data) ? r.data : [];
        for (const pr of arr) {
          out.push({
            nome:    pr.nome || pr.descricao || '',
            sku:     pr.codigo || pr.sku || '',
            gtin:    pr.gtin  || pr.ean  || '',
            preco:   pr.preco?.preco ?? pr.preco ?? null,
            estoque: pr.estoque?.saldo ?? pr.estoqueAtual ?? null,
          });
        }
        if (arr.length < limit) break;
      } catch (_) { break; }
    }

    if (!out.length) {
      try {
        const r2   = await blingGet(apelido, `${base}/produtos?codigo=${encodeURIComponent(q)}`);
        const arr2 = Array.isArray(r2?.data) ? r2.data : [];
        for (const pr of arr2) {
          out.push({
            nome:    pr.nome || pr.descricao || '',
            sku:     pr.codigo || pr.sku || '',
            gtin:    pr.gtin  || pr.ean  || '',
            preco:   pr.preco?.preco ?? pr.preco ?? null,
            estoque: pr.estoque?.saldo ?? pr.estoqueAtual ?? null,
          });
        }
      } catch {}
    }

    const resp = out.slice(0, limit);
    setCache(key, resp, 10000);
    res.json(resp);
  } catch (e) {
    console.error('GET /api/bling/products ERRO:', e?.response?.data || e);
    res.status(500).json({ error: 'Falha ao consultar produtos.' });
  }
});

app.get('/api/bling/stock', async (req, res) => {
  try {
    const sku     = String(req.query.sku || '').trim();
    const apelido = String(req.query.account || 'Conta de Teste');
    if (!sku) return res.status(400).json({ error: 'sku obrigatório' });

    const key = `stk:${apelido}:${sku}`;
    const hit = getCache(key);
    if (hit) return res.json(hit);

    const base = process.env.BLING_API_BASE;
    const r = await blingGet(apelido, `${base}/estoques/saldos?codigo=${encodeURIComponent(sku)}`);
    setCache(key, r, 10000);
    res.json(r);
  } catch (e) {
    console.error('GET /api/bling/stock ERRO:', e?.response?.data || e);
    res.status(500).json({ error: 'Falha ao consultar estoque.' });
  }
});

// ---------------------------------------------
// Busca de produtos no Bling (fallback)
// ---------------------------------------------
app.get('/api/products/search', async (req, res) => {
  try {
    const q       = String(req.query.q || '').trim();
    const apelido = String(req.query.account || 'Conta de Teste');
    if (!q) return res.json([]);

    const base = process.env.BLING_API_BASE;
    const out  = [];

    for (let pagina = 1; pagina <= 3; pagina++) {
      try {
        const url = `${base}/produtos?descricao=${encodeURIComponent(q)}&pagina=${pagina}&limite=50`;
        const r   = await blingGet(apelido, url);
        const arr = Array.isArray(r?.data) ? r.data : [];
        for (const p of arr) {
          out.push({
            id:     p.id ?? null,
            nome:   p.nome || p.descricao || '',
            sku:    p.codigo || p.sku || '',
            gtin:   p.gtin || p.ean || '',
            preco:  p.preco?.preco ?? p.preco ?? null,
            estoque: p.estoque?.saldo ?? p.estoqueAtual ?? null
          });
        }
        if (arr.length < 50) break;
      } catch (_) { break; }
    }

    if (!out.length) {
      try {
        const url2 = `${base}/produtos?codigo=${encodeURIComponent(q)}`;
        const r2   = await blingGet(apelido, url2);
        const arr2 = Array.isArray(r2?.data) ? r2.data : [];
        for (const p of arr2) {
          out.push({
            id:     p.id ?? null,
            nome:   p.nome || p.descricao || '',
            sku:    p.codigo || p.sku || '',
            gtin:   p.gtin || p.ean || '',
            preco:  p.preco?.preco ?? p.preco ?? null,
            estoque: p.estoque?.saldo ?? p.estoqueAtual ?? null
          });
        }
      } catch (_) {}
    }

    res.json(out.slice(0, 20));
  } catch (e) {
    console.error('products/search erro:', e?.response?.data || e);
    res.status(500).json({ error: 'Falha ao buscar produtos no Bling.' });
  }
});

app.get('/api/products/:codigo', async (req, res) => {
  try {
    const codigo  = String(req.params.codigo);
    const apelido = String(req.query.account || 'Conta de Teste');
    const base    = process.env.BLING_API_BASE;

    const r = await blingGet(apelido, `${base}/produtos?codigo=${encodeURIComponent(codigo)}`);
    const p = Array.isArray(r?.data) ? r.data[0] : null;
    if (!p) return res.status(404).json({ error: 'Produto não encontrado' });

    res.json({
      id: p.id ?? null,
      nome: p.nome || p.descricao || '',
      sku: p.codigo || p.sku || '',
      gtin: p.gtin || p.ean || '',
      preco: p.preco?.preco ?? p.preco ?? null,
      estoque: p.estoque?.saldo ?? p.estoqueAtual ?? null
    });
  } catch (e) {
    console.error('products/:codigo erro:', e?.response?.data || e);
    res.status(500).json({ error: 'Falha ao consultar produto.' });
  }
});

// ---------------------------------------------
// EVENTS API (return_events) — GET/POST
// ---------------------------------------------
app.get('/api/returns/:id/events', async (req, res) => {
  try {
    const returnId = parseInt(req.params.id, 10);
    if (!Number.isInteger(returnId)) {
      return res.status(400).json({ error: 'return_id inválido' });
    }

    const limit  = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);

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

// body: { type: 'status'|'note'|'refund', title?, message?, meta?, created_by? }
app.post('/api/returns/:id/events', async (req, res) => {
  try {
    const returnId = parseInt(req.params.id, 10);
    if (!Number.isInteger(returnId)) {
      return res.status(400).json({ error: 'return_id inválido' });
    }

    const { type, title, message, meta, created_by } = req.body || {};
    if (!['status','note','refund'].includes(type)) {
      return res.status(400).json({ error: 'type inválido. Use: status | note | refund' });
    }

    const r = await query(`SELECT id FROM devolucoes WHERE id = $1`, [returnId]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Devolução não encontrada' });

    const ev = await addReturnEvent({
      returnId,
      type,
      title,
      message,
      meta,
      createdBy: created_by || 'system'
    });

    res.status(201).json(ev);
  } catch (err) {
    console.error('POST /api/returns/:id/events error:', err);
    res.status(500).json({ error: 'Falha ao criar evento' });
  }
});

// ---------------------------------------------
// Devoluções (CRUD + Dashboard)
// ---------------------------------------------
app.post('/api/returns', async (req, res) => {
  try {
    const {
      data_compra, id_venda, loja_id, loja_nome, sku, tipo_reclamacao,
      status, valor_produto, valor_frete, reclamacao, created_by,
      cliente_nome
    } = req.body;

    const sql = `
      insert into devolucoes
        (data_compra, id_venda, loja_id, loja_nome, sku, tipo_reclamacao, status, valor_produto, valor_frete, reclamacao, created_by, cliente_nome)
      values
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      returning id, created_at
    `;
    const params = [
      data_compra || null, id_venda, loja_id || null, loja_nome || null, sku || null,
      tipo_reclamacao || null, status || null, valor_produto || null, valor_frete || null,
      reclamacao || null, created_by || 'app-local',
      cliente_nome || null
    ];

    const { rows } = await query(sql, params);

    // Evento "status inicial" opcional (se veio status)
    if (status) {
      await addReturnEvent({
        returnId: rows[0].id,
        type: 'status',
        title: 'Status inicial',
        message: `Status inicial definido como "${status}"`,
        meta: { status },
        createdBy: created_by || 'app-local'
      });
    }

    return res.status(201).json({ ok: true, id: rows[0].id, created_at: rows[0].created_at });
  } catch (e) {
    console.error('POST /api/returns ERRO:', e);
    return res.status(400).json({ ok: false, error: 'Falha ao salvar devolução.' });
  }
});

/**
 * /api/dashboard — **Aplicando regras de custo**
 * - Rejeitado/Negado => 0
 * - Motivos do cliente => 0  (usa tipo_reclamacao contendo 'cliente')
 * - Recebido no CD / Em inspeção => só frete
 * - Demais => produto + frete
 * Também retorna:
 *  - daily  (por dia)
 *  - monthly (por mês)
 *  - status (mapa status -> quantidade)
 *  - top_items (por SKU com prejuízo calculado pela regra)
 */
app.get('/api/dashboard', async (req, res) => {
  try {
    const from = req.query.from ? new Date(req.query.from) : null;
    const to   = req.query.to   ? new Date(req.query.to)   : null;
    const limitTop = Math.max(1, Math.min(parseInt(req.query.limitTop || '5', 10), 20));

    const whereParts = [];
    const params = [];
    if (from) { params.push(from); whereParts.push(`created_at >= $${params.length}`); }
    if (to)   { params.push(to);   whereParts.push(`created_at <  $${params.length}`); }
    const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

    // CTE base + custo efetivo (regra aplicada)
    const baseCte = `
      WITH base AS (
        SELECT
          created_at,
          LOWER(COALESCE(status,''))              AS st,
          LOWER(COALESCE(tipo_reclamacao,''))     AS motivo,
          COALESCE(valor_produto,0)               AS vp,
          COALESCE(valor_frete,0)                 AS vf,
          COALESCE(NULLIF(TRIM(sku),''), '(sem SKU)') AS sku,
          NULLIF(TRIM(reclamacao),'')             AS reclamacao
        FROM devolucoes
        ${where}
      ),
      cte AS (
        SELECT
          created_at, st, motivo, sku, reclamacao, vp, vf,
          CASE
            WHEN st LIKE '%rej%' OR st LIKE '%neg%'       THEN 0
            WHEN motivo LIKE '%cliente%'                  THEN 0
            WHEN st IN ('recebido_cd','em_inspecao')      THEN vf
            ELSE vp + vf
          END::numeric(12,2) AS custo
        FROM base
      )
    `;

    // Totais do período
    const sqlTotals = `
      ${baseCte}
      SELECT
        COUNT(*)::int AS total,
        SUM(custo)::numeric(12,2) AS prejuizo_total,
        SUM( CASE WHEN st LIKE '%pend%'  THEN 1 ELSE 0 END )::int AS pendentes,
        SUM( CASE WHEN st LIKE '%aprov%' THEN 1 ELSE 0 END )::int AS aprovadas,
        SUM( CASE WHEN st LIKE '%rej%' OR st LIKE '%neg%' THEN 1 ELSE 0 END )::int AS rejeitadas
      FROM cte;
    `;

    // Top SKUs por prejuízo (regra aplicada)
    const sqlTop = `
      ${baseCte}
      SELECT
        s.sku,
        s.devolucoes,
        s.prejuizo,
        COALESCE(m.motivo, '—') AS motivo
      FROM (
        SELECT sku, COUNT(*)::int AS devolucoes, SUM(custo)::numeric(12,2) AS prejuizo
        FROM cte GROUP BY sku
      ) s
      LEFT JOIN (
        SELECT DISTINCT ON (sku)
          sku,
          reclamacao AS motivo,
          COUNT(*) OVER (PARTITION BY sku, reclamacao) AS cnt
        FROM cte
        WHERE reclamacao IS NOT NULL
        ORDER BY sku, cnt DESC, reclamacao ASC
      ) m USING (sku)
      ORDER BY s.prejuizo DESC, s.devolucoes DESC, s.sku ASC
      LIMIT $${params.length + 1};
    `;

    // Daily
    const sqlDaily = `
      ${baseCte}
      SELECT
        DATE_TRUNC('day', created_at)::date AS dia,
        COUNT(*)::int AS devolucoes,
        SUM(custo)::numeric(12,2) AS prejuizo
      FROM cte
      GROUP BY 1
      ORDER BY 1 ASC;
    `;

    // Monthly (p/ gráfico de 6 meses)
    const sqlMonthly = `
      ${baseCte}
      SELECT
        TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS ym,
        TO_CHAR(DATE_TRUNC('month', created_at), 'Mon YYYY') AS label,
        SUM(custo)::numeric(12,2) AS prejuizo
      FROM cte
      GROUP BY 1,2
      ORDER BY 1 ASC;
    `;

    // Distribuição por status
    const sqlStatus = `
      ${baseCte}
      SELECT st AS status, COUNT(*)::int AS n
      FROM cte
      GROUP BY 1
      ORDER BY 2 DESC;
    `;

    // Executa em paralelo
    const [totalsQ, topQ, dailyQ, monthlyQ, statusQ] = await Promise.all([
      query(sqlTotals, params),
      query(sqlTop, [...params, limitTop]),
      query(sqlDaily, params),
      query(sqlMonthly, params),
      query(sqlStatus, params)
    ]);

    // Mapa status -> quantidade
    const statusObj = {};
    for (const r of statusQ.rows) statusObj[r.status] = r.n;

    return res.json({
      range: { from: from || null, to: to || null },
      totals: {
        total:          totalsQ.rows[0]?.total || 0,
        pendentes:      totalsQ.rows[0]?.pendentes || 0,
        aprovadas:      totalsQ.rows[0]?.aprovadas || 0,
        rejeitadas:     totalsQ.rows[0]?.rejeitadas || 0,
        prejuizo_total: totalsQ.rows[0]?.prejuizo_total || 0
      },
      top_items: topQ.rows,
      daily:     dailyQ.rows.map(r => ({ date: r.dia, devolucoes: r.devolucoes, prejuizo: r.prejuizo })),
      monthly:   monthlyQ.rows.map(r => ({ month: r.label, ym: r.ym, prejuizo: r.prejuizo })),
      status:    statusObj
    });
  } catch (e) {
    console.error('GET /api/dashboard ERRO:', e);
    res.status(500).json({ error: 'Falha ao montar dashboard.' });
  }
});

app.get('/api/returns', async (req, res) => {
  try {
    const page     = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || '20', 10), 1), 100);
    const search   = (req.query.search || '').trim();
    const status   = (req.query.status || '').trim();

    const where = [];
    const args  = [];

    if (status) { args.push(status); where.push(`status = $${args.length}`); }

    if (search) {
      args.push(`%${search}%`);
      where.push(`(coalesce(sku,'') ILIKE $${args.length}
               OR coalesce(loja_nome,'') ILIKE $${args.length}
               OR coalesce(nfe_numero,'') ILIKE $${args.length}
               OR coalesce(nfe_chave,'') ILIKE $${args.length}
               OR coalesce(reclamacao,'') ILIKE $${args.length}
               OR coalesce(cliente_nome,'') ILIKE $${args.length})`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const off = (page - 1) * pageSize;

    const { rows } = await query(
      `SELECT id, data_compra, id_venda, loja_id, loja_nome, sku, tipo_reclamacao, status,
              valor_produto, valor_frete, nfe_numero, nfe_chave, created_at, updated_at,
              cliente_nome
         FROM devolucoes
        ${whereSql}
        ORDER BY id DESC
        LIMIT $${args.length+1} OFFSET $${args.length+2}`,
      [...args, pageSize, off]
    );

    const totalQ = await query(`SELECT count(*)::int AS n FROM devolucoes ${whereSql}`, args);
    res.json({ page, pageSize, total: totalQ.rows[0].n, items: rows });
  } catch (e) {
    console.error('GET /api/returns ERRO:', e);
    res.status(400).json({ error: 'Falha ao listar.' });
  }
});

app.get('/api/returns/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = await query(
      `SELECT id, data_compra, id_venda, loja_id, loja_nome, sku,
              tipo_reclamacao, status, valor_produto, valor_frete,
              reclamacao, nfe_numero, nfe_chave, created_at, updated_at,
              cliente_nome
         FROM devolucoes
        WHERE id = $1`, [id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Registro não encontrado.' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(400).json({ error: 'Falha ao buscar registro.' });
  }
});

// PATCH com evento automático de status
app.patch('/api/returns/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'ID inválido.' });

    const currentQ = await query(`SELECT id, status FROM devolucoes WHERE id=$1`, [id]);
    const current = currentQ.rows[0];
    if (!current) return res.status(404).json({ error: 'Devolução não encontrada.' });

    const allow = new Set([
      'status','loja_nome','sku','tipo_reclamacao','valor_produto','valor_frete',
      'reclamacao','nfe_numero','nfe_chave','data_compra','cliente_nome'
    ]);

    const sets = [];
    const args = [];
    Object.entries(req.body || {}).forEach(([k, v]) => {
      if (allow.has(k)) {
        args.push(v);
        sets.push(`${k} = $${args.length}`);
      }
    });

    if (req.body?.updated_by) {
      args.push(req.body.updated_by);
      sets.push(`updated_by = $${args.length}`);
    }

    if (!sets.length) return res.status(400).json({ error: 'Nada para atualizar.' });

    args.push(id);
    const sql = `
      UPDATE devolucoes
         SET ${sets.join(', ')}, updated_at = now()
       WHERE id = $${args.length}
      RETURNING *`;
    const r = await query(sql, args);
    if (!r.rows[0]) return res.status(404).json({ error: 'Registro não encontrado.' });

    const updated = r.rows[0];

    // Evento automático se status mudou
    const newStatus = req.body?.status;
    if (newStatus && newStatus !== current.status) {
      await addReturnEvent({
        returnId: id,
        type: 'status',
        title: 'Status atualizado',
        message: `Status alterado de "${current.status}" para "${newStatus}"`,
        meta: { from: current.status, to: newStatus },
        createdBy: req.body?.updated_by || 'system'
      });
    }

    res.json(updated);
  } catch (e) {
    console.error('PATCH /api/returns/:id ERRO:', e);
    res.status(400).json({ error: 'Falha ao atualizar.' });
  }
});

app.delete('/api/returns/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = await query('DELETE FROM devolucoes WHERE id=$1 RETURNING id', [id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Registro não encontrado.' });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/returns/:id ERRO:', e);
    res.status(400).json({ error: 'Falha ao excluir.' });
  }
});

app.get('/api/lojas', async (_req, res) => {
  try {
    const { rows } = await query(`select id, nome, updated_at from lojas_bling order by id asc`);
    res.json(rows);
  } catch (e) {
    console.error('GET /api/lojas ERRO:', e);
    res.status(500).json({ error: 'Falha ao listar lojas.' });
  }
});

app.post('/api/lojas', async (req, res) => {
  try {
    const { id, nome } = req.body;
    if (!id || !nome) return res.status(400).json({ error: 'Informe id e nome.' });

    await query(
      `insert into lojas_bling (id, nome)
       values ($1, $2)
       on conflict (id) do update set nome = excluded.nome, updated_at = now()`,
      [id, nome]
    );

    res.status(201).json({ ok: true, id, nome });
  } catch (e) {
    console.error('POST /api/lojas ERRO:', e);
    res.status(500).json({ error: 'Falha ao salvar loja.' });
  }
});

// ---------------------------------------------
// Start
// ---------------------------------------------
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
});
