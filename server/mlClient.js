// server/mlClient.js
'use strict';

const { query } = require('./db');
const axios = require('axios');
const dayjs = require('dayjs');

const ML_TOKEN_URL  = process.env.ML_TOKEN_URL  || 'https://api.mercadolibre.com/oauth/token';
const ML_BASE_URL   = process.env.ML_BASE_URL   || 'https://api.mercadolibre.com';
const CLIENT_ID     = process.env.ML_CLIENT_ID;
const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;

/* -------------------------------------------------------
 * Schema helpers (idempotentes)
 * -----------------------------------------------------*/
async function ensureSchema() {
  // Tabela base
  await query(`
    CREATE TABLE IF NOT EXISTS public.ml_accounts (
      user_id       TEXT PRIMARY KEY,
      nickname      TEXT,
      site_id       TEXT,
      access_token  TEXT,
      refresh_token TEXT,
      scope         TEXT,
      token_type    TEXT,
      expires_at    TIMESTAMPTZ,
      is_active     BOOLEAN NOT NULL DEFAULT FALSE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Colunas para bases antigas
  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='ml_accounts' AND column_name='is_active'
      ) THEN
        ALTER TABLE public.ml_accounts ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT FALSE;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='ml_accounts' AND column_name='site_id'
      ) THEN
        ALTER TABLE public.ml_accounts ADD COLUMN site_id TEXT;
      END IF;
    END$$;
  `);

  // Índices úteis
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS ml_accounts_user_id_uq ON public.ml_accounts (user_id);`);
  await query(`CREATE INDEX IF NOT EXISTS ml_accounts_nickname_idx ON public.ml_accounts (nickname);`);

  // Garante "só 1 ativa" (índice único parcial)
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ml_accounts_only_one_active_idx
      ON public.ml_accounts (is_active)
      WHERE is_active IS TRUE;
  `);
}

/* -------------------------------------------------------
 * Persistência
 * -----------------------------------------------------*/
async function saveAccount(acc) {
  await ensureSchema();

  // Desativa outras ativas primeiro para não colidir com o índice parcial
  await query(
    `UPDATE public.ml_accounts
        SET is_active = FALSE
      WHERE is_active = TRUE
        AND user_id::text <> $1::text`,
    [String(acc.user_id)]
  );

  await query(
    `
    INSERT INTO public.ml_accounts
      (user_id, nickname, site_id, access_token, refresh_token, scope, token_type, expires_at, is_active, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8, TRUE, now())
    ON CONFLICT (user_id) DO UPDATE SET
      nickname      = COALESCE(EXCLUDED.nickname, public.ml_accounts.nickname),
      site_id       = COALESCE(EXCLUDED.site_id, public.ml_accounts.site_id),
      access_token  = EXCLUDED.access_token,
      refresh_token = EXCLUDED.refresh_token,
      scope         = EXCLUDED.scope,
      token_type    = EXCLUDED.token_type,
      expires_at    = EXCLUDED.expires_at,
      is_active     = TRUE,
      updated_at    = now();
    `,
    [
      String(acc.user_id),
      acc.nickname || null,
      acc.site_id || null,
      acc.access_token || null,
      acc.refresh_token || null,
      acc.scope || null,
      acc.token_type || null,
      acc.expires_at || null
    ]
  );
}

async function listAccounts() {
  await ensureSchema();
  const r = await query(`
    SELECT user_id, nickname, site_id, expires_at, is_active
      FROM public.ml_accounts
     ORDER BY is_active DESC, updated_at DESC, nickname NULLS LAST
  `);
  return r.rows;
}

async function setActive(user_id) {
  await ensureSchema();
  await query(`UPDATE public.ml_accounts SET is_active = FALSE WHERE is_active = TRUE;`);
  await query(
    `UPDATE public.ml_accounts
        SET is_active = TRUE, updated_at = now()
      WHERE user_id::text = $1::text`,
    [String(user_id)]
  );
}

