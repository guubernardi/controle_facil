'use strict';
const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');
const dayjs = require('dayjs');

const ML_TOKEN_URL = process.env.ML_TOKEN_URL || 'https://api.mercadolibre.com/oauth/token';
const ML_BASE_URL  = process.env.ML_BASE_URL  || 'https://api.mercadolibre.com';
const CLIENT_ID     = process.env.ML_CLIENT_ID;
const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;

const STORE = path.resolve(process.cwd(), 'data/meli-accounts.json');

async function readStore() {
  try {
    const raw = await fs.readFile(STORE, 'utf8');
    const parsed = JSON.parse(raw);
    return { active_user_id: parsed.active_user_id || null, accounts: parsed.accounts || {} };
  } catch {
    return { active_user_id: null, accounts: {} };
  }
}
async function writeStore(store) {
  await fs.mkdir(path.dirname(STORE), { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(store, null, 2));
}

async function listAccounts() {
  const { accounts } = await readStore();
  return Object.values(accounts);
}

async function getActiveUserId() {
  const { active_user_id } = await readStore();
  return active_user_id || null;
}

async function setActive(user_id) {
  const store = await readStore();
  if (!store.accounts[String(user_id)]) throw new Error('Conta não encontrada');
  store.active_user_id = String(user_id);
  await writeStore(store);
  return store.accounts[String(user_id)];
}

async function removeAccount(user_id) {
  const store = await readStore();
  delete store.accounts[String(user_id)];
  if (store.active_user_id === String(user_id)) {
    const first = Object.keys(store.accounts)[0] || null;
    store.active_user_id = first;
  }
  await writeStore(store);
}

async function loadAccount() {
  const store = await readStore();
  const acc = store.active_user_id ? store.accounts[String(store.active_user_id)] : null;
  return acc || null;
}

// Mantém compatibilidade: salvar “a última conectada” como ativa
async function saveAccount(acc) {
  const store = await readStore();
  if (!acc || !acc.user_id) {
    store.active_user_id = null;
    store.accounts = {};
    await writeStore(store);
    return null;
  }
  store.accounts[String(acc.user_id)] = acc;
  store.active_user_id = String(acc.user_id);
  await writeStore(store);
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
  if (expiresAt.isAfter(dayjs().add(60, 'second'))) return acc; // ainda válido

  // refresh
  const r = await refreshToken(acc.refresh_token);
  const next = {
    ...acc,
    access_token: r.access_token,
    refresh_token: r.refresh_token || acc.refresh_token,
    token_type: r.token_type || acc.token_type,
    scope: r.scope || acc.scope,
    expires_at: dayjs().add(r.expires_in || 600, 'second').toISOString()
  };

  // persiste atualização
  const store = await readStore();
  store.accounts[String(next.user_id)] = next;
  await writeStore(store);
  return next;
}

/**
 * getAuthedAxios(userIdOpt?)
 * - se passar userIdOpt, usa aquela conta
 * - senão usa a ativa
 */
async function getAuthedAxios(userIdOpt) {
  const store = await readStore();
  const chosenId = userIdOpt ? String(userIdOpt) : store.active_user_id;
  if (!chosenId) throw new Error('ML não conectado');
  let acc = store.accounts[chosenId];
  if (!acc) throw new Error('Conta ML não encontrada');

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
  // multi-contas
  listAccounts,
  setActive,
  getActiveUserId,
  removeAccount,

  // compat + utilitários
  loadAccount,
  saveAccount,
  getAuthedAxios,
};
