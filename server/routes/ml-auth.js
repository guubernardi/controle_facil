'use strict';

const express = require('express');
const axios = require('axios');
const dayjs = require('dayjs');
const cookieParser = require('cookie-parser');

// Importa o cliente como módulo (suporta single ou multi-contas)
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

  // ---------- helpers UI ----------
  const escapeHtml = (s = '') =>
    String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function renderAuthResult({
    ok, title, message, detailsHTML = '',
    redirectTo = '/settings/config.html#integracoes',
    autoDelayMs = ok ? 2500 : 5000
  }) {
    return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${ok ? 'Conectado' : 'Erro'} - Controle Fácil</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root {
  /* Brand azul @usecontrolefacil */
  --primary: #0056D2;
  --primary-dark: #0042A6;
  --primary-light: #E6F0FF;
  
  /* Feedback */
  --success: #22c55e;
  --warning: #f59e0b;
  --danger: #ef4444;
  
  /* Tipografia */
  --text-primary: #1E293B;
  --text-secondary: #475569;
  --text-muted: #94a3b8;
  
  /* Superfícies e bordas */
  --bg-page: #F8FAFC;
  --bg-card: #FFFFFF;
  --border: #E5E7EB;
  
  /* Sombras */
  --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
  --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
  
  /* Raios */
  --radius: 12px;
  --radius-sm: 8px;
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html, body {
  height: 100%;
}

body {
  font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
  background: var(--bg-page);
  color: var(--text-primary);
  display: grid;
  place-items: center;
  padding: 24px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

.card {
  width: min(540px, 100%);
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 40px;
  box-shadow: var(--shadow-lg);
  animation: fadeIn 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}

.head {
  display: flex;
  gap: 16px;
  align-items: center;
  margin-bottom: 12px;
}

.icon {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  background: ${ok ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)'};
  color: ${ok ? 'var(--success)' : 'var(--danger)'};
  animation: scaleIn 0.5s cubic-bezier(0.16, 1, 0.3, 1) 0.1s backwards;
}

h1 {
  font-size: 1.5rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text-primary);
  line-height: 1.3;
}

.msg {
  color: var(--text-secondary);
  font-size: 0.9375rem;
  margin: 0 0 20px 0;
  line-height: 1.6;
}

.content {
  color: var(--text-secondary);
  font-size: 0.9375rem;
  line-height: 1.7;
  margin: 16px 0;
}

.content p {
  margin: 12px 0;
}

.content strong {
  color: var(--text-primary);
  font-weight: 600;
}

.actions {
  display: flex;
  gap: 12px;
  margin-top: 24px;
  flex-wrap: wrap;
}

a.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  text-decoration: none;
  border-radius: var(--radius-sm);
  padding: 12px 20px;
  border: 1px solid var(--border);
  background: var(--bg-card);
  color: var(--text-primary);
  font-weight: 600;
  font-size: 0.9375rem;
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  cursor: pointer;
  white-space: nowrap;
}

a.btn:hover {
  background: var(--bg-page);
  border-color: var(--text-muted);
  transform: translateY(-1px);
  box-shadow: var(--shadow-sm);
}

a.btn:active {
  transform: translateY(0);
}

a.btn.primary {
  background: var(--primary);
  color: #ffffff;
  border-color: var(--primary);
  box-shadow: var(--shadow-sm);
}

a.btn.primary:hover {
  background: var(--primary-dark);
  border-color: var(--primary-dark);
  box-shadow: var(--shadow-md);
}

small.hint {
  display: block;
  color: var(--text-muted);
  font-size: 0.875rem;
  margin-top: 16px;
  line-height: 1.5;
}

code, pre {
  background: var(--primary-light);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 12px 16px;
  display: block;
  overflow: auto;
  font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
  font-size: 0.875rem;
  color: var(--text-primary);
  line-height: 1.6;
}

code {
  display: inline;
  padding: 2px 6px;
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(12px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes scaleIn {
  from {
    opacity: 0;
    transform: scale(0.8);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

/* Responsividade */
@media (max-width: 640px) {
  .card {
    padding: 28px 24px;
  }
  
  h1 {
    font-size: 1.25rem;
  }
  
  .icon {
    width: 40px;
    height: 40px;
  }
  
  .actions {
    flex-direction: column;
  }
  
  a.btn {
    width: 100%;
  }
}
</style>
${redirectTo ? `<script>setTimeout(function(){location.href=${JSON.stringify(redirectTo)};}, ${autoDelayMs});</script>` : ''}
</head>
<body>
<main class="card" role="status" aria-live="polite">
  <div class="head">
    <div class="icon" aria-hidden="true">
      ${ok ? '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>' :
              '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>'}
    </div>
    <h1>${escapeHtml(title)}</h1>
  </div>
  <p class="msg">${ok ? 'Tokens salvos com sucesso. Você já pode usar as rotas protegidas.' : 'Não foi possível concluir a conexão. Verifique as credenciais.'}</p>
  <div class="content">${message || ''}${detailsHTML || ''}</div>
  <div class="actions">
    ${redirectTo ? `<a class="btn primary" href="${redirectTo}">Voltar às integrações</a>` : ''}
    <a class="btn" href="/index.html">Ir para Devoluções</a>
  </div>
  <small class="hint">${ok ? 'Você será redirecionado automaticamente em instantes…' : 'Revise as credenciais e tente novamente.'}</small>
</main>
</body>
</html>
`; }

  // ---------- LOGIN ----------
  app.get('/auth/ml/login', (req, res) => {
    try {
      if (!CLIENT_ID) {
        return res.status(500).send(renderAuthResult({
          ok: false,
          title: 'Configuração incompleta',
          message: '<p>Variável <code>ML_CLIENT_ID</code> não configurada.</p>',
        }));
      }
      const redirectUri = STATIC_REDIRECT_URI || `${req.protocol}://${req.get('host')}/auth/ml/callback`;
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
      }));
    }
  });

  // ---------- CALLBACK (code -> tokens) ----------
  app.get('/auth/ml/callback', async (req, res) => {
    try {
      const { code, state, error, error_description } = req.query || {};
      if (error) {
        return res.status(400).send(renderAuthResult({
          ok: false,
          title: 'Falha ao conectar',
          message: `<p><strong>Erro:</strong> ${escapeHtml(error)} ${error_description ? '– ' + escapeHtml(error_description) : ''}</p>`,
        }));
      }
      if (!code) {
        return res.status(400).send(renderAuthResult({
          ok: false,
          title: 'Código ausente',
          message: '<p>O Mercado Livre não retornou o parâmetro <code>code</code>.</p>',
        }));
      }

      const cookieState = req.cookies.ml_state;
      res.clearCookie('ml_state');
      if (!state || !cookieState || state !== cookieState) {
        return res.status(400).send(renderAuthResult({
          ok: false,
          title: 'State inválido',
          message: '<p>A validação de segurança falhou. Abra o fluxo novamente pela página de Integrações.</p>',
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

      await ml.saveAccount(acc);

      return res.send(renderAuthResult({
        ok: true,
        title: 'Conectado ao Mercado Livre',
        message: `<p>Conta: <strong>${escapeHtml(acc.nickname)}</strong> <small>(user_id ${escapeHtml(String(acc.user_id))})</small></p>`,
        detailsHTML: '<p>Tokens salvos com sucesso.</p>',
      }));
    } catch (e) {
      console.error('[ml-auth] callback error', e?.response?.data || e);
      return res.status(500).send(renderAuthResult({
        ok: false,
        title: 'Erro inesperado no OAuth',
        message: '<p>Ocorreu um erro ao concluir a conexão.</p>',
        detailsHTML: `<pre>${escapeHtml(String(e?.response?.data || e.message || e))}</pre>`,
      }));
    }
  });

  // ---------- Iniciar via API (opcional) ----------
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

  // ---------- Exchange via API (opcional) ----------
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

      await ml.saveAccount(acc);
      res.json({ ok: true, account: { user_id: acc.user_id, nickname: acc.nickname } });
    } catch (e) {
      console.error('[ml-auth] exchange error', e?.response?.data || e);
      res.status(500).json({ ok: false, error: 'Falha ao trocar o code por tokens' });
    }
  });

  // ---------- Status ----------
  app.get('/api/ml/status', async (_req, res) => {
    try {
      const accRaw = ml.loadAccount ? await ml.loadAccount() : null;
      if (!accRaw || !accRaw.access_token) return res.json({ connected: false });

      const { account } = await ml.getAuthedAxios(); // força refresh se expirado
      return res.json({
        connected: true,
        nickname: account.nickname,
        user_id: account.user_id,
        expires_at: account.expires_at
      });
    } catch {
      return res.json({ connected: false, error: 'not_connected' });
    }
  });

  // ---------- Listar contas (multi-contas com fallback) ----------
  app.get('/api/ml/accounts', async (_req, res) => {
    try {
      if (typeof ml.listAccounts === 'function') {
        const items = await ml.listAccounts();
        const active = typeof ml.getActiveUserId === 'function'
          ? await ml.getActiveUserId()
          : (ml.loadAccount ? (await ml.loadAccount())?.user_id : null);
        return res.json({
          items: (items || []).map(a => ({
            user_id: a.user_id, nickname: a.nickname, expires_at: a.expires_at
          })),
          active_user_id: active || null
        });
      }
      // Fallback: single-account
      const a = ml.loadAccount ? await ml.loadAccount() : null;
      return res.json({
        items: a ? [{ user_id: a.user_id, nickname: a.nickname, expires_at: a.expires_at }] : [],
        active_user_id: a?.user_id || null
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ---------- Definir ativa ----------
  app.post('/api/ml/active', async (req, res) => {
    try {
      const { user_id } = req.body || {};
      if (!user_id) return res.status(400).json({ ok: false, error: 'user_id vazio' });

      if (typeof ml.setActive === 'function') {
        await ml.setActive(user_id);
        return res.json({ ok: true });
      }
      return res.status(501).json({ ok: false, error: 'multi-contas não habilitado' });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ---------- Desconectar (uma ou todas) ----------
  app.post('/api/ml/disconnect', async (req, res) => {
    try {
      const { user_id } = req.body || {};
      if (user_id && typeof ml.removeAccount === 'function') {
        await ml.removeAccount(user_id);
        return res.json({ ok: true });
      }
      await ml.saveAccount({}); // single-account fallback
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ---------- Teste: /api/ml/me ----------
  app.get('/api/ml/me', async (req, res) => {
    try {
      const user_id = req.query.user_id ? String(req.query.user_id) : undefined;
      const { http, account } = await ml.getAuthedAxios(user_id);
      const me = await http.get('/users/me');
      res.json({ ok: true, account: { user_id: account.user_id, nickname: account.nickname }, me: me.data });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.response?.data || e.message || e) });
    }
  });
};
