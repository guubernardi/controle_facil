// server/routes/returns.js
'use strict';

const express = require('express');
const { query } = require('../db');

/**
 * Pequenos helpers
 */
function toInt(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function buildDateFrom(rangeDays) {
  const d = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000);
  // ISO compatível com Postgres
  return d.toISOString();
}

/**
 * Colunas permitidas para ORDER BY e seleção
 */
const ALLOWED_COLS = [
  'id',
  'id_venda',
  'cliente_nome',
  'loja_nome',
  'sku',
  'status',
  'log_status',
  'status_operacional',
  'valor_produto',
  'valor_frete',
  'created_at',
  'updated_at'
];

const ORDERABLE = new Set(ALLOWED_COLS);

/**
 * Mapeia uma linha do banco para o payload que o front consome
 */
function mapRow(r) {
  return {
    id: r.id,
    id_venda: r.id_venda,
    cliente_nome: r.cliente_nome,
    loja_nome: r.loja_nome,
    sku: r.sku,
    status: r.status,
    created_at: r.created_at ?? r.updated_at ?? null,
    valor_produto: r.valor_produto,
    valor_frete: r.valor_frete,
    // campos auxiliares do feed
    log_status_suggested: r.log_status || null,
    has_mediation: false
  };
}

module.exports = function registerReturns(app) {
  const router = express.Router();

  /**
   * GET /api/returns
   * Aceita:
   *  - page, pageSize (paginado)
   *  - OU limit & range_days (recortes rápidos)
   *  - orderBy, orderDir
   *  - status (opcional, vírgula separada)
   */
  router.get('/', async (req, res) => {
    try {
      // Compat: três jeitos de paginação/limite
      const limitRaw = toInt(req.query.pageSize ?? req.query.limit, null);
      const pageRaw  = toInt(req.query.page, null);

      const limit = clamp(limitRaw ?? 200, 1, 200);
      const page  = clamp(pageRaw ?? 1, 1, 10_000);
      const offset = (page - 1) * limit;

      // Order
      const orderBy  = ORDERABLE.has(String(req.query.orderBy)) ? String(req.query.orderBy) : 'created_at';
      const orderDir = String(req.query.orderDir || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';

      // Filtros
      const rangeDays = clamp(toInt(req.query.range_days, 0) || toInt(req.query.days, 0) || 0, 0, 90);
      const dateFrom  = rangeDays > 0 ? buildDateFrom(rangeDays) : null;

      const statusFilterRaw = (req.query.status || req.query.statuses || '').toString().trim();
      const statuses = statusFilterRaw ? statusFilterRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

      // Monta WHERE dinâmico simples
      const where = [];
      const params = [];

      if (dateFrom) {
        params.push(dateFrom);
        where.push(`(created_at IS NULL OR created_at >= $${params.length})`);
      }

      if (statuses.length) {
        // status IN (...)
        const base = params.length;
        const ph = statuses.map((_, i) => `$${base + 1 + i}`).join(',');
        params.push(...statuses);
        where.push(`status IN (${ph})`);
      }

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      // Seleção (usa apenas colunas conhecidas)
      const cols = ALLOWED_COLS.join(',');

      const sqlList = `
        SELECT ${cols}
          FROM devolucoes
        ${whereSql}
        ORDER BY ${orderBy} ${orderDir} NULLS LAST
        LIMIT $${params.length + 1}
        OFFSET $${params.length + 2}
      `;

      const sqlCount = `
        SELECT COUNT(*)::int AS n
          FROM devolucoes
        ${whereSql}
      `;

      const list = await query(sqlList, [...params, limit, offset]);
      const count = await query(sqlCount, params);

      const total = count.rows[0]?.n || 0;
      const totalPages = Math.max(1, Math.ceil(total / limit));

      res.json({
        items: list.rows.map(mapRow),
        total,
        page,
        pageSize: limit,
        totalPages
      });
    } catch (e) {
      console.error('[returns] list erro:', e);
      res.status(500).json({ error: 'Falha ao listar devoluções' });
    }
  });

  /**
   * GET /api/returns/search?q=...
   * Mesma estrutura do list, mas força filtro textual, sem paginação (cap 200).
   */
  router.get('/search', async (req, res) => {
    try {
      const q = String(req.query.q || req.query.query || '').trim();
      if (!q) {
        // Se não veio q, delega para a lista padrão (reaproveita a lógica acima)
        req.url = '/';
        return router.handle(req, res);
      }

      // Filtros opcionais compatíveis
      const rangeDays = clamp(toInt(req.query.range_days, 0) || toInt(req.query.days, 0) || 0, 0, 90);
      const dateFrom  = rangeDays > 0 ? buildDateFrom(rangeDays) : null;

      const statusFilterRaw = (req.query.status || req.query.statuses || '').toString().trim();
      const statuses = statusFilterRaw ? statusFilterRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

      const where = [];
      const params = [];

      if (dateFrom) { params.push(dateFrom); where.push(`(created_at IS NULL OR created_at >= $${params.length})`); }
      if (statuses.length) {
        const base = params.length;
        const ph = statuses.map((_, i) => `$${base + 1 + i}`).join(',');
        params.push(...statuses);
        where.push(`status IN (${ph})`);
      }

      params.push(`%${q.replace(/\s+/g, '%')}%`);
      where.push(`(
        CAST(id AS TEXT) ILIKE $${params.length}
        OR CAST(id_venda AS TEXT) ILIKE $${params.length}
        OR COALESCE(cliente_nome,'') ILIKE $${params.length}
        OR COALESCE(loja_nome,'') ILIKE $${params.length}
        OR COALESCE(sku,'') ILIKE $${params.length}
      )`);

      const whereSql = `WHERE ${where.join(' AND ')}`;
      const cols = ALLOWED_COLS.join(',');

      const { rows } = await query(
        `SELECT ${cols}
           FROM devolucoes
         ${whereSql}
         ORDER BY created_at DESC NULLS LAST
         LIMIT 200`,
        params
      );

      res.json({
        items: rows.map(mapRow),
        total: rows.length,
        page: 1,
        pageSize: rows.length,
        totalPages: 1
      });
    } catch (e) {
      console.error('[returns] search erro:', e);
      res.status(500).json({ error: 'Falha na busca de devoluções' });
    }
  });

  /**
   * (Opcional) GET /api/returns/:id  — útil para telas de detalhe
   */
  router.get('/:id', async (req, res) => {
    try {
      const id = toInt(req.params.id, 0);
      if (!id) return res.status(400).json({ error: 'id inválido' });

      const cols = ALLOWED_COLS.join(',');
      const { rows } = await query(
        `SELECT ${cols}
           FROM devolucoes
          WHERE id = $1
          LIMIT 1`,
        [id]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Not found' });
      res.json(mapRow(rows[0]));
    } catch (e) {
      console.error('[returns] get-by-id erro:', e);
      res.status(500).json({ error: 'Falha ao obter devolução' });
    }
  });

  // Monta sob /api/returns
  app.use('/api/returns', router);
  console.log('[BOOT] Returns ok (routes/returns.js)');
};
