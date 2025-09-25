// ---------------------------------------------
// server/server.js
// API de Devoluções + Bling OAuth/consulta
// ---------------------------------------------

// Carrega variáveis de ambiente (.env)
require('dotenv').config();

// Deps gerais
const express = require('express');
const path = require('path');
const axios = require('axios');
const dayjs = require('dayjs');

// DB helper (usa pool configurado em ./db)
const { query } = require('./db');

// ----------------------------------------------------------------------------
// App e middlewares
// ----------------------------------------------------------------------------
const app = express();

// Parse de JSON no body
app.use(express.json());

// Serve arquivos estáticos do frontend (pasta /public)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Aviso básico caso o .env esteja faltando alguma variável crítica
['BLING_AUTHORIZE_URL','BLING_TOKEN_URL','BLING_API_BASE','BLING_CLIENT_ID','BLING_CLIENT_SECRET','BLING_REDIRECT_URI']
  .forEach(k => {
    if (!process.env[k]) {
      console.warn(`[WARN] .env faltando ${k}`);
    }
  });

// ----------------------------------------------------------------------------
// Health + Ping DB (diagnóstico rápido)
// ----------------------------------------------------------------------------
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

// ----------------------------------------------------------------------------
// Helpers de OAuth/REST do Bling
// ----------------------------------------------------------------------------

// Monta o header Basic requerido pelo endpoint de token do Bling
function cabecalhoBasicAuth() {
  const cru = `${process.env.BLING_CLIENT_ID}:${process.env.BLING_CLIENT_SECRET}`;
  const base64 = Buffer.from(cru).toString('base64');
  return `Basic ${base64}`;
}

// Salva tokens no banco e retorna o registro inserido
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

// Pega um access_token válido; se estiver quase expirando, renova pelo refresh_token
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
  const margemMs = 120 * 1000; // 2 min de margem de segurança

  // Se ainda tem validade suficiente, tranquilo
  if (expiraMs > margemMs) return t.access_token;

  // Senão, renova usando o refresh_token mais recente
  return await refreshAccessToken(apelido, t.refresh_token);
}

// Renova o access_token usando refresh_token (salva o novo no banco)
async function refreshAccessToken(apelido, refresh_token) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token
  });

  const { data } = await axios.post(process.env.BLING_TOKEN_URL, body.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': '1.0',
      'Authorization': cabecalhoBasicAuth()
    },
    timeout: 15000
  });

  // Salva o token novo (às vezes o refresh_token vem igual)
  await salvarTokens({
    apelido,
    access_token: data.access_token,
    refresh_token: data.refresh_token || refresh_token,
    expires_in: data.expires_in
  });

  return data.access_token;
}

// GET no Bling com token válido.
// Se tomar 401/invalid_token, a gente força um refresh real e tenta de novo.
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

    // Força refresh usando o refresh_token mais recente
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

// ----------------------------------------------------------------------------
// Lookup de loja por ID (com cache local + fallback listagem)
// ----------------------------------------------------------------------------

// Busca nome da loja pelo ID: primeiro no cache, depois tenta a API,
// e por fim varre algumas páginas da listagem se o endpoint direto não existir.
async function pegarNomeLojaPorId(apelido, lojaId) {
  if (lojaId === null || lojaId === undefined) return null;

  // 1) cache local
  const cache = await query('select nome from lojas_bling where id = $1', [lojaId]);
  if (cache.rows[0]?.nome) return cache.rows[0].nome;

  const base = process.env.BLING_API_BASE;

  // 2) tenta endpoint direto
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

  // 3) fallback: varre as primeiras páginas da listagem
  for (let pagina = 1; pagina <= 5; pagina++) {
    try {
      const data = await blingGet(apelido, `${base}/lojas?pagina=${pagina}&limite=100`);
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
      if (arr.length < 100) break; // acabou as páginas
    } catch (err) {
      console.warn(
        '[LOJA LOOKUP] listagem status:',
        err?.response?.status,
        'payload:',
        err?.response?.data || err.message
      );
      break;
    }
  }

  return null; // sem nome → handler aplica fallback “Loja #ID”
}

