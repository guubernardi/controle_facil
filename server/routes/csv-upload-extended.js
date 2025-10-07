// server/routes/csv-upload-extended.js
'use strict';

const express = require('express');
const crypto  = require('crypto');
const { query } = require('../db');

/* -------------------- utils -------------------- */
const isTrue = (v) => ['1','true','yes','y','on','sim'].includes(String(v || '').toLowerCase());

function parseNumberBR(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  let s = String(v).trim();
  s = s.replace(/R\$\s?/gi, '').replace(/[^\d,.\-]/g, '');
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',') && !s.includes('.')) s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

const TRUEY = new Set(['1','true','yes','y','on','sim']);
function parseBool(v) { return TRUEY.has(String(v ?? '').trim().toLowerCase()); }

function hashLine(obj) {
  const payload = JSON.stringify(obj);
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

// headers (PT/EN)
function normalizeHeader(h) {
  const x = String(h || '').trim().toLowerCase();
  const map = {
    // ids
    'order_id':'order_id','pedido':'order_id','id_pedido':'order_id','numero_pedido':'order_id',
    'id do pedido (order_id)':'order_id',
    'id do pedido do merchant (merchant_order_id)':'merchant_order_id',
    'shipment_id':'shipment_id','id_envio':'shipment_id',

    // item
    'sku':'sku','item_sku':'sku','seller_sku':'seller_sku','sku do vendedor':'seller_sku',
    'id do item (item_id)':'item_id','id do produto (product_id)':'product_id',

    // datas
    'event_date':'event_date','data_evento':'event_date','date':'event_date',
    'data de criação (date_created)':'date_created',
    'data de criação da transação (operation_date_created)':'operation_date_created',

    // status
    'event_type':'event_type','tipo_evento':'event_type','evento':'event_type',
    'status (status)':'status','detalhe do status (status_detail)':'status_detail',
    'motivo detalhado (reason_detail)':'reason_detail',
    'decisão aplicada a (resolution_applied_to)':'resolution_applied_to',
    'dinheiro da decisão retido (resolution_money_blocked)':'resolution_money_blocked',

    // contraparte
    'nome da contraparte (counterpart_name)':'counterpart_name','counterpart_name':'counterpart_name',

    // valores
    'product_price':'product_price','valor_produto':'product_price','price':'product_price',
    'total':'operation_value','valor_total_operacao':'operation_value','operation_value':'operation_value',
    'valor (amount)':'amount','valor da transação (operation_amount)':'operation_amount',

    // transação
    'id da transação (operation_id)':'operation_id','operation_id':'operation_id',
    'tipo de transação (operation_type)':'operation_type','operation_type':'operation_type',
    'referência externa da transação (operation_external_reference)':'operation_external_reference',
    'operation_external_reference':'operation_external_reference',
    'status da transação (operation_status)':'operation_status','operation_status':'operation_status',
    'marketplace da transação (operation_marketplace)':'operation_marketplace',
    'operation_marketplace':'operation_marketplace',

    // frete
    'shipping_out':'shipping_out','valor_frete_saida':'shipping_out','frete_saida':'shipping_out',
    'shipping_return':'shipping_return','valor_frete_retorno':'shipping_return','frete_retorno':'shipping_return',

    // taxas / moeda
    'ml_fee':'ml_fee','tarifa_ml':'ml_fee','fee':'ml_fee','commission':'ml_fee',
    'cancellation_fee':'cancellation_fee','tarifa_cancelamento':'cancellation_fee',
    'currency':'currency','moeda':'currency',

    // motivo “genérico”
    'reason':'reason','motivo':'reason',
  };
  if (!map[x]) {
    const stripped = x.replace(/\s*\([^)]*\)\s*$/g, '').trim();
    return map[stripped] || stripped.replace(/\s+/g, '_');
  }
  return map[x];
}

function mapReason(detail) {
  const d = String(detail || '').toLowerCase();
  if (!d) return { rotulo: null, categoria: null };
  const dict = {
    'repentant_buyer':'Cliente arrependeu-se',
    'undelivered_repentant_buyer':'Cliente arrependeu-se (não entregue)',
    'not_as_described':'Produto diferente do anúncio',
    'damaged':'Produto avariado','defective':'Produto com defeito',
    'size_does_not_fit':'Tamanho não serviu',
    'seller_cancelled':'Venda cancelada pelo vendedor',
    'buyer_cancelled':'Venda cancelada pelo cliente',
  };
  let rotulo = dict[d] || d.replace(/_/g,' ');
  rotulo = rotulo.charAt(0).toUpperCase() + rotulo.slice(1);
  const categoria =
    d.includes('repentant') || d.includes('buyer_cancelled') ? 'cliente' :
    d.includes('seller_cancelled') ? 'loja' :
    (d.includes('not_as_described')||d.includes('damaged')||d.includes('defective')) ? 'qualidade' :
    null;
  return { rotulo, categoria };
}

