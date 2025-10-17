// server/routes/central.js
'use strict';

const { query } = require('../db');

/** helper: checa colunas de uma tabela */
async function tableHasColumns(table, cols) {
  const { rows } = await query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1`,
    [table]
  );
  const set = new Set(rows.map(r => r.column_name));
  const out = {};
  for (const c of cols) out[c] = set.has(c);
  return out;
}

/** normaliza nome de loja -> marketplace “Shopee/Mercado Livre/Magalu/Outros” */
function lojaToMarketplaceSql(expr) {
  // Retorna um CASE SQL usando o campo passado (já tratado com COALESCE)
  return `
    CASE
      WHEN lower(${expr}) LIKE '%shopee%' THEN 'Shopee'
      WHEN lower(${expr}) ~ '(mercado|meli|mlb|ml )' THEN 'Mercado Livre'
      WHEN lower(${expr}) ~ '(magalu|magazine)' THEN 'Magalu'
      ELSE 'Outros'
    END
  `;
}

module.exports = function registerCentral(app) {
  /**
   * GET /api/central/overview?from=YYYY-MM-DD&to=YYYY-MM-DD
   * Retorna:
   * - open_by_marketplace: [{ marketplace, qtd }]
   * - in_transit: últimos itens “a caminho” (status/log_status indicativos)
   */
  app.get('/api/central/overview', async (req, res) => {
    try {
      const cols = await tableHasColumns('devolucoes', [
        'status', 'loja_nome', 'log_status', 'created_at', 'updated_at',
        'id', 'id_venda', 'nfe_numero', 'sku'
      ]);

      // Se nem status existe, não temos base
      if (!cols.status) {
        return res.json({ open_by_marketplace: [], in_transit: [], range: null });
      }

      // Range padrão: últimos 30 dias [from, to)
      const now = new Date();
      const defaultTo   = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
        .toISOString().slice(0, 10);
      const defaultFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29)
        .toISOString().slice(0, 10);

      const pFrom = (req.query.from || defaultFrom);
      const pTo   = (req.query.to   || defaultTo);

      const params = [];
      const where = [];

      // Se existir created_at, aplica janela; senão, segue sem range
      if (cols.created_at) {
        params.push(pFrom); where.push(`created_at >= $${params.length}`);
        params.push(pTo);   where.push(`created_at <  $${params.length}`);
      }
      const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

      /* =======================
       * 1) Abertas por marketplace
       * ======================= */
      const lojaExpr = cols.loja_nome ? "COALESCE(loja_nome,'(sem loja)')" : `'(sem loja)'`;
      const mkCase = lojaToMarketplaceSql(lojaExpr);

      // Considera “abertas” regex abrangente (pendente / aberta / análise / aguardando)
      const qOpen = await query(
        `
        WITH base AS (
          SELECT
            ${mkCase} AS marketplace,
            lower(COALESCE(status,'')) AS st
          FROM devolucoes
          ${whereSql}
        )
        SELECT marketplace, COUNT(*)::int AS qtd
        FROM base
        WHERE st ~ '(pend|abert|anal|aguard)'
        GROUP BY 1
        ORDER BY qtd DESC, marketplace ASC
        LIMIT 10
        `,
        params
      );

      /* =======================
       * 2) “A caminho”
       * ======================= */
      // coluna de data preferindo updated_at > created_at quando existir
      const tsExpr = cols.updated_at
        ? 'COALESCE(updated_at, created_at, now())'
        : (cols.created_at ? 'COALESCE(created_at, now())' : 'now()');

      // Campos de ID de pedido
      const pedidoExpr = cols.id_venda
        ? 'COALESCE(id_venda::text, nfe_numero::text, id::text)'
        : (cols.nfe_numero ? 'COALESCE(nfe_numero::text, id::text)' : 'id::text');

      // Critérios “a caminho”
      // Preferimos log_status se existir; senão, inferimos pelo status
      let inTransitRows = [];
      if (cols.log_status) {
        const qTransit = await query(
          `
          SELECT
            id,
            ${pedidoExpr}     AS pedido,
            ${lojaExpr}       AS loja_nome,
            ${cols.sku ? 'COALESCE(sku, \'\')' : '\'\''} AS sku,
            lower(COALESCE(status,''))     AS status,
            lower(COALESCE(log_status,'')) AS log_status,
            ${tsExpr}         AS event_at
          FROM devolucoes
          ${whereSql}
          ${whereSql ? 'AND' : 'WHERE'}
          (
            lower(COALESCE(log_status,'')) ~ '(postad|transit|trânsit|caminh|transpor)'
            OR lower(COALESCE(log_status,'')) IN (
              'recebido_cd','em_inspecao','aguardando_postagem','autorizado_postagem'
            )
          )
          ORDER BY event_at DESC
          LIMIT 20
          `,
          params
        );
        inTransitRows = qTransit.rows;
      } else {
        // Fallback sem log_status: usa status que indicam movimentação
        const qTransit = await query(
          `
          SELECT
            id,
            ${pedidoExpr}     AS pedido,
            ${lojaExpr}       AS loja_nome,
            ${cols.sku ? 'COALESCE(sku, \'\')' : '\'\''} AS sku,
            lower(COALESCE(status,'')) AS status,
            '' AS log_status,
            ${tsExpr}         AS event_at
          FROM devolucoes
          ${whereSql}
          ${whereSql ? 'AND' : 'WHERE'}
          lower(COALESCE(status,'')) ~ '(aprov|autoriz|aguard|pend)'
          ORDER BY event_at DESC
          LIMIT 20
          `,
          params
        );
        inTransitRows = qTransit.rows;
      }

      res.json({
        open_by_marketplace: qOpen.rows,
        in_transit: inTransitRows,
        range: { from: pFrom, to: pTo }
      });
    } catch (e) {
      console.error('[central] /api/central/overview erro:', e);
      res.status(500).json({ error: 'Falha ao carregar Central.' });
    }
  });
};