// Heurística: tenta deduzir marketplace com base no numeroLoja
function deduzirNomeLojaPelosPadroes(numeroLoja, sugestaoAtual = null) {
  if (sugestaoAtual) return sugestaoAtual;
  const s = String(numeroLoja || '').toUpperCase().trim();
  if (!s) return null;

  // Ordem do mais específico pro mais genérico
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

// ----------------------------------------------------------------------------
// OAuth Bling: authorize + callback
// ----------------------------------------------------------------------------

// Redireciona para a tela de autorização do Bling
app.get('/auth/bling', (req, res) => {
  const apelido = String(req.query.account || 'Conta de Teste'); // identificador da conta
  const url = new URL(process.env.BLING_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', process.env.BLING_CLIENT_ID);
  url.searchParams.set('state', encodeURIComponent(apelido)); // vou e volto com esse state
  return res.redirect(url.toString());
});

// Callback do Bling: troca code -> tokens e salva
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

// ----------------------------------------------------------------------------
// Vendas (consulta no Bling por ID interno ou número visível)
// ----------------------------------------------------------------------------
async function handlerBuscarVenda(req, res) {
  try {
    const idOuNumero = String(req.params.id);
    const apelido = String(req.query.account || 'Conta de Teste');
    const base = process.env.BLING_API_BASE;

    // 1) tenta como ID interno
    let pedido = null;
    try {
      const d1 = await blingGet(apelido, `${base}/pedidos/vendas/${encodeURIComponent(idOuNumero)}`);
      pedido = d1?.data || null;
    } catch (e1) {
      if (e1?.response?.status && e1.response.status !== 404) {
        console.error('Erro consultando por ID interno:', e1?.response?.data || e1);
      }
    }

    // 2) se não achou por ID, tenta pelo número (UI)
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

    // 3) nome da loja: pedido → lookup por id → heurística → fallback
    let lojaNome = pedido?.loja?.nome || pedido?.loja?.descricao || null;

    if (!lojaNome && lojaId !== null) {
      lojaNome = await pegarNomeLojaPorId(apelido, lojaId);
    }

    lojaNome = deduzirNomeLojaPelosPadroes(numeroLoja, lojaNome);

    if (!lojaNome && (lojaId === 0 || lojaId === null)) lojaNome = 'Pedido manual (sem loja)';
    if (!lojaNome && lojaId) lojaNome = `Loja #${lojaId}`;

    return res.json({
      idVenda: String(pedido.id || idOuNumero),
      numeroPedido: numero,
      lojaId,
      lojaNome,
      numeroLoja,
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
// Devoluções (CRUD + Dashboard)
// ----------------------------------------------------------------------------

// Cria uma devolução
app.post('/api/returns', async (req, res) => {
  try {
    const {
      data_compra,
      id_venda,
      loja_id,
      loja_nome,
      sku,
      tipo_reclamacao,
      status,
      valor_produto,
      valor_frete,
      reclamacao,
      created_by
    } = req.body;

    const sql = `
      insert into devolucoes
        (data_compra, id_venda, loja_id, loja_nome, sku, tipo_reclamacao, status, valor_produto, valor_frete, reclamacao, created_by)
      values
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      returning id, created_at
    `;
    const params = [
      data_compra || null,
      id_venda,
      loja_id || null,
      loja_nome || null,
      sku || null,
      tipo_reclamacao || null,
      status || null,
      valor_produto || null,
      valor_frete || null,
      reclamacao || null,
      created_by || 'app-local'
    ];

    const { rows } = await query(sql, params);
    return res.status(201).json({ ok: true, id: rows[0].id, created_at: rows[0].created_at });
  } catch (e) {
    console.error('POST /api/returns ERRO:', e);
    return res.status(400).json({ ok: false, error: 'Falha ao salvar devolução.' });
  }
});

// Dashboard: totais, top SKUs e série diária (com filtro de datas)
app.get('/api/dashboard', async (req, res) => {
  try {
    const from = req.query.from ? new Date(req.query.from) : null;
    const to   = req.query.to   ? new Date(req.query.to)   : null;
    const limitTop = Math.max(1, Math.min(parseInt(req.query.limitTop || '5', 10), 20));

    // WHERE dinâmico por data (opcional)
    const whereParts = [];
    const params = [];
    if (from) { params.push(from); whereParts.push(`created_at >= $${params.length}`); }
    if (to)   { params.push(to);   whereParts.push(`created_at <  $${params.length}`); }
    const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

    // Totais + prejuízo
    const sqlTotals = `
      SELECT
        COUNT(*)::int                                     AS total,
        SUM( (COALESCE(valor_produto,0) + COALESCE(valor_frete,0)) )::numeric(12,2) AS prejuizo_total,
        SUM( CASE WHEN LOWER(status) LIKE '%pend%'     THEN 1 ELSE 0 END )::int AS pendentes,
        SUM( CASE WHEN LOWER(status) LIKE '%aprov%'    THEN 1 ELSE 0 END )::int AS aprovadas,
        SUM( CASE WHEN LOWER(status) LIKE '%rej%' OR LOWER(status) LIKE '%neg%' THEN 1 ELSE 0 END )::int AS rejeitadas
      FROM devolucoes
      ${where};
    `;

    // Ranking de SKUs
    const sqlTop = `
      SELECT
        COALESCE(NULLIF(TRIM(sku),''), '(sem SKU)') AS sku,
        COUNT(*)::int AS devolucoes,
        SUM( (COALESCE(valor_produto,0) + COALESCE(valor_frete,0)) )::numeric(12,2) AS prejuizo
      FROM devolucoes
      ${where}
      GROUP BY 1
      ORDER BY devolucoes DESC, sku ASC
      LIMIT $${params.push(limitTop)};
    `;

    // Série diária
    const sqlDaily = `
      SELECT
        DATE_TRUNC('day', created_at)::date AS dia,
        COUNT(*)::int AS devolucoes,
        SUM( (COALESCE(valor_produto,0) + COALESCE(valor_frete,0)) )::numeric(12,2) AS prejuizo
      FROM devolucoes
      ${where}
      GROUP BY 1
      ORDER BY 1 ASC;
    `;

    const [totalsQ, topQ, dailyQ] = await Promise.all([
      query(sqlTotals, params.slice(0, whereParts.length)),
      query(sqlTop, params),
      query(sqlDaily, params.slice(0, whereParts.length)),
    ]);

    return res.json({
      range: { from: from || null, to: to || null },
      totals: {
        total:        totalsQ.rows[0]?.total || 0,
        pendentes:    totalsQ.rows[0]?.pendentes || 0,
        aprovadas:    totalsQ.rows[0]?.aprovadas || 0,
        rejeitadas:   totalsQ.rows[0]?.rejeitadas || 0,
        prejuizo_total: totalsQ.rows[0]?.prejuizo_total || 0
      },
      top_items: topQ.rows, // [{ sku, devolucoes, prejuizo }]
      daily:     dailyQ.rows // [{ dia, devolucoes, prejuizo }]
    });
  } catch (e) {
    console.error('GET /api/dashboard ERRO:', e);
    res.status(500).json({ error: 'Falha ao montar dashboard.' });
  }
});

// Lista devoluções (paginada + filtros de busca e status)
// GET /api/returns?search=&status=&page=1&pageSize=20
app.get('/api/returns', async (req, res) => {
  try {
    const page     = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || '20', 10), 1), 100);
    const search   = (req.query.search || '').trim();
    const status   = (req.query.status || '').trim(); // 'pendente'|'aprovado'|'rejeitado'|''

    const where = [];
    const args  = [];

    if (status) {
      args.push(status);
      where.push(`status = $${args.length}`);
    }

    if (search) {
      args.push(`%${search}%`);
      where.push(`(coalesce(sku,'') ILIKE $${args.length}
               OR coalesce(loja_nome,'') ILIKE $${args.length}
               OR coalesce(nfe_numero,'') ILIKE $${args.length}
               OR coalesce(nfe_chave,'') ILIKE $${args.length}
               OR coalesce(reclamacao,'') ILIKE $${args.length})`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const off = (page - 1) * pageSize;

    const { rows } = await query(
      `SELECT id, data_compra, id_venda, loja_id, loja_nome, sku, tipo_reclamacao, status,
              valor_produto, valor_frete, nfe_numero, nfe_chave, created_at, updated_at
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

// Detalhe de uma devolução
app.get('/api/returns/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = await query(
      `SELECT id, data_compra, id_venda, loja_id, loja_nome, sku,
              tipo_reclamacao, status, valor_produto, valor_frete,
              reclamacao, nfe_numero, nfe_chave, created_at, updated_at
         FROM devolucoes
        WHERE id = $1`, [id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Registro não encontrado.' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(400).json({ error: 'Falha ao buscar registro.' });
  }
});

// Atualiza campos de uma devolução
app.patch('/api/returns/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'ID inválido.' });

    // Campos que aceitamos atualizar
    const allow = new Set([
      'status','loja_nome','sku','tipo_reclamacao','valor_produto','valor_frete',
      'reclamacao','nfe_numero','nfe_chave','data_compra'
    ]);

    const sets = [];
    const args = [];
    Object.entries(req.body || {}).forEach(([k, v]) => {
      if (allow.has(k)) {
        args.push(v);
        sets.push(`${k} = $${args.length}`);
      }
    });

    // Se quiser guardar quem atualizou
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
    res.json(r.rows[0]);
  } catch (e) {
    console.error('PATCH /api/returns/:id ERRO:', e);
    res.status(400).json({ error: 'Falha ao atualizar.' });
  }
});

// Exclui uma devolução
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

// ----------------------------------------------------------------------------
// Cache de lojas (CRUD mínimo pra preencher manualmente quando precisar)
// ----------------------------------------------------------------------------
app.get('/api/lojas', async (_req, res) => {
  try {
    const { rows } = await query(
      `select id, nome, updated_at from lojas_bling order by id asc`
    );
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

// ----------------------------------------------------------------------------
// Sobe o servidor
// ----------------------------------------------------------------------------
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
});
