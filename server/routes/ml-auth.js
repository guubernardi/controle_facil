// server/routes/ml-auth.js
'use strict';
const express = require('express');
const axios = require('axios');
const dayjs = require('dayjs');
const { saveAccount } = require('../mlClient'); // precisa existir

const ML_AUTH_URL  = process.env.ML_AUTH_URL  || 'https://auth.mercadolivre.com.br/authorization';
const ML_TOKEN_URL = process.env.ML_TOKEN_URL || 'https://api.mercadolibre.com/oauth/token';
const ML_BASE      = process.env.ML_BASE_URL  || 'https://api.mercadolibre.com';

module.exports = function registerMlAuth(app) {
  const CLIENT_ID     = process.env.ML_CLIENT_ID;
  const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
  const REDIRECT_URI  = process.env.ML_REDIRECT_URI;

  /* ========= FLUXO SIMPLES (sem front) ========= */

  // 1) inicia login redirecionando pro ML
  app.get('/auth/ml/login', (req, res) => {
    const state = 'rf_' + Math.random().toString(36).slice(2, 10);
    const url = new URL(ML_AUTH_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('state', state);
    res.redirect(url.toString());
  });

  // 2) callback -> troca code por tokens e salva
  app.get('/auth/ml/callback', async (req, res) => {
    try {
      const { code, error, error_description } = req.query;
      if (error) return res.status(400).send(`Erro: ${error} - ${error_description || ''}`);
      if (!code) return res.status(400).send('Faltou code');

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
        <a href="/dashboard.html">Ir ao dashboard</a>
      `);
    } catch (e) {
      console.error('[ml-auth] callback error', e?.response?.data || e);
      res.status(500).send('Falha no OAuth');
    }
  });

  /* ========= SUAS ROTAS (opcional via front) ========= */

  // retorna a URL de login (caso queira abrir via front)
  app.get('/api/ml/auth', (req, res) => {
    const state = 'rf_' + Math.random().toString(36).slice(2, 10);
    const url = new URL(ML_AUTH_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('state', state);
    res.json({ url: url.toString(), state });
  });

  // troca code por token via POST (se preferir fazer pelo front)
  app.post('/api/ml/auth/exchange', express.json(), async (req, res) => {
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

      const saved = await saveAccount(acc);
      res.json({ ok: true, account: { user_id: saved.user_id, nickname: saved.nickname } });
    } catch (e) {
      console.error('[ml-auth] exchange error', e?.response?.data || e);
      res.status(500).json({ ok: false, error: 'Falha ao trocar o code por tokens' });
    }
  });

  // “Quem sou eu?” (requere tokens salvos)
  app.get('/api/ml/me', async (_req, res) => {
    try {
      const { getAuthedAxios } = require('../mlClient');
      const { http, account } = await getAuthedAxios();
      const me = await http.get('/users/me');
      res.json({ ok: true, account: { user_id: account.user_id, nickname: account.nickname }, me: me.data });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.response?.data || e.message || e) });
    }
  });
};
