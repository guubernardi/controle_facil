// server/routes/ops.js
'use strict';

const express = require('express');
const { query } = require('../db');

/* ===========================
 * Helpers
 * =========================== */
function truthy(v) {
  return ['1', 'true', 'yes', 'on', 'sim'].includes(String(v || '').toLowerCase());
}

async function tableHasColumns(table, columns) {
  const { rows } = await query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1`,
    [table]
  );
  const set = new Set(rows.map(r => r.column_name));
  const out = {};
  for (const c of columns) out[c] = set.has(c);
  return out;
}

function normalizePatch(body = {}) {
  const map = {
    // status
    status: 'status', situacao: 'status',

    // flow/log status
    log_status: 'log_status', status_log: 'log_status', etapa_logistica: 'log_status',

    // customer
    cliente_nome: 'cliente_nome', nome_cliente: 'cliente_nome',

    // values
    valor_produto: 'valor_produto', valorProduto: 'valor_produto',
    valor_frete: 'valor_frete', valorFrete: 'valor_frete',

    // responsibility
    responsavel_custo: 'responsavel_custo', responsavel: 'responsavel_custo',

    // sku
    sku: 'sku'
  };

  const out = {};
  for (const [k, v] of Object.entries(body)) {
    const col = map[k];
    if (col != null) out[col] = v;
  }
  return out;
}

/* ===========================
 * Routes
 * =========================== */
module.exports = function registerOps(app, { addReturnEvent }) {
  const router = express.Router();

  // -------------------------------------------
  // LIST / SEARCH (used by index and logs pages)
  // -------------------------------------------
  async function searchReturns(req, res) {
    try {
      const {
        q, status, log_status, loja, sku, pendente,
        from, to,
        page = '1', pageSize = '50',
        orderBy = 'created_at', orderDir = 'desc'
      } = req.query;

      const params = [];
      const where = [];

      if (q) {
        const like = `%${q}%`;
        params.push(like, like, like, like);
        where.push(`(CAST(id_venda AS TEXT) ILIKE $${params.length - 3}
                 OR cliente_nome ILIKE $${params.length - 2}
                 OR sku ILIKE $${params.length - 1}
                 OR COALESCE(reclamacao,tipo_reclamacao,'') ILIKE $${params.length})`);
      }
      if (status)     { params.push(status.toLowerCase());     where.push(`LOWER(status) = $${params.length}`); }
      if (log_status) { params.push(log_status.toLowerCase()); where.push(`LOWER(log_status) = $${params.length}`); }
      if (loja)       { params.push(`%${loja}%`);              where.push(`loja_nome ILIKE $${params.length}`); }
      if (sku)        { params.push(`%${sku}%`);               where.push(`sku ILIKE $${params.length}`); }
      if (from)       { params.push(from);                     where.push(`created_at >= $${params.length}`); }
      if (to)         { params.push(to);                       where.push(`created_at <  $${params.length}`); }

      const cols = await tableHasColumns('devolucoes', ['conciliado_em']);
      if (truthy(pendente) && cols.conciliado_em) where.push(`conciliado_em IS NULL`);

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const allowedSort = new Set(['created_at','status','log_status','loja_nome','cliente_nome','valor_produto','valor_frete','id']);
      const col = allowedSort.has(String(orderBy)) ? String(orderBy) : 'created_at';
      const dir = String(orderDir).toLowerCase() === 'asc' ? 'asc' : 'desc';

      const limit   = Math.max(1, Math.min(parseInt(pageSize, 10) || 50, 200));
      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const offset  = (pageNum - 1) * limit;

      const [itemsQ, countQ] = await Promise.all([
        query(
          `SELECT id, id_venda, loja_nome, cliente_nome, status, log_status, sku,
                  valor_produto, valor_frete, created_at
             FROM devolucoes
             ${whereSql}
         ORDER BY ${col} ${dir} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset]
        ),
        query(`SELECT COUNT(*)::int AS total FROM devolucoes ${whereSql}`, params)
      ]);

      res.json({
        items: itemsQ.rows,
        total: countQ.rows[0]?.total || 0,
        page: pageNum,
        pageSize: limit
      });
    } catch (e) {
      console.error('[OPS search] error', e);
      res.status(500).json({ error: 'Falha ao buscar devoluções.' });
    }
  }

  router.get('/api/returns', searchReturns);        // simples
  router.get('/api/returns/search', searchReturns); // alias

  // -------------------------------------------
  // GET ONE
  // -------------------------------------------
  router.get('/api/returns/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'id inválido' });
      const { rows } = await query('SELECT * FROM devolucoes WHERE id = $1 LIMIT 1', [id]);
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json(rows[0]);
    } catch (e) {
      console.error('[OPS get one] error', e);
      res.status(500).json({ error: 'Falha ao buscar devolução.' });
    }
  });

  // -------------------------------------------
  // CREATE (dynamic INSERT + creation event)
  // -------------------------------------------
  router.post('/api/returns', async (req, res) => {
    try {
      const body = req.body || {};
      const {
        id_venda,
        cliente_nome = null,
        loja_id = null,
        loja_nome = null,
        sku = null,
        status = 'pendente',
        valor_produto = 0,
        valor_frete = 0,
        reclamacao = null,
        motivo_codigo = null,
        nfe_numero = null,
        nfe_chave = null,
        responsavel_custo = null,
        created_by = 'api'
      } = body;

      if (!id_venda) return res.status(400).json({ error: 'id_venda obrigatório' });

      const have = await tableHasColumns('devolucoes', [
        'nfe_numero', 'nfe_chave', 'responsavel_custo', 'created_by'
      ]);

      const cols = [
        'id_venda', 'cliente_nome', 'loja_id', 'loja_nome',
        'sku', 'status', 'valor_produto', 'valor_frete',
        'reclamacao', 'motivo_codigo'
      ];
      const vals = [
        id_venda, cliente_nome, loja_id, loja_nome,
        sku, status,
        Number.isFinite(+valor_produto) ? +valor_produto : 0,
        Number.isFinite(+valor_frete) ? +valor_frete : 0,
        reclamacao, motivo_codigo
      ];

      if (have.nfe_numero)        { cols.push('nfe_numero');        vals.push(nfe_numero); }
      if (have.nfe_chave)         { cols.push('nfe_chave');         vals.push(nfe_chave); }
      if (have.responsavel_custo) { cols.push('responsavel_custo'); vals.push(responsavel_custo); }
      if (have.created_by)        { cols.push('created_by');        vals.push(created_by); }

      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      const sql = `INSERT INTO devolucoes (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id`;
      const { rows } = await query(sql, vals);
      const newId = rows[0].id;

      // creation event (best-effort)
      try {
        await addReturnEvent({
          returnId: newId,
          type: 'create',
          title: 'Devolução criada',
          message: body.reclamacao || null,
          meta: { origem: 'ops', payload: body },
          createdBy: 'ops',
          idempKey: `ops:create:${newId}`
        });
      } catch (e) {
        console.warn('[OPS create] event failed:', e.message);
      }

      res.status(201).json({ id: newId });
    } catch (e) {
      console.error('[OPS create] error', e);
      res.status(500).json({ error: 'Falha ao criar devolução.', detail: e.message });
    }
  });

  // -------------------------------------------
  // PATCH (simple edit + event)
  // -------------------------------------------
  async function patchReturn(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'id inválido' });

      const fields = normalizePatch(req.body || {});
      const keys = Object.keys(fields);
      if (!keys.length) return res.status(400).json({ error: 'Nada para atualizar' });

      const sets = [], params = [];
      for (const k of keys) { params.push(fields[k]); sets.push(`${k} = $${params.length}`); }
      params.push(id);

      const sql = `UPDATE devolucoes SET ${sets.join(', ')}, updated_at = now()
                   WHERE id = $${params.length} RETURNING *`;
      const r = await query(sql, params);

      await addReturnEvent({
        returnId: id,
        type: 'ops-edicao',
        title: 'Edição operacional',
        message: 'Campos atualizados',
        meta: fields,
        createdBy: 'ops',
        idempKey: `ops:editar:${id}:${keys.sort().join(',')}:${JSON.stringify(fields)}`
      });

      res.json({ ok: true, item: r.rows[0] });
    } catch (e) {
      console.error('[OPS patch] error', e);
      res.status(500).json({ error: 'Falha ao atualizar.' });
    }
  }
  router.patch('/api/returns/:id', patchReturn);

  // -------------------------------------------
  // FLOW ACTIONS (receive / inspect / conciliate)
  // -------------------------------------------
  router.post('/api/returns/:id/receive', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      await query(`UPDATE devolucoes SET log_status='recebido_cd', updated_at=now() WHERE id=$1`, [id]);
      await addReturnEvent({
        returnId: id, type: 'ops', title: 'Recebido no CD', message: null,
        meta: null, createdBy: 'ops', idempKey: `ops:receber:${id}`
      });
      res.json({ ok: true });
    } catch (e) {
      console.error('[OPS receive] error', e);
      res.status(500).json({ error: 'Falha ao marcar recebido.' });
    }
  });

  router.post('/api/returns/:id/inspect', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const cols = await tableHasColumns('devolucoes', ['cd_inspecionado_em']);
      if (cols.cd_inspecionado_em) {
        await query(`UPDATE devolucoes
                        SET log_status='em_inspecao', cd_inspecionado_em=now(), updated_at=now()
                      WHERE id=$1`, [id]);
      } else {
        await query(`UPDATE devolucoes
                        SET log_status='em_inspecao', updated_at=now()
                      WHERE id=$1`, [id]);
      }
      await addReturnEvent({
        returnId: id, type: 'ops', title: 'Em inspeção', message: null,
        meta: null, createdBy: 'ops', idempKey: `ops:inspecionar:${id}`
      });
      res.json({ ok: true });
    } catch (e) {
      console.error('[OPS inspect] error', e);
      res.status(500).json({ error: 'Falha ao marcar inspecionado.' });
    }
  });

  router.post('/api/returns/:id/conciliate', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const cols = await tableHasColumns('devolucoes', ['conciliado_em']);
      if (cols.conciliado_em) {
        await query(`UPDATE devolucoes SET conciliado_em = now(), updated_at = now() WHERE id = $1`, [id]);
      }
      await addReturnEvent({
        returnId: id, type: 'ops', title: 'Conciliação concluída', message: null,
        meta: null, createdBy: 'ops', idempKey: `ops:conciliar:${id}`
      });
      res.json({ ok: true });
    } catch (e) {
      console.error('[OPS conciliate] error', e);
      res.status(500).json({ error: 'Falha ao conciliar.' });
    }
  });

  // -------------------------------------------
  // NOTE
  // -------------------------------------------
  router.post('/api/returns/:id/note', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { titulo='Nota operacional', title, mensagem, message, meta=null } = req.body || {};
      const finalTitle = title || titulo;
      const finalMsg = message ?? mensagem ?? null;

      const ev = await addReturnEvent({
        returnId: id, type: 'ops-nota', title: finalTitle, message: finalMsg, meta,
        createdBy: 'ops', idempKey: null
      });
      res.json({ ok: true, event: ev });
    } catch (e) {
      console.error('[OPS note] error', e);
      res.status(500).json({ error: 'Falha ao registrar nota.' });
    }
  });

  // -------------------------------------------
  // LOGS (for logs.html)
  // -------------------------------------------
  router.get('/api/returns/logs', async (req, res) => {
    try {
      const {
        from, to, status = '', responsavel = '', loja = '', q = '',
        page = '1', pageSize = '50',
        orderBy = 'event_at', orderDir = 'desc'
      } = req.query;

      const where = [];
      const params = [];

      // Join devolucoes + return_events (qualquer tipo de evento)
      // Filtros
      if (from) { params.push(from); where.push(`e.created_at >= $${params.length}`); }
      if (to)   { params.push(to);   where.push(`e.created_at <  $${params.length}`); }

      if (status) {
        params.push(status.toLowerCase());
        where.push(`LOWER(d.status) = $${params.length}`);
      }
      if (loja) {
        params.push(`%${loja}%`);
        where.push(`d.loja_nome ILIKE $${params.length}`);
      }
      if (q) {
        const like = `%${q}%`;
        params.push(like, like, like);
        where.push(`(CAST(d.id_venda AS TEXT) ILIKE $${params.length-2}
                 OR d.cliente_nome ILIKE $${params.length-1}
                 OR COALESCE(d.sku,'') ILIKE $${params.length})`);
      }

      const have = await tableHasColumns('devolucoes', ['responsavel_custo']);
      if (responsavel && have.responsavel_custo) {
        params.push(responsavel.toLowerCase());
        where.push(`LOWER(d.responsavel_custo) = $${params.length}`);
      }

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const limit   = Math.max(1, Math.min(parseInt(pageSize,10) || 50, 500));
      const pageNum = Math.max(1, parseInt(page,10) || 1);
      const offset  = (pageNum - 1) * limit;

      const col = (orderBy === 'event_at' ? 'e.created_at'
                 : orderBy === 'total'   ? '(COALESCE(d.valor_produto,0)+COALESCE(d.valor_frete,0))'
                 : 'e.created_at');
      const dir = String(orderDir).toLowerCase() === 'asc' ? 'asc' : 'desc';

      const baseSql = `
        FROM return_events e
        JOIN devolucoes d ON d.id = e.return_id
        ${whereSql}
      `;

      const listSql = `
        SELECT
          e.created_at AS event_at,
          d.id         AS return_id,
          d.id_venda   AS numero_pedido,
          d.cliente_nome,
          d.loja_nome,
          d.status,
          (COALESCE(d.valor_produto,0) + COALESCE(d.valor_frete,0)) AS total
        ${baseSql}
        ORDER BY ${col} ${dir}
        LIMIT $${params.length+1} OFFSET $${params.length+2}
      `;

      const countSql = `SELECT COUNT(*)::int AS total ${baseSql}`;
      const sumSql   = `SELECT COALESCE(SUM(COALESCE(d.valor_produto,0)+COALESCE(d.valor_frete,0)),0)::numeric AS sum_total ${baseSql}`;

      const [listQ, countQ, sumQ] = await Promise.all([
        query(listSql, [...params, limit, offset]),
        query(countSql, params),
        query(sumSql, params),
      ]);

      res.json({
        items: listQ.rows,
        total: countQ.rows[0]?.total || 0,
        sum_total: Number(sumQ.rows[0]?.sum_total || 0),
        page: pageNum,
        pageSize: limit
      });
    } catch (e) {
      console.error('[OPS logs] error', e);
      res.status(500).json({ error: 'Falha ao buscar logs.' });
    }
  });

  app.use(router);
};
