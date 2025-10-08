// server/routes/ops-pt.js
'use strict';
const express = require('express');
const { query } = require('../db');

/* ===========================
 * Helpers em português
 * =========================== */
function ehVerdadeiro(v) {
  return ['1','true','yes','on','sim'].includes(String(v || '').toLowerCase());
}

async function tabelaTemColunas(tabela, colunas) {
  const { rows } = await query(
    `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1`,
    [tabela]
  );
  const set = new Set(rows.map(r => r.column_name));
  const out = {};
  for (const c of colunas) out[c] = set.has(c);
  return out;
}

function normalizarCamposAtualizacao(body = {}) {
  // aceita chaves em pt-BR e mapeia para as colunas do banco
  const mapa = {
    // status
    status: 'status', situacao: 'status',

    // status/log do fluxo operacional
    log_status: 'log_status', status_log: 'log_status', etapa_logistica: 'log_status',

    // identificação do cliente
    cliente_nome: 'cliente_nome', nome_cliente: 'cliente_nome',

    // valores
    valor_produto: 'valor_produto', valorProduto: 'valor_produto',
    valor_frete: 'valor_frete', valorFrete: 'valor_frete',

    // responsáveis
    responsavel_custo: 'responsavel_custo', responsavel: 'responsavel_custo',

    // sku
    sku: 'sku'
  };

  const saida = {};
  for (const [chave, valor] of Object.entries(body)) {
    const coluna = mapa[chave];
    if (coluna != null) saida[coluna] = valor;
  }
  return saida;
}

/* ===========================
 * Registro das rotas
 * =========================== */
