// server/routes/dashboard.js
'use strict';

const express = require('express');
const router  = express.Router();
const { query } = require('../db');

// Mesma regra usada nos logs: custo aplicado por devolução
const COST_EXPR = `
  CASE
    WHEN lower(coalesce(status,'')) ~ 'rej|neg' THEN 0
    WHEN lower(coalesce(tipo_reclamacao, reclamacao, '')) LIKE 'cliente%' THEN 0
    WHEN lower(coalesce(log_status,'')) IN ('recebido_cd','em_inspecao') THEN coalesce(valor_frete,0)
    ELSE coalesce(valor_produto,0) + coalesce(valor_frete,0)
  END
`;

router.get('/', async (req, res) => {
  try {
    const { from, to } = req.query;
    const limitTop = Math.max(1, Math.min(parseInt(req.query.limitTop || '10', 10), 50));

    const params = [];
    const where = ['deleted_at IS NULL'];
    if (from) { params.push(from); where.push(`data_compra >= $${params.length}::date`); }
    if (to)   { params.push(to);   where.push(`data_compra <  ($${params.length}::date + interval '1 day')`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // Totais do período
    const sqlTotals = `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE lower(status) LIKE 'pend%')::int AS pendentes,
        COUNT(*) FILTER (WHERE lower(status) LIKE 'autor%' OR lower(status) LIKE 'aprov%')::int AS aprovadas,
        COUNT(*) FILTER (WHERE lower(status) LIKE 'rej%'  OR lower(status) LIKE 'neg%')::int   AS rejeitadas,
        COALESCE(SUM(${COST_EXPR}),0)::numeric(12,2) AS prejuizo_total
      FROM devolucoes
      ${whereSql}
    `;

    // Séries
    const sqlDaily = `
      SELECT to_char(data_compra::date,'YYYY-MM-DD') AS date,
             COALESCE(SUM(${COST_EXPR}),0)::numeric(12,2) AS prejuizo
      FROM devolucoes
      ${whereSql}
      GROUP BY 1 ORDER BY 1
    `;
    const sqlMonthly = `
      SELECT to_char(date_trunc('month', data_compra),'YYYY-MM') AS ym,
             COALESCE(SUM(${COST_EXPR}),0)::numeric(12,2) AS prejuizo
      FROM devolucoes
      ${whereSql}
      GROUP BY 1 ORDER BY 1
    `;
    const sqlStatus = `
      SELECT
        CASE
          WHEN lower(status) LIKE 'pend%' THEN 'pendente'
          WHEN lower(status) LIKE 'autor%' OR lower(status) LIKE 'aprov%' THEN 'aprovado'
          WHEN lower(status) LIKE 'rej%'   OR lower(status) LIKE 'neg%'   THEN 'rejeitado'
          ELSE 'outros'
        END AS k,
        COUNT(*)::int AS n
      FROM devolucoes
      ${whereSql}
      GROUP BY 1
    `;

    // Top itens (SKU)
    const sqlTop = `
      SELECT
        sku,
        COUNT(*)::int AS count,
        mode() within group (
          ORDER BY coalesce(nullif(trim(tipo_reclamacao),''), nullif(trim(reclamacao),''), '—')
        ) AS motivo,
        COALESCE(SUM(${COST_EXPR}),0)::numeric(12,2) AS custo
      FROM devolucoes
      ${whereSql} AND sku IS NOT NULL AND trim(sku) <> ''
      GROUP BY sku
      ORDER BY count DESC, custo DESC
      LIMIT $${params.length + 1}
    `;

    const [tQ, dQ, mQ, sQ, topQ] = await Promise.all([
      query(sqlTotals,  params),
      query(sqlDaily,   params),
      query(sqlMonthly, params),
      query(sqlStatus,  params),
      query(sqlTop,   [...params, limitTop]),
    ]);

    const totalsRow = tQ.rows[0] || {};
    const statusMap = { pendente: 0, aprovado: 0, rejeitado: 0 };
    for (const r of sQ.rows) if (r.k in statusMap) statusMap[r.k] = r.n;

    res.json({
      totals: {
        total:      totalsRow.total ?? 0,
        pendentes:  totalsRow.pendentes ?? 0,
        aprovadas:  totalsRow.aprovadas ?? 0,
        rejeitadas: totalsRow.rejeitadas ?? 0,
        prejuizo:   Number(totalsRow.prejuizo_total || 0),
      },
      daily:   dQ.rows.map(r => ({ date: r.date, prejuizo: Number(r.prejuizo) })),
      monthly: mQ.rows.map(r => ({ ym: r.ym, prejuizo: Number(r.prejuizo) })),
      status:  statusMap,
      top_items: topQ.rows.map(r => ({
        sku: r.sku, count: r.count, motivo: r.motivo || '—', custo: Number(r.custo || 0)
      })),
    });
  } catch (e) {
    console.error('GET /api/dashboard erro:', e);
    res.status(500).json({ error: 'Falha ao montar dashboard' });
  }
});

module.exports = router;