function mapStatus(st) {
  const s = String(st || '').toLowerCase();
  if (s === 'approved') return 'aprovado';
  if (s === 'closed')   return 'encerrado';
  if (s === 'covered')  return 'pendente';
  return s || null;
}

function decideTipoEvento({ event_type, status_detail, reason_detail, operation_status }) {
  const e  = String(event_type || '').toLowerCase();
  const sd = String(status_detail || '').toLowerCase();
  const rd = String(reason_detail || '').toLowerCase();
  const os = String(operation_status || '').toLowerCase();
  if (os.includes('charged_back')) return 'chargeback';
  if (e.includes('chargeback'))    return 'chargeback';
  if (sd.includes('refunded') || sd.includes('reconciled') || sd.includes('compensated')) return 'refund';
  if (rd.includes('repentant'))    return 'refund';
  return e || 'other';
}

// decide o valor a debitar do produto
function computeDelta({ operation_value, operation_amount, amount, isRefund, isChargeback }) {
  const v = parseNumberBR(operation_value) || parseNumberBR(operation_amount) || parseNumberBR(amount);
  if ((isRefund || isChargeback) && v !== 0) return Math.abs(v);    // after_collection pode vir positivo
  if (v < 0) return Math.abs(v);                                    // fallback: negativos
  return 0;
}

/* -------------------- CSV helpers -------------------- */
function splitCsvLines(raw) {
  return String(raw || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim().length);
}
function parseCsv(raw) {
  const lines = splitCsvLines(raw);
  if (!lines.length) return { headers: [], rows: [] };
  const headerRaw = lines[0].split(/[,;\t]/g).map((h) => normalizeHeader(h));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(/[,;\t]/g);
    const o = {};
    headerRaw.forEach((h, idx) => { o[h] = cols[idx] != null ? cols[idx].trim() : ''; });
    rows.push(o);
  }
  return { headers: headerRaw, rows };
}

/* -------------------- DB helpers -------------------- */
async function createDevolucaoIfMissing(orderId, { sku, loja_nome, created_by }) {
  const got = await query(`select id from devolucoes where id_venda::text = $1 limit 1`, [String(orderId)]);
  if (got.rows[0]?.id) return got.rows[0].id;
  try {
    const { rows } = await query(
      `insert into devolucoes (id_venda, sku, loja_nome, created_by)
       select $1, $2, $3, $4
       where not exists (select 1 from devolucoes where id_venda::text = $1)
       returning id`,
      [String(orderId), sku || null, loja_nome || null, created_by || 'csv-upload']
    );
    if (rows[0]?.id) {
      const idempKey = `csv-autocreate:${String(orderId)}`;
      await query(
        `insert into return_events (return_id, type, title, message, meta, created_by, created_at, idemp_key)
         values ($1,'csv','Criação por CSV','Stub criado a partir do upload CSV',$2,$3, now(), $4)
         on conflict do nothing`,
        [rows[0].id, JSON.stringify({ order_id: orderId }), created_by || 'csv-upload', idempKey]
      );
      return rows[0].id;
    }
  } catch (e) { if (String(e?.code) !== '42703') throw e; }
  const { rows: r2 } = await query(
    `insert into devolucoes (id_venda, sku, loja_nome)
     select $1, $2, $3
     where not exists (select 1 from devolucoes where id_venda::text = $1)
     returning id`,
    [String(orderId), sku || null, loja_nome || null]
  );
  if (r2[0]?.id) {
    const idempKey = `csv-autocreate:${String(orderId)}`;
    await query(
      `insert into return_events (return_id, type, title, message, meta, created_by, created_at, idemp_key)
       values ($1,'csv','Criação por CSV','Stub criado a partir do upload CSV',$2,$3, now(), $4)
       on conflict do nothing`,
      [r2[0].id, JSON.stringify({ order_id: orderId }), created_by || 'csv-upload', idempKey]
    );
    return r2[0].id;
  }
  const again = await query(`select id from devolucoes where id_venda::text = $1 limit 1`, [String(orderId)]);
  return again.rows[0]?.id || null;
}

