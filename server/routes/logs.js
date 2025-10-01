// logs route (Express + pg)
import express from 'express';
import { Pool } from 'pg';

const router = express.Router();

// Reaproveite seu pool central se já existir
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// campos permitidos pro ORDER BY (evita SQL injection)
const ORDER_ALLOW = new Set(['event_at','total','valor_produto','valor_frete']);

router.get('/api/returns/logs', async (req, res) => {
  const {
    from, to,
    status = '',
    responsavel = '',
    loja = '',
    q = '',
    page = '1',
    pageSize = '50',
    orderBy = 'event_at',
    orderDir = 'desc'
  } = req.query;

  const pageNum = Math.max(1, parseInt(page || '1', 10));
  const sizeNum = Math.min(200, Math.max(1, parseInt(pageSize || '50', 10)));
  const offset  = (pageNum - 1) * sizeNum;

  const orderCol = ORDER_ALLOW.has(String(orderBy).toLowerCase()) ? orderBy : 'event_at';
  const dir = String(orderDir).toLowerCase() === 'asc' ? 'asc' : 'desc';

  // Filtros dinâmicos
  const where = [];
  const params = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace('?$', `$${params.length}`)); };

  try {
    if (from) add(`event_at >= ?$::date`, from);
    if (to)   add(`event_at <  ?$::date`, to);            // to exclusivo (começo do dia seguinte se vier 2025-10-01)
    if (status)      add(`LOWER(status) = LOWER(?$)`, status);
    if (responsavel) add(`LOWER(responsavel_custo) = LOWER(?$)`, responsavel);
    if (loja)        add(`LOWER(loja_nome) ILIKE LOWER(?$)`, `%${loja}%`);
    if (q) {
      add(`(
            CAST(numero_pedido AS TEXT) ILIKE ?$
         OR LOWER(COALESCE(cliente_nome,'')) ILIKE LOWER(?$)
         OR LOWER(COALESCE(sku,''))          ILIKE LOWER(?$)
         OR LOWER(COALESCE(motivo_codigo,'')) ILIKE LOWER(?$)
         OR LOWER(COALESCE(reclamacao,''))   ILIKE LOWER(?$)
         )`,
         `%${q}%`
      );
      // os ?$ acima contam como 5 params; já foram empurrados numa chamada
      // então precisamos empurrar os 4 extras:
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // 1) total e soma
    const aggSql = `
      SELECT COUNT(*)::int AS total,
             COALESCE(SUM(total),0)::numeric AS sum_total
      FROM return_cost_log
      ${whereSql}
    `;
    const agg = await pool.query(aggSql, params);
    const total = agg.rows[0]?.total || 0;
    const sum_total = agg.rows[0]?.sum_total || 0;

    // 2) paginação
    const listSql = `
      SELECT
        id, return_id,
        event_at, status, regra_aplicada, responsavel_custo,
        valor_produto, valor_frete, total,
        loja_nome, numero_pedido, cliente_nome, sku, motivo_codigo, reclamacao
      FROM return_cost_log
      ${whereSql}
      ORDER BY ${orderCol} ${dir}
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `;
    const list = await pool.query(listSql, [...params, sizeNum, offset]);

    res.json({
      items: list.rows,
      total,
      sum_total
    });
  } catch (e) {
    console.error('[GET /api/returns/logs] erro:', e); // <-- vai pro log do servidor
    res.status(500).json({ error: 'Falha ao carregar logs', detail: e.message });
  }
});

export default router;