async function getActiveUserId() {
  await ensureSchema();
  const r = await query(
    `SELECT user_id
       FROM public.ml_accounts
      WHERE is_active = TRUE
      ORDER BY updated_at DESC
      LIMIT 1`
  );
  return r.rows[0]?.user_id || null;
}

async function loadAccount(user_id) {
  await ensureSchema();
  if (user_id) {
    const r = await query(
      `SELECT *
         FROM public.ml_accounts
        WHERE user_id::text = $1::text
        LIMIT 1`,
      [String(user_id)]
    );
    return r.rows[0] || null;
  }
  const r = await query(
    `SELECT *
       FROM public.ml_accounts
      WHERE is_active = TRUE
      ORDER BY updated_at DESC
      LIMIT 1`
  );
  return r.rows[0] || null;
}

async function removeAccount(user_id) {
  await ensureSchema();
  await query(`DELETE FROM public.ml_accounts WHERE user_id::text = $1::text;`, [String(user_id)]);
}

/* -------------------------------------------------------
 * Token
 * -----------------------------------------------------*/
async function refreshToken(refresh_token) {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('missing_ml_credentials');
  }

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

  return data; // { access_token, token_type, expires_in, scope, refresh_token? }
}

async function ensureFreshAccount(acc) {
  if (!acc) return null;

  const expiresAt = dayjs(acc.expires_at || 0);
  // se faltarem menos de 60s, já faz refresh
  if (expiresAt.isAfter(dayjs().add(60, 'second'))) return acc;

  try {
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
  } catch (e) {
    console.error('[mlClient] refreshToken error:', e?.response?.data || e?.message || e);
    // mantém o token antigo; caller decide o que fazer
    return acc;
  }
}

/* -------------------------------------------------------
 * Cliente autenticado
 * Aceita:
 *   - getAuthedAxios(req)  -> usa ?ml_account= / header x-ml-account / ativa
 *   - getAuthedAxios('USER_ID') -> usa essa conta
 * -----------------------------------------------------*/
async function getAuthedAxios(ctx) {
  await ensureSchema();

  // Se vier string, considere como user_id
  let desiredUserId = (typeof ctx === 'string') ? ctx : null;

  // Se for req, tente query/header
  if (!desiredUserId && ctx && typeof ctx === 'object') {
    desiredUserId =
      ctx.query?.ml_account ||
      ctx.query?.user_id ||
      ctx.headers?.['x-ml-account'] ||
      ctx.headers?.['x-ml-user'] ||
      null;
  }

  let acc = await loadAccount(desiredUserId);
  if (!acc) throw new Error('not_connected');

  acc = await ensureFreshAccount(acc);

  const http = axios.create({
    baseURL: ML_BASE_URL,
    timeout: 20000,
    headers: { Authorization: `Bearer ${acc.access_token}` }
  });

  // Enriquecimento assíncrono (nickname/site_id) se estiver faltando
  try {
    if (!acc.nickname || !acc.site_id) {
      const { data: me } = await http.get('/users/me');
      const nickname = me?.nickname || acc.nickname || null;
      const site_id  = me?.site_id  || acc.site_id  || null;

      if (nickname !== acc.nickname || site_id !== acc.site_id) {
        await query(
          `UPDATE public.ml_accounts
              SET nickname = $2,
                  site_id  = $3,
                  updated_at = now()
            WHERE user_id::text = $1::text`,
          [String(acc.user_id), nickname, site_id]
        );
        acc.nickname = nickname;
        acc.site_id  = site_id;
      }
    }
  } catch (e) {
    // não quebra a autenticação se /users/me falhar
    console.warn('[mlClient] enrichment (/users/me) failed:', e?.response?.data || e?.message || e);
  }

  return { http, account: acc };
}

module.exports = {
  ensureSchema,
  saveAccount,
  loadAccount,
  getAuthedAxios,
  listAccounts,
  setActive,
  removeAccount,
  getActiveUserId
};