/* -------------------- rotas -------------------- */
module.exports = function registerCsvUploadExtended(app, deps = {}) {
  const addReturnEvent =
    typeof deps.addReturnEvent === 'function'
      ? deps.addReturnEvent
      : async ({ returnId, type, title, message, meta, created_by, idemp_key }) => {
          try {
            await query(
              `insert into return_events (return_id, type, title, message, meta, created_by, created_at, idemp_key)
               values ($1,$2,$3,$4,$5,$6, now(), $7)`,
              [returnId, type, title, message, meta ? JSON.stringify(meta) : null, created_by || 'csv-upload', idemp_key]
            );
          } catch (e) { if (String(e?.code) !== '23505') throw e; }
        };

  // Template
  app.get('/api/csv/template', (req, res) => {
    const layout = String(req.query.layout || 'default').toLowerCase();
    let headers = [], sample = [];
    if (layout === 'after_collection') {
      headers = [
        'ID do pedido (order_id)',
        'Data de criação da transação (operation_date_created)',
        'Valor (amount)',
        'Status (status)',
        'Detalhe do status (status_detail)',
        'Motivo detalhado (reason_detail)',
        'SKU'
      ];
      sample = ['NOVO-CSV','2025-10-06T09:30:00Z','-50','closed','refunded','repentant_buyer','SKU-XYZ'];
    } else {
      headers = ['order_id','shipment_id','event_date','product_price','shipping_out','shipping_return',
                 'event_type','sku','ml_fee','cancellation_fee','currency','reason'];
      sample = ['NOVO-CSV','998877','2025-10-03T13:00:00Z','0','20','10','refund','SKU-XYZ','0','0','BRL','arrependimento'];
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.send(headers.join(',') + '\n' + sample.join(',') + '\n');
  });

  // Upload
  app.post('/api/csv/upload',
    express.text({ type: ['text/*','application/octet-stream','*/*'], limit: '5mb' }),
    async (req, res) => {
      const dry        = isTrue(req.query.dry);
      const autocreate = isTrue(req.query.autocreate);
      const idempBatch = (req.query.idemp_batch || '').trim() || null;
      const created_by = req.get('X-User') || 'csv-upload';

      if (!req.body || !String(req.body).trim())
        return res.status(400).json({ ok:false, error:'CSV vazio.' });

      if (!dry && idempBatch) {
        try {
          await query(`insert into ml_csv_imports (batch_key, created_at) values ($1, now())`, [idempBatch]);
        } catch (e) {
          const code = String(e?.code);
          if (code === '23505') return res.json({ ok:true, skipped:true, reason:'Batch já processado', idemp_batch:idempBatch });
          if (code !== '42P01') throw e; // se a tabela não existir, segue
        }
      }

      const p = parseCsv(req.body);
      const parsedRows = p.rows;
      const results = { ok:true, total:parsedRows.length, created:0, updated:0, errors:0, errors_detail:[], idemp_batch:idempBatch || null };

      for (let i=0; i<parsedRows.length; i++) {
        const r = parsedRows[i];

        // order_id obrigatório (aceita merchant_order_id)
        let order_id = (r.order_id || '').trim();
        if (!order_id && r.merchant_order_id) order_id = String(r.merchant_order_id).trim();
        if (!order_id) {
          results.errors++; results.errors_detail.push({ line:i+2, error:'Linha sem order_id (obrigatório).', raw:r });
          continue;
        }

        // números / moeda
        const product_price   = parseNumberBR(r.product_price);
        const ship_out        = parseNumberBR(r.shipping_out);
        const ship_ret        = parseNumberBR(r.shipping_return);
        const operation_value = parseNumberBR(r.operation_value);
        const operation_amount= parseNumberBR(r.operation_amount);
        const amount          = parseNumberBR(r.amount);
        const ml_fee          = parseNumberBR(r.ml_fee);
        const cancellation_fee= parseNumberBR(r.cancellation_fee);
        const currency        = (r.currency || 'BRL').toUpperCase();

        // status / detalhes / razão
        const status         = mapStatus(r.status || '');
        const status_detail  = r.status_detail || '';
        const reason_detail  = r.reason_detail || r.reason || '';
        const { rotulo: reason_label, categoria: reason_cat } = mapReason(reason_detail);
        const operation_status = r.operation_status || '';

        const event_type   = decideTipoEvento({ event_type:r.event_type, status_detail, reason_detail, operation_status });
        const isChargeback = event_type === 'chargeback';
        const isRefund     = event_type === 'refund';

        // SKU preferindo seller_sku; item_id/product_id vai pro meta
        const chosenSku = (r.seller_sku || r.sku || '').trim() || null;
        const mlListing = r.item_id || r.product_id || null;

        // cliente
        const cliente_nome = r.counterpart_name || null;

        // resolução
        const resolution_applied_to    = r.resolution_applied_to || null;
        const resolution_money_blocked = parseBool(r.resolution_money_blocked);

        // garantir devolução
        let returnId = null;
        try {
          const current = await query(`select id, valor_produto, valor_frete, sku, cliente_nome, status from devolucoes where id_venda::text = $1 limit 1`, [order_id]);
          if (current.rows[0]?.id) {
            returnId = current.rows[0].id;
          } else if (autocreate) {
            returnId = await createDevolucaoIfMissing(order_id, { sku: chosenSku, loja_nome:'Mercado Livre', created_by });
            if (returnId) results.created++;
          } else {
            continue;
          }
        } catch (e) {
          results.errors++; results.errors_detail.push({ line:i+2, error:'Falha ao garantir devolução.', order_id, detail:String(e) });
          continue;
        }

        // valores atuais
        const { rows: curRows } = await query(`select valor_produto, valor_frete, sku, cliente_nome, status from devolucoes where id = $1`, [returnId]);
        const cur = curRows[0] || { valor_produto:0, valor_frete:0, sku:null, cliente_nome:null, status:null };

        let novoValorProduto = Number(cur.valor_produto || 0);
        let novoValorFrete   = Number(cur.valor_frete || 0);

        const eventos = [];

        // frete: maior absoluto entre saída e retorno
        const maiorFrete = Math.max(Math.abs(ship_out), Math.abs(ship_ret));
        if (maiorFrete > Math.abs(Number(cur.valor_frete || 0))) {
          novoValorFrete = maiorFrete;
          const idemp = `csv:${hashLine({ k:'frete', order_id, maiorFrete })}:${returnId}`;
          eventos.push({
            type:'custo',
            title:'Frete do retorno atualizado',
            message:`Frete ajustado para ${maiorFrete.toFixed(2)}.`,
            meta:{ order_id, shipping_out:ship_out, shipping_return:ship_ret },
            idemp_key:idemp
          });
        }

        // refund/chargeback → debitar (FIX: precedência correta)
        const delta =
          computeDelta({ operation_value, operation_amount, amount, isRefund, isChargeback }) ||
          (product_price > 0 ? product_price : 0);

        if ((isRefund || isChargeback) && delta > 0) {
          const novo = Math.max(0, novoValorProduto - delta);
          if (novo !== novoValorProduto) {
            novoValorProduto = novo;
            const idemp = `csv:${hashLine({ k:isChargeback ? 'chargeback':'refund', order_id, delta })}:${returnId}`;
            eventos.push({
              type:'ajuste',
              title: isChargeback ? 'Chargeback ML' : 'Refund ML',
              message:`${isChargeback ? 'Chargeback':'Refund'} de ${delta.toFixed(2)} aplicado ao valor do produto.`,
              meta: {
                order_id, event_type, delta,
                reason_detail, reason_label, reason_cat,
                operation_value, operation_amount, amount,
                operation_status, status_detail,
                ml_listing: mlListing || undefined,
                resolution_applied_to, resolution_money_blocked
              },
              idemp_key:idemp
            });
          }
        }

        // UPDATE dinâmico
        const setCols = ['valor_produto = $1', 'valor_frete = $2'];
        const params  = [novoValorProduto, novoValorFrete];

        if (chosenSku && chosenSku !== cur.sku) { setCols.push(`sku = $${params.length+1}`); params.push(chosenSku); }
        if (status && status !== cur.status)     { setCols.push(`status = $${params.length+1}`); params.push(status); }
        if (cliente_nome && !cur.cliente_nome)   { setCols.push(`cliente_nome = $${params.length+1}`); params.push(cliente_nome); }
        if (ml_fee)          { setCols.push(`ml_fee = $${params.length+1}`);           params.push(ml_fee); }
        if (cancellation_fee){ setCols.push(`cancellation_fee = $${params.length+1}`); params.push(cancellation_fee); }
        if (currency)        { setCols.push(`currency = $${params.length+1}`);         params.push(currency); }

        const doUpdate =
          setCols.length > 2 ||
          novoValorProduto !== Number(cur.valor_produto||0) ||
          novoValorFrete   !== Number(cur.valor_frete||0);

        if (!dry && doUpdate) {
          params.push(returnId);
          try {
            await query(`update devolucoes set ${setCols.join(', ')}, updated_at = now() where id = $${params.length}`, params);
          } catch (e) {
            if (String(e?.code) === '42703') {
              await query(`update devolucoes set valor_produto = $1, valor_frete = $2, updated_at = now() where id = $3`,
                [novoValorProduto, novoValorFrete, returnId]);
            } else { throw e; }
          }
          results.updated++;
        }

        // eventos
        for (const ev of eventos) {
          const meta = ev.meta || {}; meta.line = i+2;
          const idemp = ev.idemp_key || `csv:${hashLine({ ...ev, order_id, line:i+2 })}:${returnId}`;
          if (!dry) {
            await addReturnEvent({ returnId, type:ev.type, title:ev.title, message:ev.message, meta, created_by, idemp_key:idemp });
          }
        }
      }

      res.json(results);
    }
  );
};
