// server/routes/dashboard.js
'use strict';

const express = require('express');
const dayjs = require('dayjs');
const router = express.Router();
const { query } = require('../db');

// Usa o pool da request (quando existir) ou o global
const qOf = (req) => req.q || query;

function parseDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/); // YYYY-MM-DD
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return Number.isNaN(+d) ? null : `${m[1]}-${m[2]}-${m[3]}`;
}

async function columnsOf(q, table) {
  const { rows } = await q(
    `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1`,
    [table]
  );
  return new Set(rows.map(r => r.column_name));
}

router.get('/ping', (_req, res) => res.json({ ok: true }));

router.get('/summary', async (req, res) => {
  try {
    const q = qOf(req);

    // Período (default: últimos 30 dias)
    const today = dayjs().format('YYYY-MM-DD');
    const dfrom = parseDate(req.query.from) || dayjs().subtract(30, 'day').format('YYYY-MM-DD');
    const dto   = parseDate(req.query.to)   || today;

    // Descobre colunas disponíveis de 'devolucoes'
    const cols = await columnsOf(q, 'devolucoes');

    // Coluna de data preferida
    const dateCol =
      (cols.has('created_at') && 'created_at') ||
      (cols.has('data')       && 'data')       ||
      (cols.has('dt')         && 'dt')         ||
      'created_at';

    // Expressão de categoria de status
    const statusCat = `
      CASE
        WHEN LOWER(COALESCE(status,'')) IN ('rejeitado','rejeitada','negado','negada') THEN 'rejeitado'
        WHEN LOWER(COALESCE(status,'')) IN ('autorizado','autorizada','aprovado','aprovada') THEN 'autorizado'
        WHEN LOWER(COALESCE(status,'')) IN ('concluido','concluida','finalizado','finalizada','fechado','fechada','encerrado','encerrada') THEN 'finalizado'
        ELSE 'aberto'
      END
    `;

    // Contagens
    const { rows: [counts] } = await q(
      `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE ${statusCat}='aberto')::int      AS abertas,
        COUNT(*) FILTER (WHERE ${statusCat}='autorizado')::int  AS autorizadas,
        COUNT(*) FILTER (WHERE ${statusCat}='rejeitado')::int   AS rejeitadas
      FROM devolucoes
      WHERE ${dateCol}::date BETWEEN $1 AND $2
      `,
      [dfrom, dto]
    );

    // Prejuízo total (se existir coluna)
    let prejuizoTotal = 0;
    if (cols.has('prejuizo_aplicado')) {
      const { rows: [r] } = await q(
        `SELECT COALESCE(SUM(prejuizo_aplicado),0)::numeric AS n
           FROM devolucoes
          WHERE ${dateCol}::date BETWEEN $1 AND $2`,
        [dfrom, dto]
      );
      prejuizoTotal = Number(r?.n || 0);
    }

    // Série diária (contagens + prejuízo se existir)
    const serieSql = `
      SELECT
        to_char(${dateCol}::date,'YYYY-MM-DD') AS d,
        COUNT(*) FILTER (WHERE ${statusCat}='aberto')::int     AS abertas,
        COUNT(*) FILTER (WHERE ${statusCat}='autorizado')::int AS autorizadas,
        COUNT(*) FILTER (WHERE ${statusCat}='rejeitado')::int  AS rejeitadas
        ${cols.has('prejuizo_aplicado') ? ', COALESCE(SUM(prejuizo_aplicado),0)::numeric AS prejuizo' : ''}
      FROM devolucoes
      WHERE ${dateCol}::date BETWEEN $1 AND $2
      GROUP BY 1
      ORDER BY 1
    `;
    const series = (await q(serieSql, [dfrom, dto])).rows.map(r => ({
      date: r.d,
      abertas: r.abertas,
      autorizadas: r.autorizadas,
      rejeitadas: r.rejeitadas,
      prejuizo: Number(r.prejuizo || 0)
    }));

    // Top itens (se existir alguma coluna de item/sku)
    let top_items = [];
    const itemCol = (cols.has('sku') && 'sku') || (cols.has('item_id') && 'item_id') || null;
    if (itemCol) {
      const motivoCol = (cols.has('motivo') && 'motivo') || (cols.has('motivo_cliente') && 'motivo_cliente') || null;
      const custoCol  = cols.has('prejuizo_aplicado') ? 'prejuizo_aplicado' : null;
      const sql = `
        SELECT
          ${itemCol} AS item,
          COUNT(*)::int AS qtd
          ${motivoCol ? `, MODE() WITHIN GROUP (ORDER BY ${motivoCol}) AS motivo` : ''}
          ${custoCol  ? `, COALESCE(SUM(${custoCol}),0)::numeric AS custo` : ''}
        FROM devolucoes
        WHERE ${dateCol}::date BETWEEN $1 AND $2
        GROUP BY ${itemCol}
        ORDER BY COUNT(*) DESC
        LIMIT 10
      `;
      top_items = (await q(sql, [dfrom, dto])).rows.map(r => ({
        item: r.item,
        qtd: r.qtd,
        motivo: r.motivo || null,
        custo: Number(r.custo || 0)
      }));
    }

    res.json({
      period: { from: dfrom, to: dto },
      totals: {
        devolucoes: counts?.total || 0,
        abertas: counts?.abertas || 0,
        autorizadas: counts?.autorizadas || 0,
        rejeitadas: counts?.rejeitadas || 0,
        prejuizo_total: prejuizoTotal
      },
      series,
      top_items
    });
  } catch (e) {
    console.error('[dashboard] fail', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

module.exports = router;
