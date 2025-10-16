// server/routes/ml-api.js
'use strict';
const express = require('express');
const { query } = require('../db');
const { getAuthedAxios } = require('../mlClient');

module.exports = function registerMlApi(app) {
  const r = express.Router();

  // GET /api/ml/stores
  r.get('/api/ml/stores', async (_req, res) => {
    try {
      const q = await query(`
        SELECT DISTINCT user_id, nickname
          FROM public.ml_tokens
         WHERE access_token IS NOT NULL
         ORDER BY user_id
      `);

      // paraleliza as chamadas ao ML
      const stores = await Promise.all(
        q.rows.map(async (row) => {
          const user_id = row.user_id;
          try {
            const { http } = await getAuthedAxios(user_id);
            // tanto /users/me quanto /users/{id} funcionam; /me evita mismatch
            const { data: u } = await http.get('/users/me');

            return {
              id: u.id || user_id,
              user_id,
              nickname: u.nickname || row.nickname || null,
              name: u.nickname || row.nickname || `Conta ${user_id}`,
              site_id: u.site_id || 'MLB',
              active: true,
            };
          } catch (e) {
            // se falhar, ainda retornamos a “conta”, marcando inativa
            return {
              id: user_id,
              user_id,
              nickname: row.nickname || null,
              name: row.nickname || `Conta ${user_id}`,
              site_id: 'MLB',
              active: false,
              error: String(e?.message || e),
            };
          }
        })
      );

      return res.json({ stores });
    } catch (e) {
      console.error('[GET /api/ml/stores] erro:', e);
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // GET /api/ml/me (fallback simples)
  r.get('/api/ml/me', async (_req, res) => {
    try {
      const q = await query(`
        SELECT user_id
          FROM public.ml_tokens
         WHERE access_token IS NOT NULL
         ORDER BY COALESCE(updated_at, now()) DESC
         LIMIT 1
      `);

      if (!q.rows.length) {
        return res.json({ connected: false, accounts: [] });
      }

      const user_id = q.rows[0].user_id;
      const { http } = await getAuthedAxios(user_id);
      const { data: u } = await http.get('/users/me');

      return res.json({
        connected: true,
        accounts: [{
          id: u.id,
          user_id: u.id,
          nickname: u.nickname,
          site_id: u.site_id,
          active: true,
        }],
      });
    } catch (e) {
      console.error('[GET /api/ml/me] erro:', e);
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.use(r);
  console.log('[BOOT] Rotas ML API registradas');
};
