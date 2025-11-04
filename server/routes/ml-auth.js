// server/routes/ml-auth.js
'use strict';

const express = require('express');
const axios = require('axios');
const dayjs = require('dayjs');
const cookieParser = require('cookie-parser');
const { query } = require('../db');
const ml = require('../mlClient'); // opcional/compat

const ML_AUTH_URL  = process.env.ML_AUTH_URL  || 'https://auth.mercadolivre.com.br/authorization';
const ML_TOKEN_URL = process.env.ML_TOKEN_URL || 'https://api.mercadolibre.com/oauth/token';
const ML_BASE      = process.env.ML_BASE_URL  || 'https://api.mercadolibre.com';
const AHEAD_SEC    = parseInt(process.env.ML_REFRESH_AHEAD_SEC || '600', 10) || 600; // 10min

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
<html lang="pt-BR"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${ok ? 'Conectado' : 'Erro'} - Controle Fácil</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--primary:#0056D2;--primary-dark:#0042A6;--primary-light:#E6F0FF;--success:#22c55e;--danger:#ef4444;--text-primary:#1E293B;--text-secondary:#475569;--text-muted:#94a3b8;--bg-page:#F8FAFC;--bg-card:#FFFFFF;--border:#E5E7EB;--shadow-sm:0 1px 2px rgba(0,0,0,.05);--shadow-lg:0 10px 15px -3px rgba(0,0,0,.1),0 4px 6px -2px rgba(0,0,0,.05);--radius:12px;--radius-sm:8px}
*{box-sizing:border-box;margin:0;padding:0}html,body{height:100%}
body{font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:var(--bg-page);color:var(--text-primary);display:grid;place-items:center;padding:24px;line-height:1.6;-webkit-font-smoothing:antialiased}
.card{width:min(540px,100%);background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:40px;box-shadow:var(--shadow-lg)}
.head{display:flex;gap:16px;align-items:center;margin-bottom:12px}
.icon{width:48px;height:48px;border-radius:50%;display:grid;place-items:center;flex-shrink:0;background:${ok ? 'rgba(34,197,94,.1)' : 'rgba(239,68,68,.1)'};color:${ok ? 'var(--success)' : 'var(--danger)'}}
h1{font-size:1.5rem;font-weight:700;letter-spacing:-.02em}
.msg{color:var(--text-secondary);margin:0 0 20px}
.actions{display:flex;gap:12px;margin-top:24px;flex-wrap:wrap}
a.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;text-decoration:none;border-radius:var(--radius-sm);padding:12px 20px;border:1px solid var(--border);background:var(--bg-card);color:var(--text-primary);font-weight:600}
a.btn:hover{background:#f4f6fb;border-color:#cbd5e1}
a.btn.primary{background:var(--primary);color:#fff;border-color:var(--primary)}
a.btn.primary:hover{background:var(--primary-dark);border-color:var(--primary-dark)}
small.hint{display:block;color:var(--text-muted);margin-top:16px}
pre,code{background:var(--primary-light);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 16px;display:block;overflow:auto}
</style>
${redirectTo ? `<script>setTimeout(function(){location.href=${JSON.stringify(redirectTo)};}, ${autoDelayMs});</script>` : ''}
</head>
<body>
<main class="card" role="status" aria-live="polite">
  <div class="head">
    <div class="icon" aria-hidden="true">
      ${ok ? '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' :
              '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'}
    </div>
    <h1>${escapeHtml(title)}</h1>
  </div>
  <p class="msg">${ok ? 'Tokens salvos com sucesso. Você já pode usar as rotas protegidas.' : 'Não foi possível concluir a conexão.'}</p>
  <div class="content">${message || ''}${detailsHTML || ''}</div>
  <div class="actions">
    ${redirectTo ? `<a class="btn primary" href="${redirectTo}">Voltar às integrações</a>` : ''}
    <a class="btn" href="/index.html">Ir para Devoluções</a>
  </div>
  <small class="hint">${ok ? 'Você será redirecionado automaticamente em instantes…' : 'Revise as credenciais e tente novamente.'}</small>
</main>
</body></html>`;
  }

  // ---------- Persistência ----------
  async function upsertTokens({ user_id, nickname, token }) {
    const expiresAt = dayjs()
      .add(Math.max(60, (token.expires_in || 600) - 300), 'seconds') // margem de 5 min
      .toISOString();

    await query(`
      INSERT INTO public.ml_tokens
        (user_id, nickname, access_token, refresh_token, scope, token_type, expires_at, raw, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
      ON CONFLICT (user_id) DO UPDATE SET
        nickname     = EXCLUDED.nickname,
        access_token = EXCLUDED.access_token,
        refresh_token= EXCLUDED.refresh_token,
        scope        = EXCLUDED.scope,
        token_type   = EXCLUDED.token_type,
        expires_at   = EXCLUDED.expires_at,
        raw          = EXCLUDED.raw,
        updated_at   = now()
    `, [
      user_id,
      nickname || null,
      token.access_token || null,
      token.refresh_token || null,
      token.scope || null,
      token.token_type || null,
      expiresAt,
      JSON.stringify(token || {})
    ]);

    return { user_id, nickname, expires_at: expiresAt };
  }

  async function loadLatestAccount(userId = null) {
    if (userId) {
      const { rows } = await query(`
        SELECT user_id, nickname, access_token, refresh_token, expires_at
          FROM public.ml_tokens
         WHERE user_id = $1
         ORDER BY updated_at DESC
         LIMIT 1
      `, [userId]);
      return rows[0] || null;
    }
    const { rows } = await query(`
      SELECT user_id, nickname, access_token, refresh_token, expires_at
        FROM public.ml_tokens
       WHERE access_token IS NOT NULL AND access_token <> ''
       ORDER BY updated_at DESC
       LIMIT 1
    `);
    return rows[0] || null;
  }

  async function refreshAccessToken({ user_id, refresh_token }) {
    if (!refresh_token) throw new Error('missing_refresh_token');

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID || '',
      client_secret: CLIENT_SECRET || '',
      refresh_token
    });

    const { data: token } = await axios.post(ML_TOKEN_URL, body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000
    });

    await upsertTokens({ user_id, nickname: null, token });
    return token;
  }

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

      const { data: token } = await axios.post(ML_TOKEN_URL, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000
      });

      const { data: me } = await axios.get(`${ML_BASE}/users/me`, {
        headers: { Authorization: `Bearer ${token.access_token}` },
        timeout: 15000
      });

      const saved = await upsertTokens({
        user_id: me.id,
        nickname: me.nickname || null,
        token
      });

      // compat com mlClient (se usado noutros pontos)
      if (typeof ml.saveAccount === 'function') {
        try {
          await ml.saveAccount({
            user_id: me.id,
            nickname: me.nickname,
            access_token: token.access_token,
            refresh_token: token.refresh_token,
            scope: token.scope,
            token_type: token.token_type,
            expires_at: saved.expires_at
          });
        } catch {}
      }

      // opcional: popular sessão (algumas rotas usam req.session.ml.*)
      req.session.ml = {
        user_id: String(me.id),
        access_token: token.access_token
      };

      return res.send(renderAuthResult({
        ok: true,
        title: 'Conectado ao Mercado Livre',
        message: `<p>Conta: <strong>${escapeHtml(me.nickname)}</strong> <small>(user_id ${escapeHtml(String(me.id))})</small></p>`,
        detailsHTML: '<p>Tokens salvos com sucesso.</p>',
      }));
    } catch (e) {
      const data = e?.response?.data || e;
      console.error('[ml-auth] callback error', data);
      return res.status(500).send(renderAuthResult({
        ok: false,
        title: 'Erro inesperado no OAuth',
        message: '<p>Ocorreu um erro ao concluir a conexão.</p>',
        detailsHTML: `<pre>${escapeHtml(String(data?.message || data))}</pre>`,
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

  // ---------- Status (consulta DB) ----------
  app.get('/api/ml/status', async (_req, res) => {
    try {
      const q = await query(`
        SELECT user_id, nickname, expires_at, access_token
          FROM public.ml_tokens
         WHERE access_token IS NOT NULL AND access_token <> ''
         ORDER BY updated_at DESC
         LIMIT 1
      `);
      if (!q.rows.length) return res.json({ connected: false });

      const row = q.rows[0];
      return res.json({
        connected: true,
        nickname: row.nickname || null,
        user_id: String(row.user_id),
        expires_at: row.expires_at
      });
    } catch {
      return res.json({ connected: false, error: 'not_connected' });
    }
  });

  // ---------- Listar contas salvas (DB) ----------
  app.get('/api/ml/accounts', async (_req, res) => {
    try {
      const q = await query(`
        SELECT user_id, nickname, expires_at
          FROM public.ml_tokens
         WHERE access_token IS NOT NULL AND access_token <> ''
         ORDER BY updated_at DESC
      `);
      res.json({ items: q.rows, active_user_id: q.rows[0]?.user_id || null });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ---------- Forçar Refresh (útil p/ CRON/ajustes) ----------
  // POST /api/ml/refresh  { user_id?: "1182709105" }
  app.post('/api/ml/refresh', async (req, res) => {
    try {
      const userId = (req.body?.user_id || '').toString().replace(/\D/g, '');
      const acc = await loadLatestAccount(userId || null);
      if (!acc) return res.status(404).json({ ok: false, error: 'account_not_found' });

      // se não está perto de expirar, ainda atualizamos para padronizar
      const now = dayjs();
      const exp = dayjs(acc.expires_at);
      const near = !exp.isValid() || exp.diff(now, 'second') <= AHEAD_SEC;

      const token = near
        ? await refreshAccessToken({ user_id: acc.user_id, refresh_token: acc.refresh_token })
        : { access_token: acc.access_token, refresh_token: acc.refresh_token };

      res.json({ ok: true, user_id: String(acc.user_id), refreshed: !!near, token_type: 'Bearer' });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.response?.data || e.message || e) });
    }
  });

  // ---------- Desconectar ----------
  app.post('/api/ml/disconnect', async (req, res) => {
    try {
      const { user_id } = req.body || {};
      if (user_id) {
        await query(`UPDATE public.ml_tokens SET access_token=NULL, refresh_token=NULL, updated_at=now() WHERE user_id=$1`, [user_id]);
      } else {
        await query(`UPDATE public.ml_tokens SET access_token=NULL, refresh_token=NULL, updated_at=now()`);
      }
      if (typeof ml.saveAccount === 'function') {
        try { await ml.saveAccount({}); } catch {}
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ---------- /api/ml/me (teste rápido) ----------
  app.get('/api/ml/me', async (_req, res) => {
    try {
      const acc = await loadLatestAccount();
      if (!acc?.access_token) return res.status(400).json({ ok: false, error: 'no_token' });

      const me = await axios.get(`${ML_BASE}/users/me`, {
        headers: { Authorization: `Bearer ${acc.access_token}` },
        timeout: 15000
      });

      res.json({ ok: true, me: me.data });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.response?.data || e.message || e) });
    }
  });

  console.log('[BOOT] Rotas ML OAuth registradas');
};
