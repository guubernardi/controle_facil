const express = require('express');
const router = express.Router();
const { query } = require('../db'); // Ajuste se necessário para ../db ou ./db dependendo da pasta

// GET /api/returns - Listagem principal (Alimenta o Kanban e a Lista)
router.get('/', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '50');
    const offset = parseInt(req.query.offset || '0');
    const search = (req.query.search || '').trim();
    const status = (req.query.status || '').trim(); // ex: 'em_transporte'
    
    const params = [];
    let whereClauses = [];
    
    // Filtro por Tenant (Multi-cliente)
    if (req.session?.user?.tenant_id) {
      whereClauses.push(`tenant_id = $${params.length + 1}`);
      params.push(req.session.user.tenant_id);
    }

    // 1. Busca (Scanner/Texto)
    if (search) {
      whereClauses.push(`(
        id_venda ILIKE $${params.length + 1} OR 
        sku ILIKE $${params.length + 1} OR 
        cliente_nome ILIKE $${params.length + 1} OR
        nfe_chave ILIKE $${params.length + 1} OR
        CAST(id AS TEXT) = $${params.length + 1}
      )`);
      params.push(`%${search}%`);
    }

    // 2. Filtro por Status (Mapeamento Inteligente)
    if (status) {
      // Mapeia status do frontend para status do banco (ML + Interno)
      if (status === 'em_transporte') {
        whereClauses.push(`(status = 'em_transporte' OR ml_return_status IN ('shipped', 'pending_delivered'))`);
      } 
      else if (status === 'disputa') {
        whereClauses.push(`(status IN ('disputa', 'mediacao') OR ml_return_status IN ('dispute', 'mediation'))`);
      }
      else if (status === 'concluida') {
        whereClauses.push(`(status IN ('concluida', 'finalizado') OR log_status = 'recebido_cd')`);
      }
      else {
        // Fallback: busca exata
        whereClauses.push(`(status = $${params.length + 1} OR log_status = $${params.length + 1})`);
        params.push(status);
      }
    }

    const whereSql = whereClauses.length ? 'WHERE ' + whereClauses.join(' AND ') : '';
    
    // Query Principal
    const sql = `
      SELECT id, id_venda, cliente_nome, loja_nome, sku, 
             status, log_status, ml_return_status, 
             updated_at, created_at, valor_produto
      FROM devolucoes
      ${whereSql}
      ORDER BY updated_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    
    const countSql = `SELECT COUNT(*) as total FROM devolucoes ${whereSql}`;

    const [rowsRes, countRes] = await Promise.all([
      query(sql, [...params, limit, offset]),
      query(countSql, params)
    ]);

    res.json({
      items: rowsRes.rows,
      total: parseInt(countRes.rows[0]?.total || 0)
    });

  } catch (e) {
    console.error('[API] Erro listar returns:', e);
    res.status(500).json({ error: 'Erro interno ao listar' });
  }
});

// PATCH /api/returns/:id - Atualização genérica (Status)
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, log_status, updated_by } = req.body;
    
    // Constrói update dinâmico
    const sets = ['updated_at = NOW()'];
    const vals = [id];
    let idx = 2;

    if (status) { sets.push(`status = $${idx++}`); vals.push(status); }
    if (log_status) { sets.push(`log_status = $${idx++}`); vals.push(log_status); }
    if (updated_by) { sets.push(`updated_by = $${idx++}`); vals.push(updated_by); }

    const sql = `UPDATE devolucoes SET ${sets.join(', ')} WHERE id = $1 RETURNING *`;
    const { rows } = await query(sql, vals);

    if (!rows.length) return res.status(404).json({ error: 'Não encontrado' });
    
    // (Opcional) Se finalizou, dispara worker do ML aqui
    
    res.json(rows[0]);
  } catch (e) {
    console.error('[API] Erro update:', e);
    res.status(500).json({ error: 'Erro ao atualizar' });
  }
});

// PATCH /api/returns/:id/cd/receive - Ação Específica do Scanner
router.patch('/:id/cd/receive', async (req, res) => {
  try {
    const { id } = req.params;
    const { responsavel, when, updated_by } = req.body;

    // 1. Atualiza a devolução
    await query(`
      UPDATE devolucoes 
      SET cd_recebido_em = $1, 
          cd_responsavel = $2,
          log_status = 'recebido_cd',
          updated_at = NOW()
      WHERE id = $3
    `, [when || new Date(), responsavel || 'cd', id]);

    // 2. Insere evento no histórico (Timeline)
    await query(`
      INSERT INTO return_events (return_id, type, title, message, created_by)
      VALUES ($1, 'logistica', 'Recebido no CD', $2, $3)
    `, [id, `Pacote conferido por ${responsavel}`, updated_by || 'scanner']);

    res.json({ ok: true });
  } catch (e) {
    console.error('[API] Erro receive:', e);
    res.status(500).json({ error: 'Erro ao registrar recebimento' });
  }
});

module.exports = router;