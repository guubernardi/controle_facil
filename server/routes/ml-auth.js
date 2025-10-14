'use strict';

const express = require('express');
const axios = require('axios');
const dayjs = require('dayjs');
const cookieParser = require('cookie-parser');

// Funções do cliente ML (suporta multi-contas)
const ml = require('../mlClient');

const ML_AUTH_URL  = process.env.ML_AUTH_URL  || 'https://auth.mercadolivre.com.br/authorization';
const ML_TOKEN_URL = process.env.ML_TOKEN_URL || 'https://api.mercadolibre.com/oauth/token';
const ML_BASE      = process.env.ML_BASE_URL  || 'https://api.mercadolibre.com';

module.exports = function registerMlAuth(app) {
  const CLIENT_ID     = process.env.ML_CLIENT_ID;
  const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
  const STATIC_REDIRECT_URI = process.env.ML_REDIRECT_URI; // se não houver, calculamos no /login

  app.use(cookieParser());
  app.use(express.json());

  // -----------------------------
  // helpers para a página 
  // -----------------------------
  function escapeHtml(s = '') {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function renderAuthResult({
    ok,
    title,
    message,          // HTML curto
    detailsHTML = '', // HTML (debug)
    redirectTo = '/settings/config.html#integracoes',
    autoDelayMs = ok ? 2500 : 5000
  }) {
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${ok ? 'Conectado' : 'Erro'} · Retorno Fácil</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    :root{--fg:#0f172a;--muted:#64748b;--border:#e2e8f0;--bg:#f8fafc;--primary:#2563eb;--ok:#16a34a;--err:#dc2626;}
    *{box-sizing:border-box} html,body{height:100%}
    body{margin:0;font-family:Inter,system-ui,Segoe UI,Roboto,Arial,sans-serif;background:var(--bg);color:var(--fg);display:grid;place-items:center;padding:24px}
    .card{width:min(740px,92vw);background:#fff;border:1px solid var(--border);border-radius:16px;padding:28px;box-shadow:0 10px 24px rgba(2,6,23,.06);animation:fade .35s ease}
    .head{display:flex;gap:14px;align-items:center;margin-bottom:10px}
    .icon{width:36px;height:36px;border-radius:999px;display:grid;place-items:center;background:${ok ? 'rgba(22,163,74,.1)' : 'rgba(220,38,38,.1)'};color:${ok ? 'var(--ok)' : 'var(--err)'}}
    h1{font-size:1.35rem;margin:0;letter-spacing:-.01em}
    .msg{color:var(--muted);margin:.25rem 0 1rem}
    .content{line-height:1.65}
    .content p{margin:.5rem 0}
    .actions{display:flex;gap:10px;margin-top:18px;flex-wrap:wrap}
    a.btn{display:inline-flex;align-items:center;gap:.5rem;text-decoration:none;border-radius:10px;padding:.625rem 1rem;border:1px solid var(--border);background:#fff;color:var(--fg);font-weight:600}
    a.btn.primary{background:var(--primary);color:#fff;border-color:var(--primary)}
    small.hint{display:block;color:var(--muted);margin-top:10px}
    code,pre{background:#0f172a0d;border:1px solid var(--border);border-radius:10px;padding:10px;display:block;overflow:auto}
    @keyframes fade{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
  </style>
  ${redirectTo ? `<script>setTimeout(function(){location.href=${JSON.stringify(redirectTo)};}, ${autoDelayMs});</script>` : ''}
</head>
<body>
  <main class="card" role="status" aria-live="polite">
    <div class="head">
      <div class="icon" aria-hidden="true">
        ${ok ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.2l-3.5-3.5-1.4 1.4L9 19 20 8l-1.4-1.4z"/></svg>' :
                '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1010 10A10.011 10.011 0 0012 2zm1 15h-2v-2h2zm0-4h-2V7h2z"/></svg>'}
      </div>
      <h1>${escapeHtml(title)}</h1>
    </div>
    <p class="msg">${ok ? 'Tokens salvos. Você já pode usar as rotas protegidas.' : 'Não foi possível concluir a conexão.'}</p>
    <div class="content">${message || ''}${detailsHTML || ''}</div>
    <div class="actions">
      ${redirectTo ? `<a class="btn primary" href="${redirectTo}">Voltar às integrações</a>` : ''}
      <a class="btn" href="/index.html">Ir para Devoluções</a>
    </div>
    <small class="hint">${ok ? 'Você será redirecionado em instantes…' : 'Revise as credenciais e tente novamente.'}</small>
  </main>
</body>
</html>`;
  }

  // ================= LOGIN =================
  app.get('/auth/ml/login', (req, res) => {
    try {
      if (!CLIENT_ID) {
        return res
          .status(500)
          .send(renderAuthResult({
            ok: false,
            title: 'Configuração incompleta',
            message: '<p>Variável <code>ML_CLIENT_ID</code> não configurada.</p>',
            redirectTo: '/settings/config.html#integracoes'
          }));
      }

      // Se não tiver REDIRECT_URI fixo, calcula com base no host atual
      const redirectUri =
        STATIC_REDIRECT_URI ||
        `${req.protocol}://${req.get('host')}/auth/ml/callback`;

      const state = 'rf_' + Math.random().toString(36).slice(2, 10);
      res.cookie('ml_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });

      const url = new URL(ML_AUTH_URL);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', CLIENT_ID);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', state);

      res.redirect(url.toString());
    } catch (err) {
      res.status(500).send(renderAuthResult({
        ok: false,
        title: 'Erro ao iniciar OAuth',
        message: `<pre>${escapeHtml(String(err?.message || err))}</pre>`,
        redirectTo: '/settings/config.html#integracoes'
      }));
    }
  });

  // ======= CALLBACK (troca code → tokens) =======
  app.get('/auth/ml/callback', async (req, res) => {
    try {
      const { code, state, error, error_description } = req.query || {};

      if (error) {
        return res.status(400).send(renderAuthResult({
          ok: false,
          title: 'Falha ao conectar',
          message: `<p><strong>Erro:</strong> ${escapeHtml(error)} ${error_description ? '– ' + escapeHtml(error_description) : ''}</p>`,
          redirectTo: '/settings/config.html#integracoes'
        }));
      }
      if (!code) {
        return res.status(400).send(renderAuthResult({
          ok: false,
          title: 'Código ausente',
          message: '<p>O Mercado Livre não retornou o parâmetro <code>code</code>.</p>',
          redirectTo: '/settings/config.html#integracoes'
        }));
      }

      // valida CSRF (state via cookie)
      const cookieState = req.cookies.ml_state;
      res.clearCookie('ml_state');
      if (!state || !cookieState || state !== cookieState) {
        return res.status(400).send(renderAuthResult({
          ok: false,
          title: 'State inválido',
          message: '<p>A validação de segurança falhou. Abra o fluxo novamente pela página de Integrações.</p>',
          redirectTo: '/settings/config.html#integracoes'
        }));
      }

      const redirectUri = STATIC_REDIRECT_URI || `${req.protocol}://${req.get('host')}/auth/ml/callback`;

      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: redirectUri
      });

      const { data } = await axios.post(ML_TOKEN_URL, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000
      });

      const me = await axios.get(`${ML_BASE}/users/me`, {
        headers: { Authorization: `Bearer ${data.access_token}` },
        timeout: 15000
      });

      const acc = {
        user_id: me.data.id,
        nickname: me.data.nickname,
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        scope: data.scope,
        token_type: data.token_type,
        expires_at: dayjs().add(data.expires_in || 600, 'seconds').toISOString()
      };

      await saveAccount(acc);

      return res.send(renderAuthResult({
        ok: true,
        title: 'Conectado ao Mercado Livre',
        message: `<p>Conta: <strong>${escapeHtml(acc.nickname)}</strong> <small>(user_id ${escapeHtml(String(acc.user_id))})</small></p>`,
        detailsHTML: '<p>Tokens salvos com sucesso.</p>',
        redirectTo: '/settings/config.html#integracoes'
      }));
    } catch (e) {
      console.error('[ml-auth] callback error', e?.response?.data || e);
      return res.status(500).send(renderAuthResult({
        ok: false,
        title: 'Erro inesperado no OAuth',
        message: '<p>Ocorreu um erro ao concluir a conexão.</p>',
        detailsHTML: `<pre>${escapeHtml(String(e?.response?.data || e.message || e))}</pre>`,
        redirectTo: '/settings/config.html#integracoes'
      }));
    }
  });

  // ======== Fluxo opcional por API (iniciar via fetch no front) ========
  app.get('/api/ml/auth', (req, res) => {
    const redirectUri = STATIC_REDIRECT_URI || `${req.protocol}://${req.get('host')}/auth/ml/callback`;
    const state = 'rf_' + Math.random().toString(36).slice(2, 10);
    res.cookie('ml_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });

    const url = new URL(ML_AUTH_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);

    res.json({ url: url.toString() });
  });

  // (mantido) troca via POST — útil se você capturar o "code" em SPA
  app.post('/api/ml/auth/exchange', async (req, res) => {
    try {
      const { code } = req.body || {};
      if (!code) return res.status(400).json({ ok: false, error: 'code vazio' });

      const redirectUri = STATIC_REDIRECT_URI || `${req.protocol}://${req.get('host')}/auth/ml/callback`;

      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: redirectUri
      });

      const { data } = await axios.post(ML_TOKEN_URL, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000
      });

      const me = await axios.get(`${ML_BASE}/users/me`, {
        headers: { Authorization: `Bearer ${data.access_token}` },
        timeout: 15000
      });

      const acc = {
        user_id: me.data.id,
        nickname: me.data.nickname,
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        scope: data.scope,
        token_type: data.token_type,
        expires_at: dayjs().add(data.expires_in || 600, 'seconds').toISOString()
      };

      await saveAccount(acc);
      res.json({ ok: true, account: { user_id: acc.user_id, nickname: acc.nickname } });
    } catch (e) {
      console.error('[ml-auth] exchange error', e?.response?.data || e);
      res.status(500).json({ ok: false, error: 'Falha ao trocar o code por tokens' });
    }
  });

  // ========= Status para a UI (tenta refresh se necessário) =========
  app.get('/api/ml/status', async (_req, res) => {
    try {
      const accRaw = await loadAccount();
      if (!accRaw || !accRaw.access_token) return res.json({ connected: false });

      const { account } = await getAuthedAxios(); // força refresh se expirado
      return res.json({
        connected: true,
        nickname: account.nickname,
        user_id: account.user_id,
        expires_at: account.expires_at
      });
    } catch (_e) {
      return res.json({ connected: false, error: 'not_connected' });
    }
  });

  // ========= Multi-contas: listar / definir ativa / remover =========
  app.get('/api/ml/accounts', async (_req, res) => {
    try {
      const items = await listAccounts();
      const active = await getActiveUserId();
      return res.json({
        items: items.map(a => ({
          user_id: a.user_id,
          nickname: a.nickname,
          expires_at: a.expires_at
        })),
        active_user_id: active || null
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post('/api/ml/active', async (req, res) => {
    try {
      const { user_id } = req.body || {};
      if (!user_id) return res.status(400).json({ ok: false, error: 'user_id vazio' });
      const acc = await setActive(user_id);
      res.json({ ok: true, active_user_id: String(acc.user_id) });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // Remover uma conta específica (alias útil para UI)
  app.delete('/api/ml/accounts/:user_id', async (req, res) => {
    try {
      await removeAccount(req.params.user_id);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ========= Desconectar (limpa ativa ou remove uma específica) =========
  app.post('/api/ml/disconnect', async (req, res) => {
    try {
      const { user_id } = req.body || {};
      if (user_id) {
        await removeAccount(user_id);
      } else {
        await saveAccount({}); // modo single: limpa arquivo
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ========= Teste: quem sou eu =========
  app.get('/api/ml/me', async (req, res) => {
    try {
      const userId = req.query.user_id ? String(req.query.user_id) : undefined; // opcional
      const { http, account } = await getAuthedAxios(userId);
      const me = await http.get('/users/me');
      res.json({ ok: true, account: { user_id: account.user_id, nickname: account.nickname }, me: me.data });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.response?.data || e.message || e) });
    }
  });
};
