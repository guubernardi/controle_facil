// server/routes/ml-sync.js
'use strict';
const express = require('express');
const dayjs = require('dayjs');
const { query } = require('../db');
const { getAuthedAxios } = require('../mlClient');

function isTrue(v){ return ['1','true','yes','on'].includes(String(v||'').toLowerCase()); }

// Reaproveite helpers do CSV quando possível
async function addReturnEvent({ returnId, type, title, message, meta, idemp_key, created_by='ml-sync' }) {
  const metaStr = meta ? JSON.stringify(meta) : null;
  await query(`
    INSERT INTO return_events (return_id, type, title, message, meta, created_by, created_at, idemp_key)
    VALUES ($1,$2,$3,$4,$5,$6, now(), $7)
    ON CONFLICT (idemp_key) DO NOTHING
  `, [returnId, type, title, message, metaStr, created_by, idemp_key]);
}

async function ensureReturnByOrder({ order_id, sku, created_by }) {
  const got = await query(`select id from devolucoes where id_venda::text=$1 limit 1`, [String(order_id)]);
  if (got.rows[0]?.id) return got.rows[0].id;
  const ins = await query(`
    insert into devolucoes (id_venda, sku, loja_nome, created_by)
    values ($1,$2,'Mercado Livre',$3) returning id
  `, [String(order_id), sku || null, created_by || 'ml-sync']);
  const id = ins.rows[0].id;
  await addReturnEvent({
    returnId: id,
    type: 'ml-sync',
    title: 'Criação por ML Sync',
    message: `Stub criado a partir da API do Mercado Livre (order ${order_id})`,
    meta: { order_id },
    idemp_key: `ml-sync:create:${order_id}`
  });
  return id;
}

module.exports = function registerMlSync(app){
  const router = express.Router();

  // GET /api/ml/claims/import?from=2025-10-01&to=2025-10-08&dry=0
  router.get('/api/ml/claims/import', async (req, res) => {
    try {
      const dry = isTrue(req.query.dry);
      const from = req.query.from ? dayjs(req.query.from).toISOString() : dayjs().subtract(7,'day').toISOString();
      const to   = req.query.to   ? dayjs(req.query.to).toISOString()   : dayjs().toISOString();

      const { http, account } = await getAuthedAxios();

      // 1) Buscar claims do vendedor no intervalo
      // Obs: o caminho exato e filtros podem variar por site/conta; ajuste após validar nos docs/conta.
      // Ex.: /post-purchase/v1/claims/search?seller.id=:user_id&date_created.from=:from&date_created.to=:to
      const { data: search } = await http.get('/post-purchase/v1/claims/search', {
        params: { 'seller.id': account.user_id, 'date_created.from': from, 'date_created.to': to, limit: 100 }
      });

      const items = Array.isArray(search?.data || search?.results) ? (search.data || search.results) : [];
      let processed = 0, created = 0, updated = 0, events = 0, errors = 0;
      const errors_detail = [];

      for (const it of items) {
        try {
          // 2) Ignorar não-devolução se a API retornar misturado
          const type = (it.type || it.claim_type || '').toLowerCase();
          if (type && !type.includes('return')) continue;

          // 3) Enriquecer com detalhes do claim (para pegar order_id, status etc.)
          const claimId = it.id || it.claim_id;
          const { data: det } = await http.get(`/post-purchase/v1/claims/${claimId}`);

          const order_id = det?.resource_id || det?.order_id || it?.resource_id || it?.order_id;
          if (!order_id) continue;

          // Status simplificado
          const statusRaw = (det?.status || it?.status || '').toLowerCase();
          const status = /closed|finalized/.test(statusRaw) ? 'encerrado'
                       : /approved|accepted|authorized/.test(statusRaw) ? 'aprovado'
                       : 'pendente';

          // SKU (se vier do claim; senão tenta via ponte MLB -> SKU quando der)
          const sku = det?.item?.seller_sku || det?.item?.sku || it?.seller_sku || null;

          // 4) Garantir devolução
          const returnId = await ensureReturnByOrder({ order_id, sku, created_by: 'ml-sync' });

          // 5) Atualizar valores mínimos (aqui não mexemos em valores ainda; foco em status e eventos)
          if (!dry) {
            await query(
              `update devolucoes set status = COALESCE($1,status), sku = COALESCE($2,sku), updated_at = now() where id = $3`,
              [status, sku, returnId]
            );
            updated++;
          }

          // 6) Evento idempotente por claim
          const idemp = `ml-claim:${claimId}:${order_id}`;
          if (!dry) {
            await addReturnEvent({
              returnId,
              type: 'ml-claim',
              title: `Claim ${claimId} (${status})`,
              message: `Sincronizado pelo import`,
              meta: { claim_id: claimId, order_id, status_raw: statusRaw },
              idemp_key: idemp
            });
            events++;
          }

          processed++;
        } catch (e) {
          errors++; errors_detail.push({ item: it?.id || it, error: String(e?.response?.data || e.message || e) });
        }
      }

      res.json({ ok: true, from, to, processed, created, updated, events, errors, errors_detail });
    } catch (e) {
      res.status(500).json({ ok:false, error:String(e?.response?.data || e.message || e) });
    }
  });

  app.use(router);
};
