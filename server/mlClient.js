'use strict';
const axios = require('axios');
const dayjs = require('dayjs');
const path = require('path');
const fs = require('fs/promises'); // usado apenas para migração opcional a partir de arquivo
const { query } = require('./db');

// URLs/credenciais do ML
const ML_TOKEN_URL   = process.env.ML_TOKEN_URL   || 'https://api.mercadolibre.com/oauth/token';
const ML_BASE_URL    = process.env.ML_BASE_URL    || 'https://api.mercadolibre.com';
const CLIENT_ID      = process.env.ML_CLIENT_ID;
const CLIENT_SECRET  = process.env.ML_CLIENT_SECRET;

// -------- Helpers DB --------
async function upsertAccount(acc, { makeActive = false } = {}) {
  const {
    user_id, nickname, access_token, refresh_token,
    token_type, scope, expires_at
  } = acc;

  // upsert
  await query(
    `INSERT INTO ml_accounts (user_id, nickname, access_token, refresh_token, token_type, scope, expires_at, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (user_id)
     DO UPDATE SET
       nickname = EXCLUDED.nickname,
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       token_type = EXCLUDED.token_type,
       scope = EXCLUDED.scope,
       expires_at = EXCLUDED.expires_at,
       updated_at = now()
    `,
    [user_id, nickname || null, access_token, refresh_token || null, token_type || null, scope || null, expires_at, makeActive]
  );

  // se makeActive === true, desativa as demais e ativa esta
  if (makeActive) {
    await query(`UPDATE ml_accounts SET is_active=false WHERE user_id <> $1`, [user_id]);
    await query(`UPDATE ml_accounts SET is_active=true  WHERE user_id = $1`, [user_id]);
  }
}

async function getAccountById(user_id) {
  const r = await query(`SELECT * FROM ml_accounts WHERE user_id = $1 LIMIT 1`, [String(user_id)]);
  return r.rows[0] || null;
}

async function getActiveAccount() {
  const r = await query(`SELECT * FROM ml_accounts WHERE is_active = true LIMIT 1`);
  return r.rows[0] || null;
}

async function setActive(user_id) {
  await query(`UPDATE ml_accounts SET is_active=false WHERE is_active = true`);
  const r = await query(`UPDATE ml_accounts SET is_active=true WHERE user_id=$1`, [String(user_id)]);
  if (r.rowCount === 0) throw new Error('user_id não encontrado');
  return true;
}

async function removeAccount(user_id) {
  await query(`DELETE FROM ml_accounts WHERE user_id=$1`, [String(user_id)]);
}

async function listAccounts() {
  const r = await query(
    `SELECT user_id, nickname, expires_at, is_active
       FROM ml_accounts
      ORDER BY is_active DESC, nickname NULLS LAST`
  );
  return r.rows;
}

async function getActiveUserId() {
  const acc = await getActiveAccount();
  return acc ? acc.user_id : null;
}

// -------- Refresh de token --------
async function refreshToken(refresh_token) {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('CLIENT_ID/CLIENT_SECRET ausentes');
  if (!refresh_token) throw new Error('refresh_token ausente');

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

function isFresh(expires_at) {
  const exp = dayjs(expires_at || 0);
  // margem de 60s
  return exp.isAfter(dayjs().add(60, 'second'));
}

// -------- API pública (compatível com seu ml-auth.js) --------

// Salva/atualiza a conta e, se for a primeira ou makeActive=true, marca como ativa
async function saveAccount(acc) {
  // se ainda não tiver nenhuma ativa, torna esta ativa
  const currentActive = await getActiveAccount();
  const makeActive = !currentActive; // primeira conta cadastrada vira ativa
  await upsertAccount({ ...acc }, { makeActive });
  return acc;
}

// Retorna a conta ativa (compat em single-account)
async function loadAccount() {
  return await getActiveAccount();
}

// Retorna axios autenticado e a conta (ativa ou por user_id específico)
async function getAuthedAxios(user_id) {
  let acc = user_id ? await getAccountById(user_id) : await getActiveAccount();
  if (!acc) throw new Error('ML não conectado');

  // refresh se necessário
  if (!isFresh(acc.expires_at)) {
    const r = await refreshToken(acc.refresh_token);
    acc = {
      ...acc,
      access_token: r.access_token,
      refresh_token: r.refresh_token || acc.refresh_token,
      token_type: r.token_type || acc.token_type,
      scope: r.scope || acc.scope,
      expires_at: dayjs().add(r.expires_in || 600, 'second').toISOString()
    };
    await upsertAccount(acc, { makeActive: acc.is_active }); // preserva ativo
  }

  const http = axios.create({
    baseURL: ML_BASE_URL,
    timeout: 15000,
    headers: { Authorization: `Bearer ${acc.access_token}` }
  });

  return { http, account: {
    user_id: String(acc.user_id),
    nickname: acc.nickname,
    expires_at: acc.expires_at
  }};
}

// --------- (Opcional) migração do arquivo local para DB ---------
async function migrateFromFileIfExists() {
  try {
    const STORE = path.resolve(process.cwd(), 'data/meli.json');
    const raw = await fs.readFile(STORE, 'utf8');
    const j = JSON.parse(raw || '{}');
    if (j && j.access_token && j.user_id) {
      await upsertAccount({
        user_id: String(j.user_id),
        nickname: j.nickname || null,
        access_token: j.access_token,
        refresh_token: j.refresh_token || null,
        token_type: j.token_type || null,
        scope: j.scope || null,
        expires_at: j.expires_at || dayjs().add(10, 'minute').toISOString()
      }, { makeActive: true });
      // opcional: renomeia arquivo pra não migrar de novo
      await fs.rename(STORE, STORE + '.migrated').catch(() => {});
      // eslint-disable-next-line no-console
      console.log('[ML] Tokens migrados de data/meli.json para Postgres.');
    }
  } catch { /* ignorar se não existir */ }
}

// migrateFromFileIfExists();

module.exports = {
  // compat “single-account”
  loadAccount,
  saveAccount,
  getAuthedAxios,
  // multi-contas
  listAccounts,
  setActive,
  removeAccount,
  getActiveUserId,
};
