'use strict';
const express = require('express');
const dayjs = require('dayjs');
const { query } = require('../db');

module.exports = function registerHomeKpis(app) {
  const router = express.Router();

  // GET /api/home/kpis?from=2025-10-01&to=2025-10-08
  router.get('/api/home/kpis', async (req, res) => {
    try {
      const fromIso = req.query.from ? dayjs(req.query.from).toISOString() : dayjs().subtract(7,'day').toISOString();
      const toIso   = req.query.to   ? dayjs(req.query.to).toISOString()   : dayjs().toISOString();

      // 1) Itens que voltaram
      const r1 = await query(
        `SELECT COUNT(*)::int AS qtd
         FROM devolucoes
         WHERE created_at >= $1 AND created_at < $2`,
        [fromIso, toIso]
      );
      const itens_que_voltaram = r1.rows[0]?.qtd || 0;

      // 2) Ganhos/Perdas (se a view não existir, comente este bloco temporariamente)
      let ganhos_perdas = '0.00';
      try {
        const r2 = await query(
          `SELECT COALESCE(SUM(total),0)::numeric(14,2) AS total
           FROM v_return_cost_log
           WHERE event_at >= $1 AND event_at < $2`,
          [fromIso, toIso]
        );
        ganhos_perdas = r2.rows[0]?.total ?? '0.00';
      } catch {
        // view ausente: ignora sem quebrar
      }

      // 3) Top motivos
      const r3 = await query(
        `SELECT LOWER(COALESCE(tipo_reclamacao, reclamacao, 'outros')) AS motivo,
                COUNT(*)::int AS qtd
         FROM devolucoes
         WHERE created_at >= $1 AND created_at < $2
         GROUP BY 1
         ORDER BY qtd DESC
         LIMIT 10`,
        [fromIso, toIso]
      );
      const top_motivos = r3.rows;

      // 4) Heatmap por status (últimos 30 dias do período consultado)
      const r4 = await query(
        `SELECT date_trunc('day', created_at) AS dia,
                LOWER(COALESCE(status,''))     AS status,
                COUNT(*)::int                  AS qtd
         FROM devolucoes
         WHERE created_at >= $1 AND created_at < $2
         GROUP BY 1,2
         ORDER BY 1,2`,
        [fromIso, toIso]
      );
      const heatmap = r4.rows;

      res.json({
        ok: true,
        range: { from: fromIso, to: toIso },
        itens_que_voltaram,
        ganhos_perdas,
        top_motivos,
        heatmap
      });
    } catch (e) {
      res.status(500).json({ ok:false, error: String(e?.message || e) });
    }
  });

  app.use(router);
};

