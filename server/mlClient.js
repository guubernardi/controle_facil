'use strict';

const { query } = require('./db');
const axios = require('axios');
const dayjs = require('dayjs');

const ML_TOKEN_URL = process.env.ML_TOKEN_URL || 'https://api.mercadolibre.com/oauth/token';
const ML_BASE_URL  = process.env.ML_BASE_URL  || 'https://api.mercadolibre.com';
const CLIENT_ID     = process.env.ML_CLIENT_ID;
const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;

/** Auto-migração: garante tabela e colunas necessárias */
async function ensureSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS public.ml_accounts (
      user_id      TEXT PRIMARY KEY,
      nickname     TEXT,
      access_token TEXT,
      refresh_token TEXT,
      scope        TEXT,
      token_type   TEXT,
      expires_at   TIMESTAMPTZ,
      is_active    BOOLEAN NOT NULL DEFAULT FALSE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Se a coluna não existir (ex.: ambientes antigos), cria
  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name='ml_accounts'
          AND column_name='is_active'
      ) THEN
        ALTER TABLE public.ml_accounts
          ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT FALSE;
      END IF;
    END$$;
  `);
}
ensureSchema().catch(err => console.error('[mlClient] ensureSchema', err));

/** Salva/atualiza conta e já marca como ativa */
async function saveAccount(acc) {
  await ensureSchema();
  await query(`
    INSERT INTO public.ml_accounts
      (user_id, nickname, access_token, refresh_token, scope, token_type, expires_at, is_active, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7, TRUE, now())
    ON CONFLICT (user_id) DO UPDATE SET
      nickname      = EXCLUDED.nickname,
      access_token  = EXCLUDED.access_token,
      refresh_token = EXCLUDED.refresh_token,
      scope         = EXCLUDED.scope,
      token_type    = EXCLUDED.token_type,
      expires_at    = EXCLUDED.expires_at,
      updated_at    = now();
  `, [
    String(acc.user_id), acc.nickname, acc.access_token,
    acc.refresh_token, acc.scope, acc.token_type, acc.expires_at
  ]);
}

async function listAccounts() {
  await ensureSchema();
  const r = await query(`
    SELECT user_id, nickname, expires_at, is_active
    FROM public.ml_accounts
    ORDER BY nickname NULLS LAST
  `);
  return r.rows;
}

async function setActive(user_id) {
  await ensureSchema();
  await query(`UPDATE public.ml_accounts SET is_active = FALSE;`);
  await query(`UPDATE public.ml_accounts SET is_active = TRUE WHERE user_id = $1;`, [String(user_id)]);
}

async function getActiveUserId() {
  await ensureSchema();
  const r = await query(`SELECT user_id FROM public.ml_accounts WHERE is_active = TRUE LIMIT 1;`);
  return r.rows[0]?.user_id || null;
}

/** Carrega conta (ativa por padrão) */
async function loadAccount(user_id) {
  await ensureSchema();
  if (user_id) {
    const r = await query(`SELECT * FROM public.ml_accounts WHERE user_id = $1 LIMIT 1;`, [String(user_id)]);
    return r.rows[0] || null;
  }
  const r = await query(`SELECT * FROM public.ml_accounts WHERE is_active = TRUE LIMIT 1;`);
  return r.rows[0] || null;
}

/** Refresh do token se estiver perto de vencer */
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
  if (!acc) return null;
  const expiresAt = dayjs(acc.expires_at || 0);
  if (expiresAt.isAfter(dayjs().add(60, 'second'))) return acc;

  const t = await refreshToken(acc.refresh_token);
  const next = {
    ...acc,
    access_token: t.access_token,
    refresh_token: t.refresh_token || acc.refresh_token,
    token_type: t.token_type || acc.token_type,
    scope: t.scope || acc.scope,
    expires_at: dayjs().add(t.expires_in || 600, 'second').toISOString()
  };
  await saveAccount(next);
  return next;
}

/** Retorna axios autenticado para o user ativo (ou o informado) */
async function getAuthedAxios(user_id) {
  await ensureSchema();
  let acc = await loadAccount(user_id);
  if (!acc) throw new Error('not_connected');

  acc = await ensureFreshAccount(acc);

  const http = axios.create({
    baseURL: ML_BASE_URL,
    timeout: 15000,
    headers: { Authorization: `Bearer ${acc.access_token}` }
  });
  return { http, account: acc };
}

async function removeAccount(user_id) {
  await ensureSchema();
  await query(`DELETE FROM public.ml_accounts WHERE user_id = $1;`, [String(user_id)]);
}

module.exports = {
  saveAccount,
  loadAccount,
  getAuthedAxios,
  listAccounts,
  setActive,
  removeAccount,
  getActiveUserId,
};
