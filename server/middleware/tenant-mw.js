// server/middleware/tenant-mw.js
'use strict';
const { pool } = require('../db');

module.exports = function tenantMw() {
  return async (req, res, next) => {
    const tenantId = req.session?.user?.tenant_id;
    // Sem usuário logado/tenant? segue sem custo.
    if (!tenantId) return next();

    const client = await pool.connect();
    let finished = false;

    const finish = async () => {
      if (finished) return;
      finished = true;
      try { await client.query('COMMIT'); } catch {}
      client.release();
    };

    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL app.tenant_id = $1', [tenantId]);

      // Disponibiliza o client por request
      req.db = client;
      // opcional: atalho pra usar como req.q(sql, params)
      req.q = (text, params) => client.query(text, params);

      res.on('finish', finish);
      res.on('close', finish);
      next();
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      client.release();
      next(err);
    }
  };
};
