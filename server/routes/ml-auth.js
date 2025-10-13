'use strict';
const express = require('express');
const axios = require('axios');
const dayjs = require('dayjs');
const cookieParser = require('cookie-parser');

const { saveAccount, loadAccount, getAuthedAxios } = require('../mlClient');

const ML_AUTH_URL  = process.env.ML_AUTH_URL  || 'https://auth.mercadolivre.com.br/authorization';
const ML_TOKEN_URL = process.env.ML_TOKEN_URL || 'https://api.mercadolibre.com/oauth/token';
const ML_BASE      = process.env.ML_BASE_URL  || 'https://api.mercadolibre.com';

module.exports = function registerMlAuth(app) {
  const CLIENT_ID     = process.env.ML_CLIENT_ID;
  const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
  const REDIRECT_URI  = process.env.ML_REDIRECT_URI;

  app.use(cookieParser());
  app.use(express.json());

  // ========== LOGIN ==========
  app.get('/auth/ml/login', (req, res) => {
    const state = 'rf_' + Math.random().toString(36).slice(2, 10);
    res.cookie('ml_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });

    const url = new URL(ML_AUTH_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('state', state);
    res.redirect(url.toString());
  });

  // ========== CALLBACK (troca code → tokens) ==========
  app.get('/auth/ml/callback', async (req, res) => {
    try {
      const { code, state, error, error_description } = req.query;
      if (error) return res.status(400).send(`Erro: ${error} - ${error_description || ''}`);
      if (!code) return res.status(400).send('Faltou code');

      // valida CSRF
      const cookieState = req.cookies.ml_state;
      res.clearCookie('ml_state');
      if (!state || !cookieState || state !== cookieState) {
        return res.status(400).send('State inválido.');
      }

      const params = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: REDIRECT_URI
      });

      const { data } = await axios.post(ML_TOKEN_URL, params, {
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

      res.send(`
        <h2>Conectado ao Mercado Livre ✅</h2>
        <p>Conta: ${acc.nickname} (user_id ${acc.user_id})</p>
        <p>Tokens salvos. Você já pode usar as rotas protegidas.</p>
        <a href="/settings/config.html#integracoes">Voltar às integrações</a>
      `);
    } catch (e) {
      console.error('[ml-auth] callback error', e?.response?.data || e);
      res.status(500).send('Falha no OAuth');
    }
  });

  // ========= Fluxo opcional por API (se quiser iniciar via fetch no front) =========
  app.get('/api/ml/auth', (req, res) => {
    const state = 'rf_' + Math.random().toString(36).slice(2, 10);
    res.cookie('ml_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });

    const url = new URL(ML_AUTH_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('state', state);
    res.json({ url: url.toString() });
  });

  // (mantido) troca via POST, se fizer o flow SPA – sem cookie não dá pra validar state
  app.post('/api/ml/auth/exchange', async (req, res) => {
    try {
      const { code } = req.body || {};
      if (!code) return res.status(400).json({ ok: false, error: 'code vazio' });

      const params = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: REDIRECT_URI
      });

      const { data } = await axios.post(ML_TOKEN_URL, params, {
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
      // só tentar criar o axios já força refresh se expirado
      const accRaw = await loadAccount();
      if (!accRaw || !accRaw.access_token) return res.json({ connected: false });

      const { account } = await getAuthedAxios();
      return res.json({
        connected: true,
        nickname: account.nickname,
        user_id: account.user_id,
        expires_at: account.expires_at
      });
    } catch (e) {
      return res.json({ connected: false, error: 'not_connected' });
    }
  });

  // ========= Desconectar =========
  app.post('/api/ml/disconnect', async (_req, res) => {
    await saveAccount({});
    res.json({ ok: true });
  });

  // ========= Teste: quem sou eu =========
  app.get('/api/ml/me', async (_req, res) => {
    try {
      const { http, account } = await getAuthedAxios();
      const me = await http.get('/users/me');
      res.json({ ok: true, account: { user_id: account.user_id, nickname: account.nickname }, me: me.data });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.response?.data || e.message || e) });
    }
  });
};
