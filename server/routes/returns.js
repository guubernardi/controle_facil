'use strict';

const { query } = require('../db');

module.exports = function registerReturns(app) {
  // GET /api/returns?status=pendente&page=1&pageSize=50
  app.get('/api/returns', async (req, res) => {
    try {
      const {
        status = '',
        page = '1',
        pageSize = '50',
        orderBy = 'updated_at',
        orderDir = 'desc',
      } = req.query;

      const p = [];
      const where = [];

      // status pode se referir à coluna status OU log_status
      if (status) {
        const s = String(status).toLowerCase();
        // quando pedirem recebido_cd / em_inspecao tratamos como log_status
        const logish = new Set(['recebido_cd', 'em_inspecao', 'postado', 'em_transito', 'em trânsito']);
        if (logish.has(s)) {
          p.push(s); where.push(`LOWER(COALESCE(log_status,'')) = $${p.length}`);
        } else {
          p.push(`%${s}%`); where.push(`LOWER(COALESCE(status,'')) LIKE $${p.length}`);
        }
      }

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const allowedOrder = new Set(['id','id_venda','status','log_status','created_at','updated_at']);
      const col = allowedOrder.has(String(orderBy)) ? String(orderBy) : 'updated_at';
      const dir = String(orderDir).toLowerCase() === 'asc' ? 'asc' : 'desc';

      const limit  = Math.max(1, Math.min(parseInt(pageSize,10) || 50, 200));
      const pageNo = Math.max(1, parseInt(page,10) || 1);
      const offset = (pageNo - 1) * limit;

      const sqlItems = `
        SELECT
          id,
          id_venda,
          loja_nome,
          sku,
          status,
          log_status,
          created_at,
          updated_at
        FROM devolucoes
        ${whereSql}
        ORDER BY ${col} ${dir} NULLS LAST
        LIMIT $${p.length+1} OFFSET $${p.length+2}
      `;
      const sqlCount = `
        SELECT COUNT(*)::int AS count
        FROM devolucoes
        ${whereSql}
      `;

      const [itemsQ, countQ] = await Promise.all([
        query(sqlItems, [...p, limit, offset]),
        query(sqlCount, p),
      ]);

      res.json({
        items: itemsQ.rows,
        total: countQ.rows[0]?.count || 0,
        page: pageNo,
        pageSize: limit,
      });
    } catch (e) {
      console.error('[returns] list erro:', e);
      res.status(500).json({ error: 'Falha ao listar devoluções.' });
    }
  });
};
