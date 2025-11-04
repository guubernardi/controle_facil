// server/routes/dashboard.js
'use strict';

const express = require('express');
const dayjs   = require('dayjs');
const router  = express.Router();
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

// Constrói expressão SQL para "categoria de status"
function buildStatusCase(colName = 'status') {
  // pendente | aprovado | rejeitado | finalizado (resto vira pendente)
  return `
    CASE
      WHEN LOWER(COALESCE(${colName},'')) ~ 'rej|neg' THEN 'rejeitado'
      WHEN LOWER(COALESCE(${colName},'')) ~ 'autorizad|aprov' THEN 'aprovado'
      WHEN LOWER(COALESCE(${colName},'')) ~ 'conclu|finaliz|fechad|encerrad' THEN 'finalizado'
      ELSE 'pendente'
    END
  `;
}

// Constrói expressão SQL para pegar **SKU** (nunca id de pedido)
// Usa COALESCE de várias colunas textuais e, quando existirem, campos JSON.
function buildSkuExpr(cols) {
  const parts = [];

  // Textos diretos comuns
  [
    'sku',
    'item_sku',
    'seller_sku',
    'sku_produto',
    'bling_sku',
    'codigo_sku',
    'ml_seller_sku',
    'ml_item_sku',
    'ml_listing_seller_custom_field',
    'ml_variation_seller_custom_field',
  ].forEach(c => {
    if (cols.has(c)) parts.push(`NULLIF(TRIM(${c}), '')`);
  });

  // JSONs comuns
  const jsonCols = ['meta', 'dados', 'info', 'payload', 'extra'];
  jsonCols.forEach(j => {
    if (cols.has(j)) {
      parts.push(`NULLIF(TRIM(${j}->>'sku'), '')`);
      parts.push(`NULLIF(TRIM(${j}->>'seller_sku'), '')`);
      parts.push(`NULLIF(TRIM(${j}->'item'->>'seller_sku'), '')`);
      parts.push(`NULLIF(TRIM(${j}->'variation'->>'seller_sku'), '')`);
    }
  });

  // Se nada existir, cai no '—'
  if (!parts.length) return `'—'`;

  // Limpa strings "null" e "undefined"
  const cleaned = parts.map(p =>
    `NULLIF(NULLIF(LOWER(${p}), 'null'), 'undefined')`
  );

  return `COALESCE(${cleaned.join(', ')}, '—')`;
}

// Constrói expressão SQL para "motivo" (usada no mode())
function buildMotivoExpr(cols) {
  const parts = [];
  ['motivo', 'motivo_cliente', 'tipo_reclamacao', 'reclamacao'].forEach(c => {
    if (cols.has(c)) parts.push(`NULLIF(TRIM(${c}), '')`);
  });
  const jsonCols = ['meta', 'dados', 'info', 'payload', 'extra'];
  jsonCols.forEach(j => {
    if (cols.has(j)) {
      parts.push(`NULLIF(TRIM(${j}->>'motivo'), '')`);
      parts.push(`NULLIF(TRIM(${j}->>'tipo_reclamacao'), '')`);
    }
  });
  if (!parts.length) return `'—'`;
  const cleaned = parts.map(p =>
    `NULLIF(NULLIF(LOWER(${p}), 'null'), 'undefined')`
  );
  return `COALESCE(${cleaned.join(', ')}, '—')`;
}

router.get('/ping', (_req, res) => res.json({ ok: true }));

