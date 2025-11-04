// server/lib/ml-oauth.js
'use strict';

const express = require('express'); // só p/ rotas de debug (opcional)
const axios   = require('axios');
const dayjs   = require('dayjs');
const { query } = require('../db');

const ML_TOKEN_URL = process.env.ML_TOKEN_URL || 'https://api.mercadolibre.com/oauth/token';

function safeExpiresAt(expires_in) {
  // margem de 5 min (300s) para nunca expirar “em produção”
  const secs = Math.max(60, (Number(expires_in) || 600) - 300);
  return dayjs().add(secs, 'seconds').toISOString();
}

async function upsertToken({ user_id, nickname, access_token, refresh_token, scope, token_type, expires_in, raw }, q=query) {
  const expires_at = safeExpiresAt(expires_in);
  await q(`
    INSERT INTO public.ml_tokens
      (user_id, nickname, access_token, refresh_token, scope, token_type, expires_at, raw)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
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
    user_id, nickname || null, access_token || null, refresh_token || null,
    scope || null, token_type || null, expires_at, raw ? JSON.stringify(raw) : null
  ]);
  return { user_id, access_token, refresh_token, scope, token_type, expires_at };
}

/** Traz linha do DB */
async function getRow(sellerId, q=query) {
  const { rows } = await q(`
    SELECT user_id, nickname, access_token, refresh_token, scope, token_type, expires_at
      FROM public.ml_tokens WHERE user_id=$1
  `, [sellerId]);
  return rows[0] || null;
}

/** Faz refresh com refresh_token */
async function refreshUsing(refresh_token) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id:     process.env.ML_CLIENT_ID,
    client_secret: process.env.ML_CLIENT_SECRET,
    refresh_token
  });
  const { data } = await axios.post(ML_TOKEN_URL, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000
  });
  return data; // { access_token, refresh_token, expires_in, user_id, ... }
}

/** Retorna access_token válido (renova se preciso) para o seller */
async function getFreshToken({ sellerId, q=query }) {
  const row = await getRow(sellerId, q);
  if (!row) return null;

  const willExpire = dayjs(row.expires_at || 0).diff(dayjs(), 'second');
  if (willExpire > 120 && row.access_token) {
    return row.access_token; // ainda está ok
  }

  const payload = await refreshUsing(row.refresh_token);
  const saved = await upsertToken({
    user_id: payload.user_id || sellerId,
    nickname: row.nickname,
    access_token: payload.access_token,
    refresh_token: payload.refresh_token || row.refresh_token,
    scope: payload.scope || row.scope,
    token_type: payload.token_type || row.token_type,
    expires_in: payload.expires_in,
    raw: payload
  }, q);
  return saved.access_token;
}

/** Salva resultado do callback OAuth (se quiser centralizar) */
async function saveFromExchange({ payload, nickname }, q=query) {
  return upsertToken({
    user_id: payload.user_id,
    nickname,
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    scope: payload.scope,
    token_type: payload.token_type,
    expires_in: payload.expires_in,
    raw: payload
  }, q);
}

/** Scanner em background para renovar com antecedência (10 min) */
function setupMlTokenAutoRefresh(app, { intervalMs = 15*60*1000, aheadSec = 600 } = {}) {
  const tick = async () => {
    try {
      const { rows } = await query(`
        SELECT user_id FROM public.ml_tokens
         WHERE expires_at <= now() + ($1 || ' seconds')::interval
      `, [aheadSec]);
      for (const r of rows) {
        try { await getFreshToken({ sellerId: String(r.user_id) }); }
        catch (e) { console.warn('[ML] refresh falhou', r.user_id, e.message); }
      }
    } catch (e) {
      console.warn('[ML] scan tokens falhou:', e.message);
    }
  };

  tick();
  const h = setInterval(tick, intervalMs);
  process.on('SIGINT',  () => clearInterval(h));
  process.on('SIGTERM', () => clearInterval(h));

  // rotas de debug (opcional)
  if (app) {
    const r = express.Router();
    r.get('/tokens', async (_req, res) => {
      const { rows } = await query(`
        SELECT user_id, nickname, expires_at,
               greatest(0, extract(epoch from (expires_at - now())))::int as secs_left
          FROM public.ml_tokens ORDER BY expires_at ASC
      `);
      res.json(rows);
    });
    r.post('/tokens/refresh', express.json(), async (req, res) => {
      const id = String(req.body?.seller_id || '').replace(/[^\d]/g,'');
      if (!id) return res.status(400).json({ error:'seller_id obrigatório' });
      try { await getFreshToken({ sellerId: id }); res.json({ ok:true }); }
      catch (e) { res.status(500).json({ ok:false, error:e.message }); }
    });
    app.use('/api/ml', r);
  }
}

module.exports = {
  getFreshToken,
  saveFromExchange,
  setupMlTokenAutoRefresh,
};