module.exports = function registrarOperacoes(app, { addReturnEvent }) {
  const router = express.Router();

  // ===========================================================
  // BUSCA OPERACIONAL (lista com filtros)
  // GET /api/returns/search               (original)
  // GET /api/devolucoes/buscar            (alias pt)
  // ===========================================================
  async function buscarDevolucoes(req, res) {
    try {
      const {
        q, status, log_status, loja, sku, pendente,
        from, to,
        page='1', pageSize='50',
        orderBy='created_at', orderDir='desc'
      } = req.query;

      const params = [];
      const where = [];

      if (q) {
        const like = `%${q}%`;
        params.push(like, like, like, like);
        where.push(`(CAST(id_venda AS TEXT) ILIKE $${params.length-3}
                 OR cliente_nome ILIKE $${params.length-2}
                 OR sku ILIKE $${params.length-1}
                 OR COALESCE(reclamacao,tipo_reclamacao,'') ILIKE $${params.length})`);
      }
      if (status)     { params.push(status.toLowerCase());     where.push(`LOWER(status) = $${params.length}`); }
      if (log_status) { params.push(log_status.toLowerCase()); where.push(`LOWER(log_status) = $${params.length}`); }
      if (loja)       { params.push(`%${loja}%`);              where.push(`loja_nome ILIKE $${params.length}`); }
      if (sku)        { params.push(`%${sku}%`);               where.push(`sku ILIKE $${params.length}`); }
      if (from)       { params.push(from);                     where.push(`created_at >= $${params.length}`); }
      if (to)         { params.push(to);                       where.push(`created_at <  $${params.length}`); }

      const cols = await tabelaTemColunas('devolucoes', ['conciliado_em']);
      if (ehVerdadeiro(pendente) && cols.conciliado_em) where.push(`conciliado_em IS NULL`);

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const permitidas = new Set(['created_at','status','log_status','loja_nome','cliente_nome','valor_produto','valor_frete','id']);
      const col = permitidas.has(String(orderBy)) ? String(orderBy) : 'created_at';
      const dir = String(orderDir).toLowerCase() === 'asc' ? 'asc' : 'desc';

      const limit   = Math.max(1, Math.min(parseInt(page,10) || 50, 200));
      const pageNum = Math.max(1, parseInt(page,10) || 1);
      const offset  = (pageNum - 1) * limit;

      const [itemsQ, countQ] = await Promise.all([
        query(`SELECT id, id_venda, loja_nome, cliente_nome, status, log_status, sku,
                      valor_produto, valor_frete, created_at
                 FROM devolucoes ${whereSql}
                 ORDER BY ${col} ${dir} LIMIT $${params.length+1} OFFSET $${params.length+2}`,
              [...params, limit, offset]),
        query(`SELECT COUNT(*)::int AS total FROM devolucoes ${whereSql}`, params)
      ]);

      res.json({ items: itemsQ.rows, total: countQ.rows[0]?.total || 0, page: pageNum, pageSize: limit });
    } catch (e) {
      console.error('[OPS buscar] erro', e);
      res.status(500).json({ error: 'Falha ao buscar devoluções.' });
    }
  }
  router.get('/api/returns/search', buscarDevolucoes);
  router.get('/api/devolucoes/buscar', buscarDevolucoes); // alias pt

  // ===========================================================
  // EDIÇÃO SIMPLES (PATCH)
  // PATCH /api/returns/:id                 (original)
  // PATCH /api/devolucoes/:id              (alias pt)
  // ===========================================================
  async function editarDevolucao(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'id inválido' });

      const campos = normalizarCamposAtualizacao(req.body || {});
      const chaves = Object.keys(campos);
      if (!chaves.length) return res.status(400).json({ error: 'Nada para atualizar' });

      const sets = [], params = [];
      for (const k of chaves) { params.push(campos[k]); sets.push(`${k} = $${params.length}`); }
      params.push(id);

      const sql = `UPDATE devolucoes SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`;
      const r = await query(sql, params);

      await addReturnEvent({
        returnId: id,
        type: 'ops-edicao',
        title: 'Edição operacional',
        message: 'Campos atualizados',
        meta: campos,
        createdBy: 'ops',
        idempKey: `ops:editar:${id}:${chaves.sort().join(',')}:${JSON.stringify(campos)}`
      });

      res.json({ ok: true, item: r.rows[0] });
    } catch (e) {
      console.error('[OPS editar] erro', e);
      res.status(500).json({ error: 'Falha ao atualizar.' });
    }
  }
  router.patch('/api/returns/:id', editarDevolucao);
  router.patch('/api/devolucoes/:id', editarDevolucao); // alias pt

  // ===========================================================
  // RECEBER NO CD
  // POST /api/returns/:id/receive          (original)
  // POST /api/devolucoes/:id/receber       (alias pt)
  // ===========================================================
  async function marcarRecebido(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      await query(`UPDATE devolucoes SET log_status='recebido_cd', updated_at=now() WHERE id=$1`, [id]);
      await addReturnEvent({
        returnId: id, type: 'ops', title: 'Recebido no CD', message: null,
        meta: null, createdBy: 'ops', idempKey: `ops:receber:${id}`
      });
      res.json({ ok: true });
    } catch (e) {
      console.error('[OPS receber] erro', e);
      res.status(500).json({ error: 'Falha ao marcar recebido.' });
    }
  }
  router.post('/api/returns/:id/receive', marcarRecebido);
  router.post('/api/devolucoes/:id/receber', marcarRecebido); // alias pt

  // ===========================================================
  // INSPECIONAR
  // POST /api/returns/:id/inspect          (original)
  // POST /api/devolucoes/:id/inspecionar   (alias pt)
  // ===========================================================
  async function marcarInspecionado(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      const cols = await tabelaTemColunas('devolucoes', ['cd_inspecionado_em']);
      if (cols.cd_inspecionado_em) {
        await query(`UPDATE devolucoes
                        SET log_status='inspecionado', cd_inspecionado_em=now(), updated_at=now()
                      WHERE id=$1`, [id]);
      } else {
        await query(`UPDATE devolucoes
                        SET log_status='inspecionado', updated_at=now()
                      WHERE id=$1`, [id]);
      }
      await addReturnEvent({
        returnId: id, type: 'ops', title: 'Inspecionado', message: null,
        meta: null, createdBy: 'ops', idempKey: `ops:inspecionar:${id}`
      });
      res.json({ ok: true });
    } catch (e) {
      console.error('[OPS inspecionar] erro', e);
      res.status(500).json({ error: 'Falha ao marcar inspecionado.' });
    }
  }
  router.post('/api/returns/:id/inspect', marcarInspecionado);
  router.post('/api/devolucoes/:id/inspecionar', marcarInspecionado); // alias pt

  // ===========================================================
  // CONCILIAR
  // POST /api/returns/:id/conciliate       (original)
  // POST /api/devolucoes/:id/conciliar     (alias pt)
  // ===========================================================
  async function conciliarDevolucao(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      const cols = await tabelaTemColunas('devolucoes', ['conciliado_em']);
      if (cols.conciliado_em) {
        await query(`UPDATE devolucoes SET conciliado_em = now(), updated_at = now() WHERE id = $1`, [id]);
      }
      await addReturnEvent({
        returnId: id, type: 'ops', title: 'Conciliação concluída', message: null,
        meta: null, createdBy: 'ops', idempKey: `ops:conciliar:${id}`
      });
      res.json({ ok: true });
    } catch (e) {
      console.error('[OPS conciliar] erro', e);
      res.status(500).json({ error: 'Falha ao conciliar.' });
    }
  }
  router.post('/api/returns/:id/conciliate', conciliarDevolucao);
  router.post('/api/devolucoes/:id/conciliar', conciliarDevolucao); // alias pt

  // ===========================================================
  // ANOTAÇÃO
  // POST /api/returns/:id/note             (original)
  // POST /api/devolucoes/:id/anotar        (alias pt)
  // ===========================================================
  async function anotar(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      const { titulo='Nota operacional', title, mensagem, message, meta=null } = req.body || {};
      const tituloFinal = title || titulo;
      const mensagemFinal = message ?? mensagem ?? null;

      const ev = await addReturnEvent({
        returnId: id, type: 'ops-nota', title: tituloFinal, message: mensagemFinal, meta,
        createdBy: 'ops', idempKey: null
      });
      res.json({ ok: true, event: ev });
    } catch (e) {
      console.error('[OPS anotar] erro', e);
      res.status(500).json({ error: 'Falha ao registrar nota.' });
    }
  }
  router.post('/api/returns/:id/note', anotar);
  router.post('/api/devolucoes/:id/anotar', anotar); // alias pt

  app.use(router);
};
