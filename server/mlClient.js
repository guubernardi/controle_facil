'use strict';
const axios = require('axios');
const dayjs = require('dayjs');
const { query } = require('./db');

const ML_BASE      = process.env.ML_BASE_URL || 'https://api.mercadolibre.com';
const ML_TOKEN_URL = process.env.ML_TOKEN_URL || 'https://api.mercadolibre.com/oauth/token';

async function getAccount() {
  const { rows } = await query('select * from ml_accounts order by id desc limit 1');
  return rows[0] || null;
}

async function saveAccount(acc) {
  const { rows } = await query(`
    insert into ml_accounts (user_id, nickname, access_token, refresh_token, scope, token_type, expires_at, updated_at)
    values ($1,$2,$3,$4,$5,$6,$7, now())
    on conflict (user_id) do update set
      nickname=excluded.nickname,
      access_token=excluded.access_token,
      refresh_token=excluded.refresh_token,
      scope=excluded.scope,
      token_type=excluded.token_type,
      expires_at=excluded.expires_at,
      updated_at=now()
    returning *`,
    [acc.user_id, acc.nickname || null, acc.access_token, acc.refresh_token || null, acc.scope || null, acc.token_type || null, acc.expires_at]
  );
  return rows[0];
}

async function refreshIfNeeded(acc) {
  if (!acc) return null;
  const willExpire = dayjs(acc.expires_at).isBefore(dayjs().add(60, 'seconds'));
  if (!willExpire) return acc;

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.ML_CLIENT_ID,
    client_secret: process.env.ML_CLIENT_SECRET,
    refresh_token: acc.refresh_token
  });

  const { data } = await axios.post(ML_TOKEN_URL, params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000
  });

  const updated = {
    ...acc,
    access_token: data.access_token,
    refresh_token: data.refresh_token || acc.refresh_token,
    scope: data.scope,
    token_type: data.token_type,
    expires_at: dayjs().add(data.expires_in || 600, 'seconds').toISOString()
  };
  await saveAccount(updated);
  return updated;
}

async function getAuthedAxios() {
  let acc = await getAccount();
  if (!acc) throw new Error('Conta ML não conectada.');
  acc = await refreshIfNeeded(acc);

  const instance = axios.create({
    baseURL: ML_BASE,
    timeout: 20000,
    headers: { Authorization: `Bearer ${acc.access_token}` }
  });
  return { http: instance, account: acc };
}

module.exports = { getAuthedAxios, saveAccount };
