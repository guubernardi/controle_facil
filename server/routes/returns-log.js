// server/routes/returns-logs.js
'use strict';

const express = require('express');
const router  = express.Router();
const { query } = require('../db'); // usa seu pool central

// Campos permitidos no ORDER BY
const ORDER_ALLOW = new Set(['event_at','total','valor_produto','valor_frete','numero_pedido','cliente_nome','loja_nome']);

// Normaliza datas YYYY-MM-DD
function parseDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

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

  const where = [];
  const params = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace('?$', `$${params.length}`)); };

  try {
    const dfrom = parseDate(from);
    const dto   = parseDate(to);

    if (dfrom) add(`event_at >= ?$::date`, dfrom);
    // to **inclusivo**: soma 1 dia no comparador
    if (dto)   add(`event_at <  ?$::date + interval '1 day'`, dto);

    if (status)      add(`LOWER(status) = LOWER(?$)`, status);
    if (responsavel) add(`LOWER(responsavel_custo) = LOWER(?$)`, responsavel);
    if (loja)        add(`LOWER(loja_nome) ILIKE LOWER(?$)`, `%${loja}%`);
    if (q) {
      // match simples em campos comuns
      add(`(
            CAST(numero_pedido AS TEXT) ILIKE ?$
         OR LOWER(COALESCE(cliente_nome,'')) ILIKE LOWER(?$)
         OR LOWER(COALESCE(sku,''))          ILIKE LOWER(?$)
         OR LOWER(COALESCE(motivo_codigo,'')) ILIKE LOWER(?$)
         OR LOWER(COALESCE(reclamacao,''))   ILIKE LOWER(?$)
         )`, `%${q}%`);
      // empurra os 4 extras
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // 1) agregados
    const aggSql = `
      SELECT COUNT(*)::int AS total,
             COALESCE(SUM(total),0)::numeric AS sum_total
      FROM return_cost_log
      ${whereSql}
    `;
    const agg = await query(aggSql, params);
    const total = agg.rows[0]?.total || 0;
    const sum_total = Number(agg.rows[0]?.sum_total || 0);

    // 2) listagem paginada
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
    const list = await query(listSql, [...params, sizeNum, offset]);

    res.json({ items: list.rows, total, sum_total });
  } catch (e) {
    console.error('[GET /api/returns/logs] erro:', e);
    res.status(500).json({ error: 'Falha ao carregar logs', detail: e.message });
  }
});

module.exports = router;
