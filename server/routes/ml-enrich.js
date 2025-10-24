// server/routes/ml-enrich.js
'use strict';

const { query } = require('../db');

async function tableHasColumns(table, cols) {
  const { rows } = await query(
    `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1`,
    [table]
  );
  const set = new Set(rows.map(r => r.column_name));
  const out = {};
  for (const c of cols) out[c] = set.has(c);
  return out;
}

function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

module.exports = function registerMlEnrich(app) {
  // POST /api/ml/returns/:id/enrich
  app.post('/api/ml/returns/:id/enrich', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID inválido' });

      // Carrega a devolução
      const { rows } = await query('SELECT * FROM devolucoes WHERE id=$1', [id]);
      if (!rows.length) return res.status(404).json({ error: 'Não encontrado' });
      const dev = rows[0];

      const has = await tableHasColumns('devolucoes', [
        'id_venda','valor_produto','valor_frete','claim_id','ml_claim_id'
      ]);

      const orderId = dev.id_venda || dev.order_id || null;
      const claimId = (has.claim_id ? dev.claim_id : null) || (has.ml_claim_id ? dev.ml_claim_id : null) || null;

      const token = process.env.MELI_OWNER_TOKEN;
      if (!token) return res.status(400).json({ error: 'MELI_OWNER_TOKEN ausente no servidor' });

      const base = 'https://api.mercadolibre.com';
      const mget = async (path) => {
        const r = await fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          const msg = j?.message || j?.error || r.statusText;
          const e = new Error(`${r.status} ${msg}`);
          e.status = r.status;
          e.payload = j;
          throw e;
        }
        return j;
      };

      // 1) valor_produto: soma unit_price * quantity do pedido
      let valor_produto = dev.valor_produto ?? null;
      if (orderId) {
        try {
          const o = await mget(`/orders/${encodeURIComponent(orderId)}`);
          const items = o.order_items || o.items || [];
          let sum = 0;
          for (const it of items) {
            const unit = toNumber(it?.unit_price ?? it?.sale_price ?? it?.price);
            const qty  = toNumber(it?.quantity ?? 1);
            sum += unit * (qty || 1);
          }
          if (sum > 0) valor_produto = sum;
        } catch (e) {
          // se falhar, prossegue – ainda podemos trazer o frete
          console.warn('[ML ENRICH] /orders falhou:', e.message);
        }
      }

      // 2) valor_frete: custo de devolução (return-cost) por claim
      let valor_frete = dev.valor_frete ?? null;
      if (claimId) {
        try {
          const rc = await mget(`/post-purchase/v1/claims/${encodeURIComponent(claimId)}/charges/return-cost`);
          if (rc && rc.amount != null) valor_frete = toNumber(rc.amount);
        } catch (e) {
          // 404/400 acontecem quando o claim não existe/sem permissão – mantém valor atual
          console.warn('[ML ENRICH] return-cost falhou:', e.message);
        }
      }

      // Nada novo? devolve o registro atual
      if (valor_produto == null && valor_frete == null) {
        return res.json({ item: dev, note: 'sem alterações' });
      }

      // Atualiza apenas o que obteve
      const set = [];
      const p = [];
      if (valor_produto != null) { set.push(`valor_produto=$${p.push(valor_produto)}`); }
      if (valor_frete   != null) { set.push(`valor_frete=$${p.push(valor_frete)}`);   }
      set.push('updated_at=now()');
      p.push(id);

      const upd = await query(
        `UPDATE devolucoes SET ${set.join(', ')} WHERE id=$${p.length} RETURNING *`,
        p
      );

      res.json({ item: upd.rows[0] });
    } catch (e) {
      console.error('[ML ENRICH] erro:', e);
      res.status(500).json({ error: 'Falha ao enriquecer dados do ML', detail: e?.message });
    }
  });
};