// =======================
// GET /api/dashboard
// =======================
router.get('/', async (req, res) => {
  try {
    const q = qOf(req);

    // Período (default: mês atual)
    const today = dayjs();
    const defFrom = today.startOf('month').format('YYYY-MM-DD');
    const defTo   = today.add(1, 'month').startOf('month').format('YYYY-MM-DD');

    const dfrom = parseDate(req.query.from) || defFrom;
    const dto   = parseDate(req.query.to)   || defTo;

    let limitTop = Math.min(20, Math.max(1, parseInt(req.query.limitTop || '5', 10) || 5));

    // Checa colunas da tabela
    const cols = await columnsOf(q, 'devolucoes');

    // Coluna de data preferida
    const dateCol =
      (cols.has('created_at') && 'created_at') ||
      (cols.has('data_compra') && 'data_compra') ||
      (cols.has('data')       && 'data')       ||
      (cols.has('dt')         && 'dt')         ||
      'created_at';

    // Nome da coluna de status (fallback: status)
    const statusCol = cols.has('status') ? 'status' : (cols.has('log_status') ? 'log_status' : 'status');
    const statusCase = buildStatusCase(statusCol);

    // Coluna de prejuízo (opcional)
    const prejuCol = cols.has('prejuizo_aplicado') ? 'prejuizo_aplicado'
                    : (cols.has('custo_total') ? 'custo_total' : null);

    // ---------- totals ----------
    const totalsSql = `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE ${statusCase}='pendente')::int   AS pendentes,
        COUNT(*) FILTER (WHERE ${statusCase}='aprovado')::int   AS aprovadas,
        COUNT(*) FILTER (WHERE ${statusCase}='rejeitado')::int  AS rejeitadas
        ${prejuCol ? `, COALESCE(SUM(${prejuCol}),0)::numeric AS prej` : `, 0::numeric AS prej`}
      FROM devolucoes
      WHERE ${dateCol}::date >= $1 AND ${dateCol}::date < $2
    `;
    const totalsRow = (await q(totalsSql, [dfrom, dto])).rows[0] || {};
    const totals = {
      total: totalsRow.total || 0,
      pendentes: totalsRow.pendentes || 0,
      aprovadas: totalsRow.aprovadas || 0,
      rejeitadas: totalsRow.rejeitadas || 0,
      prejuizo_total: Number(totalsRow.prej || 0)
    };

    // ---------- daily ----------
    const dailySql = `
      SELECT
        to_char(${dateCol}::date,'YYYY-MM-DD') AS d
        ${prejuCol ? `, COALESCE(SUM(${prejuCol}),0)::numeric AS prejuizo` : `, 0::numeric AS prejuizo`}
      FROM devolucoes
      WHERE ${dateCol}::date >= $1 AND ${dateCol}::date < $2
      GROUP BY 1
      ORDER BY 1
    `;
    const daily = (await q(dailySql, [dfrom, dto])).rows.map(r => ({
      date: r.d,
      prejuizo: Number(r.prejuizo || 0)
    }));

    // ---------- monthly ----------
    const monthlySql = `
      SELECT
        to_char(date_trunc('month', ${dateCol}::date),'YYYY-MM') AS ym
        ${prejuCol ? `, COALESCE(SUM(${prejuCol}),0)::numeric AS prejuizo` : `, 0::numeric AS prejuizo`}
      FROM devolucoes
      WHERE ${dateCol}::date >= $1 AND ${dateCol}::date < $2
      GROUP BY 1
      ORDER BY 1
    `;
    const monthly = (await q(monthlySql, [dfrom, dto])).rows.map(r => ({
      month: r.ym,
      prejuizo: Number(r.prejuizo || 0)
    }));

    // ---------- status distribution ----------
    const statusSql = `
      SELECT ${statusCase} AS k, COUNT(*)::int AS n
      FROM devolucoes
      WHERE ${dateCol}::date >= $1 AND ${dateCol}::date < $2
      GROUP BY 1
    `;
    const statusRows = (await q(statusSql, [dfrom, dto])).rows || [];
    const status = {};
    statusRows.forEach(r => { status[r.k] = r.n; });

    // ---------- top_items (por SKU) ----------
    const skuExpr = buildSkuExpr(cols);
    const motivoExpr = buildMotivoExpr(cols);

    // Se não houver nenhuma forma de SKU, devolve vazio
    let top_items = [];
    if (skuExpr !== `'—'`) {
      const topSql = `
        SELECT
          ${skuExpr} AS sku,
          COUNT(*)::int AS devolucoes,
          MODE() WITHIN GROUP (ORDER BY ${motivoExpr}) AS motivo_comum
          ${prejuCol ? `, COALESCE(SUM(${prejuCol}),0)::numeric AS prejuizo` : `, 0::numeric AS prejuizo`}
        FROM devolucoes
        WHERE ${dateCol}::date >= $1 AND ${dateCol}::date < $2
          AND ${skuExpr} IS NOT NULL AND ${skuExpr} <> '—'
        GROUP BY 1
        ORDER BY devolucoes DESC, sku ASC
        LIMIT ${limitTop}
      `;
      top_items = (await q(topSql, [dfrom, dto])).rows.map(r => ({
        sku: r.sku,
        devolucoes: r.devolucoes,
        prejuizo: Number(r.prejuizo || 0),
        motivo_comum: r.motivo_comum || '—'
      }));
    }

    res.json({
      period: { from: dfrom, to: dto },
      totals,
      daily,
      monthly,
      status,
      top_items
    });
  } catch (e) {
    console.error('[dashboard] fail', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

module.exports = router;
