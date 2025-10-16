// server/routes/ml-api.js
'use strict';
const express = require('express');
const { query } = require('../db');
const { getAuthedAxios } = require('../mlClient');

module.exports = function registerMlApi(app) {
  const r = express.Router();

  /**
   * GET /api/ml/stores
   * Lista as contas ML conhecidas pela base (user_ids que temos token).
   * Para cada user_id, buscamos /users/{user_id} no ML para trazer nickname/site.
   */
  r.get('/api/ml/stores', async (req, res) => {
    try {
      // 👇 ajuste se o nome da tabela/colunas for diferente na sua base
      const q = await query(`
        select distinct user_id
          from ml_tokens
         where access_token is not null
         order by user_id
      `);

      const stores = [];
      for (const row of q.rows) {
        const user_id = row.user_id;
        try {
          const { http } = await getAuthedAxios(user_id); // já renova se preciso
          const { data: u } = await http.get(`/users/${user_id}`);

          stores.push({
            id: u.id || user_id,
            user_id,
            nickname: u.nickname || null,
            name: u.nickname || `Conta ${user_id}`,
            site_id: u.site_id || 'MLB',
            active: true
          });
        } catch (e) {
          // se falhar a chamada p/ esse user_id, ainda retornamos a “conta”, porém inativa
          stores.push({
            id: user_id,
            user_id,
            nickname: null,
            name: `Conta ${user_id}`,
            site_id: 'MLB',
            active: false,
            error: String(e?.message || e)
          });
        }
      }

      return res.json({ stores });
    } catch (e) {
      console.error('[GET /api/ml/stores] erro:', e);
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  /**
   * GET /api/ml/me
   * Fallback simples: pega o último user_id e retorna os dados do usuário do ML.
   * O front usa isso se /api/ml/stores não existir/der erro.
   */
  r.get('/api/ml/me', async (req, res) => {
    try {
      // último token atualizado
      const q = await query(`
        select user_id
          from ml_tokens
         where access_token is not null
         order by updated_at desc
         limit 1
      `);

      if (!q.rows.length) {
        return res.json({ connected: false, accounts: [] });
      }

      const user_id = q.rows[0].user_id;
      const { http } = await getAuthedAxios(user_id);
      const { data: u } = await http.get(`/users/${user_id}`);

      return res.json({
        connected: true,
        accounts: [{
          id: u.id,
          user_id: u.id,
          nickname: u.nickname,
          site_id: u.site_id,
          active: true
        }]
      });
    } catch (e) {
      console.error('[GET /api/ml/me] erro:', e);
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.use(r);
  console.log('[BOOT] Rotas ML API registradas');
};
