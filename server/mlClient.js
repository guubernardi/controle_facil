'use strict';
const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');
const dayjs = require('dayjs');

const ML_TOKEN_URL = process.env.ML_TOKEN_URL || 'https://api.mercadolibre.com/oauth/token';
const ML_BASE_URL  = process.env.ML_BASE_URL  || 'https://api.mercadolibre.com';
const CLIENT_ID     = process.env.ML_CLIENT_ID;
the
const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;

const STORE = path.resolve(process.cwd(), 'data/meli.json');

async function loadAccount() {
  try {
    const raw = await fs.readFile(STORE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveAccount(acc) {
  await fs.mkdir(path.dirname(STORE), { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(acc || {}, null, 2));
  return acc;
}

async function refreshToken(refresh_token) {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token
  });
  const { data } = await axios.post(ML_TOKEN_URL, form.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000
  });
  return data;
}

async function ensureFreshAccount(acc) {
  if (!acc || !acc.access_token) return null;

  const expiresAt = dayjs(acc.expires_at || 0);
  // margem de 60s
  if (expiresAt.isAfter(dayjs().add(60, 'second'))) return acc;

  // expirou → refresh
  const r = await refreshToken(acc.refresh_token);
  const next = {
    ...acc,
    access_token: r.access_token,
    refresh_token: r.refresh_token || acc.refresh_token,
    token_type: r.token_type || acc.token_type,
    scope: r.scope || acc.scope,
    expires_at: dayjs().add(r.expires_in || 600, 'second').toISOString()
  };
  await saveAccount(next);
  return next;
}

async function getAuthedAxios() {
  let acc = await loadAccount();
  if (!acc) throw new Error('ML não conectado');

  acc = await ensureFreshAccount(acc);
  if (!acc) throw new Error('Tokens ML ausentes');

  const http = axios.create({
    baseURL: ML_BASE_URL,
    timeout: 15000,
    headers: { Authorization: `Bearer ${acc.access_token}` }
  });

  return { http, account: acc };
}

module.exports = {
  loadAccount,
  saveAccount,
  getAuthedAxios,
};
