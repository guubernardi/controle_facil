// imports e configuração inicial
require('dotenv').config();
const express = require('express');
const path = require('path');
const axios = require('axios');
const dayjs = require('dayjs');
const { query } = require('./db');

// app e middlewares
const app = express();
app.use(express.json()); // parse JSON
app.use(express.static(path.join(__dirname, '..', 'public'))); // serve /public

// Ping ao banco
app.get('/api/db/ping', async (_req, res) => {
  try {
    const r = await query('select now() as now');
    res.json({ ok: true, now: r.rows[0].now });
  } catch (e) {
    console.error('DB PING ERRO:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Monta o cabeçalho "Basic <base64(client_id:client_secret)>" exigido pelo Bling
function cabecalhoBasicAuth() {
  const cru = `${process.env.BLING_CLIENT_ID}:${process.env.BLING_CLIENT_SECRET}`;
  const base64 = Buffer.from(cru).toString('base64');
  return `Basic ${base64}`;
}


// Salva os tokens no banco e retorna o registro salvo
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



// Rotas
/**
 * GET /api/health

* Objetivo: rota de "diagnóstico" para sabermos se o servidor está vivo.

* Retorna um JSON simples com { ok: true, time: ... }.

*/

// Rotas para OAuth com Bling

// /auth/bling: redireciona para a tela de autorização do Bling
app.get('/auth/bling', (req, res) => {

    // apelido só para a gente carregar depois
  const apelido = String(req.query.account || 'Conta de Teste');

  // URL de autorização
  const url = new URL(process.env.BLING_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', process.env.BLING_CLIENT_ID);

  // usamos o apelido dentro do state só pra validar ida/volta (simples por enquanto)
  url.searchParams.set('state', encodeURIComponent(apelido));

  return res.redirect(url.toString());
});

// Lista o cache de lojas
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

// Upsert de uma loja no cache: { id: number, nome: string }
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


// /callback: só mostra o que voltou (code/state) para validar o fluxo
app.get('/callback', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;
    if (error) return res.status(400).send(`<h3>Erro</h3><pre>${error}: ${error_description||''}</pre>`);
    if (!code) return res.status(400).send('Faltou o "code".');

    const apelido = decodeURIComponent(state || 'Conta de Teste');

    // Troca code → tokens no Bling
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

// Busca o token mais recente (de qualquer conta) 
async function pegarTokenMaisRecente(apelido) {
  const { rows } = await query(
    `select access_token from bling_accounts
     where apelido = $1
     order by id desc
     limit 1`,
    [apelido]
  );
  if (!rows[0]) throw new Error('Nenhum token encontrado. Autorize a conta primeiro.');
  return rows[0].access_token;
}

// Busca uma venda por ID interno OU pelo número visível no Bling.
// Retorna: { idVenda, numeroPedido, lojaId, lojaNome, numeroLoja, debug }
async function handlerBuscarVenda(req, res) {
  try {
    const idOuNumero = String(req.params.id);
    const apelido = String(req.query.account || 'Conta de Teste');

    const base = process.env.BLING_API_BASE;

    // helper GET com retry (se houver refreshAccessToken disponível)
    const getWithRetry = async (url) => {
      let token = await pegarTokenMaisRecente(apelido);
      const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

      try {
        const r = await axios.get(url, { headers, timeout: 15000 });
        return r.data;
      } catch (e) {
        const st = e?.response?.status;
        const msg = e?.response?.data;
        const precisaRefresh = st === 401 || (msg && String(msg).includes('invalid_token'));

        if (precisaRefresh && typeof refreshAccessToken === 'function') {
          token = await refreshAccessToken(apelido);
          const r2 = await axios.get(url, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            timeout: 15000
          });
          return r2.data;
        }
        throw e;
      }
    };

    // 1) Tenta como ID interno
    let pedido = null;
    try {
      const d1 = await getWithRetry(`${base}/pedidos/vendas/${encodeURIComponent(idOuNumero)}`);
      pedido = d1?.data || null;
    } catch (e1) {
      if (e1?.response?.status && e1.response.status !== 404) {
        console.error('Erro consultando por ID interno:', e1?.response?.data || e1);
      }
    }

    // 2) Se não achou por ID, tenta pelo número (UI)
    if (!pedido) {
      try {
        const d2 = await getWithRetry(`${base}/pedidos/vendas?numero=${encodeURIComponent(idOuNumero)}`);
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

    // Extrai campos relevantes
    const lojaId     = pedido?.loja?.id ?? null;
    const numeroLoja = pedido?.numeroLoja ?? '';
    const numero     = pedido?.numero ?? null;

    // 3) Resolve nome da loja (ordem: dado do pedido → lookup → heurística → fallbacks)
    let lojaNome = pedido?.loja?.nome || pedido?.loja?.descricao || null;

    if (!lojaNome && lojaId !== null) {
      // tenta cache/API de lojas (usa sua função existente)
      lojaNome = await pegarNomeLojaPorId(await pegarTokenMaisRecente(apelido), lojaId);
    }

    if (!lojaNome) {
      const s = String(numeroLoja || '').toUpperCase();
      if (s.startsWith('MLB') || s.includes('MERCADO LIVRE')) lojaNome = 'Mercado Livre';
      else if (s.includes('RLD')) lojaNome = 'Mercado Livre RLD';
      else if (s.includes('MAG') || s.includes('MAGALU')) lojaNome = 'Magazine Luiza';
      else if (s.includes('SHOPEE') || s.startsWith('SHP')) lojaNome = 'Shopee';
    }

    if (!lojaNome && (lojaId === 0 || lojaId === null)) lojaNome = 'Pedido manual (sem loja)';
    if (!lojaNome && lojaId) lojaNome = `Loja #${lojaId}`;

    // Resposta
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

// Tenta pegar nome da loja por ID usando cache local (tabela lojas_bling) e, se não tiver, consulta a API do Bling e salva no cache.
async function pegarNomeLojaPorId(token, lojaId) {
  if (lojaId === null || lojaId === undefined) return null;

  // 1) cache local
  const cache = await query('select nome from lojas_bling where id = $1', [lojaId]);
  if (cache.rows[0]?.nome) return cache.rows[0].nome;

  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  const base = process.env.BLING_API_BASE;

  // tenta endpoint direto
  try {
    const { data } = await axios.get(`${base}/lojas/${encodeURIComponent(lojaId)}`, { headers, timeout: 10000 });
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

  // 2) fallback: varre páginas da listagem
  for (let pagina = 1; pagina <= 5; pagina++) {
    try {
      const url = `${base}/lojas?pagina=${pagina}&limite=100`;
      const { data } = await axios.get(url, { headers, timeout: 10000 });
      const arr = Array.isArray(data?.data) ? data.data : [];
      const item = arr.find(x => String(x.id) === String(lojaId));
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
      console.warn('[LOJA LOOKUP] listagem status:',
        err?.response?.status, 'payload:', err?.response?.data || err.message);
      break;
    }
  }

  return null; // volta fallback "Loja #ID"
}

async function refreshAccessToken(apelido) {
  // pega o refresh_token mais recente
  const r1 = await query(
    `select id, refresh_token from bling_accounts
     where apelido=$1 order by id desc limit 1`, [apelido]
  );
  if (!r1.rows[0]) throw new Error('Sem refresh_token para atualizar.');
  const refresh_token = r1.rows[0].refresh_token;

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

  // salva novo token
  await salvarTokens({
    apelido,
    access_token: data.access_token,
    refresh_token: data.refresh_token || refresh_token, // às vezes o refresh repete
    expires_in: data.expires_in
  });

  return data.access_token;
}

// helper: faz request com retry automático em caso de 401
async function blingGet(apelido, url) {
  let token = await pegarTokenMaisRecente(apelido);
  try {
    const r = await axios.get(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }});
    return r.data;
  } catch (e) {
    const st = e?.response?.status;
    const msg = e?.response?.data;
    if (st === 401 || (msg && String(msg).includes('invalid_token'))) {
      token = await refreshAccessToken(apelido);
      const r2 = await axios.get(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }});
      return r2.data;
    }
    throw e;
  }
}


app.get('/api/sales/:id', handlerBuscarVenda);
app.get('/api/vendas/:id', handlerBuscarVenda);

// Objetivo: receber os dados do formulário e gravar na tabela `devolucoes`.
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

// GET /api/returns?limit=50
app.get('/api/returns', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const { rows } = await query(
      `select id, data_compra, id_venda, loja_nome, sku, tipo_reclamacao, status, valor_produto, valor_frete, created_at
         from devolucoes
        order by id desc
        limit $1`, [limit]
    );
    return res.json(rows);
  } catch (e) {
    console.error('GET /api/returns ERRO:', e);
    return res.status(400).json({ error: 'Falha ao listar devoluções.' });
  }
});

app.get('/api/health', (req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
});

// Inicia o servidor
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
});