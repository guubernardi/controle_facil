'use strict';

const express = require('express');
const crypto  = require('crypto');
const { query } = require('../db');

/**
 * Registra as rotas de CSV (Mercado Livre pós-venda).
 * Usa addReturnEvent injetado; se não vier, cai em fallback com tratamento de 23505.
 */
module.exports = function registrarRotasCsv(app, deps = {}) {
  // addReturnEvent com tolerância a 23505 (idempotência)
  const addReturnEvent =
    typeof deps.addReturnEvent === 'function'
      ? deps.addReturnEvent
      : async function fallbackAddReturnEvent(ev) {
          const metaStr = ev.meta ? JSON.stringify(ev.meta) : null;
          try {
            const { rows } = await query(
              `
              INSERT INTO return_events (return_id, type, title, message, meta, created_by, created_at, idemp_key)
              VALUES ($1,$2,$3,$4,$5,$6, now(), $7)
              RETURNING id
              `,
              [
                ev.returnId,
                ev.type || 'status',         // default seguro
                ev.title || null,
                ev.message || null,
                metaStr,
                ev.createdBy || 'csv-upload',
                ev.idempKey || null
              ]
            );
            return rows[0];
          } catch (e) {
            // 23505: já existe evento com o mesmo idemp_key → OK, idempotente
            if (String(e?.code) === '23505') return { id: null, duplicate: true };
            throw e;
          }
        };

  /* ---------- helpers ---------- */

  /** Heurística simples para detectar delimitador. */
  function detectDelimiter(text) {
    const first = text.split(/\r?\n/).find(Boolean) || '';
    const counts = {
      ';': (first.match(/;/g) || []).length,
      ',': (first.match(/,/g) || []).length,
      '\t': (first.match(/\t/g) || []).length,
    };
    return Object.entries(counts).sort((a,b)=>b[1]-a[1])[0]?.[0] || ',';
  }

  /** Normaliza rótulos: sem acento, snake_case, só [a-z0-9_]. */
  function norm(s = '') {
    return String(s)
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^\w_]/g, '')
      .trim();
  }

  /** Pega a 1ª chave com valor não-vazio. */
  function pick(obj, keys) {
    for (const k of keys) if (obj[k] != null && obj[k] !== '') return obj[k];
    return null;
  }

  /** Converte número pt-BR/EN para float. */
  function toNum(x) {
    if (x == null || x === '') return null;
    const s = String(x).replace(/\./g, '').replace(',', '.');
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  /** Mapeia a linha crua para o nosso modelo. */
  function mapRowToModel(rowObj) {
    const o = {};
    for (const [k, v] of Object.entries(rowObj)) o[norm(k)] = v;

    const orderId   = pick(o, ['id_da_venda', 'id_venda', 'order_id', 'idpedido', 'pedido']);
    const shipment  = pick(o, ['id_do_envio', 'shipment_id', 'idenvio']);
    const tipo      = pick(o, ['tipo', 'type', 'evento', 'movimento']);
    const descricao = pick(o, ['descricao', 'description', 'detalhe', 'motivo']);
    const data      = pick(o, ['data', 'data_da_operacao', 'created_at', 'data_evento']);

    // valores aceitos (vários layouts):
    // - valor / amount / total
    // - frete (ou soma de shipping_out + shipping_return)
    const valor     = pick(o, ['valor', 'amount', 'valor_total', 'valor_da_operacao', 'total']);
    const freteOne  = pick(o, ['frete', 'shipping_cost', 'custo_envio']);
    const shipOut   = toNum(pick(o, ['shipping_out']));
    const shipRet   = toNum(pick(o, ['shipping_return']));
    const freteCalc = (freteOne != null ? toNum(freteOne) : null);
    const frete     = (freteCalc != null ? freteCalc : ((shipOut || 0) + (shipRet || 0)));

    const moeda     = pick(o, ['moeda', 'currency']);
    const tarifa    = pick(o, ['tarifa', 'fee', 'taxa']);

    return {
      orderId: orderId ? String(orderId).trim() : null,
      shipmentId: shipment ? String(shipment).trim() : null,
      tipo: tipo ? String(tipo).trim().toLowerCase() : null,
      descricao: descricao ? String(descricao).trim() : null,
      data: data ? new Date(data) : null,
      valor: toNum(valor),
      tarifa: toNum(tarifa),
      frete: toNum(frete),
      moeda: moeda || 'BRL',
      raw: o
    };
  }

  /** Hash idempotente por linha com campos relevantes. */
  function lineHash(model) {
    const s = JSON.stringify({
      orderId: model.orderId,
      shipmentId: model.shipmentId,
      tipo: model.tipo,
      descricao: model.descricao,
      data: model.data ? new Date(model.data).toISOString() : null,
      valor: model.valor,
      tarifa: model.tarifa,
      frete: model.frete,
      moeda: model.moeda
    });
    return crypto.createHash('sha256').update(s).digest('hex');
  }

  /** Aplica conciliação para 1 linha. */
  async function conciliarLinha(model, { dryRun = false } = {}) {
    // localizar devolução
    let dev = null;
    if (model.orderId) {
      const r = await query(
        `select id, status, valor_produto, valor_frete, loja_nome
           from devolucoes
          where id_venda::text = $1
          order by id desc limit 1`,
        [String(model.orderId)]
      );
      dev = r.rows[0] || null;
    }
    if (!dev) return { ok: false, reason: 'no-match' };

    const before = { vp: Number(dev.valor_produto || 0), vf: Number(dev.valor_frete || 0) };
    const updates = {};

    // frete: guarda o maior absoluto visto
    if (model.frete != null && Math.abs(model.frete) > 0) {
      updates.valor_frete = Math.max(Math.abs(before.vf), Math.abs(model.frete));
    }

    // refund: reduz valor_produto (piso zero)
    if (model.tipo && /reembolso|refund/i.test(model.tipo)) {
      const novo = Math.max(0, before.vp - Math.abs(model.valor || 0));
      updates.valor_produto = novo;
    }

    const changed = Object.keys(updates).length > 0 &&
                    (updates.valor_frete !== before.vf || updates.valor_produto !== before.vp);

    if (!changed) return { ok: false, reason: 'no-op' };

    if (!dryRun) {
      // update
      const sets = [], args = [];
      for (const [k, v] of Object.entries(updates)) { args.push(v); sets.push(`${k} = $${args.length}`); }
      args.push(dev.id);
      await query(
        `update devolucoes set ${sets.join(', ')}, updated_at = now() where id = $${args.length}`,
        args
      );

      // tipo compatível com o CHECK da tabela return_events
      const eventType =
        (updates.valor_produto != null) ? 'ajuste' :
        (updates.valor_frete   != null /*|| updates.tarifa_ml != null*/) ? 'custo' :
        'status'; // fallback seguro

      // evento (idempotente via idemp_key; 23505 tratado no addReturnEvent)
      await addReturnEvent({
        returnId: dev.id,
        type: eventType,
        title: 'Conciliação Mercado Livre (CSV)',
        message: `Atualizado via CSV: ${Object.keys(updates).join(', ')}`,
        meta: { ml_csv: model.raw },
        createdBy: 'csv-import',
        idempKey: `csv:${lineHash(model)}:${dev.id}`
      });
    }

    return { ok: true, reason: 'updated' };
  }

  /* ---------- rotas ---------- */

  // POST /api/csv/upload — recebe CSV como texto
  app.post(
    '/api/csv/upload',
    // importante: body como TEXTO para aceitar CSV puro
    express.text({ type: ['text/*', 'application/octet-stream', '*/*'], limit: '10mb' }),
    async (req, res) => {
      try {
        const dry = String(req.query.dry || '0') === '1';
        const filename = req.get('X-Filename') || 'upload.csv';
        const text = (req.body || '').trim();
        if (!text) return res.status(400).json({ error: 'Arquivo vazio.' });

        const delim = detectDelimiter(text);
        const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
        if (lines.length < 2) return res.status(400).json({ error: 'CSV sem conteúdo.' });

        // CSV simples: split por delimitador (se tiver vírgula dentro de aspas, trocar por parser robusto)
        const headers = lines[0].split(delim).map(h => h.replace(/^"|"$/g, ''));

        // abre import (se não for dry)
        let importId = null;
        if (!dry) {
          const rImp = await query(
            `insert into ml_csv_imports (filename, dry_run, total_linhas, conciliadas, ignoradas, erros)
             values ($1,$2,0,0,0,0) returning id`,
            [filename, dry]
          );
          importId = rImp.rows[0].id;
        }

        let total = 0, conc = 0, ign = 0, err = 0;

        const makeRowObj = (arr) => {
          const obj = {};
          headers.forEach((h, i) => obj[h] = arr[i] != null ? arr[i].replace(/^"|"$/g, '') : '');
          return obj;
        };

        for (let i = 1; i < lines.length; i++) {
          total++;
          try {
            const cols = lines[i].split(delim);
            const rowObj = makeRowObj(cols);
            const model = mapRowToModel(rowObj);
            const h = lineHash(model);

            // audita linha se não for dry
            if (!dry) {
              try {
                await query(
                  `insert into ml_csv_raw (import_id, line_no, raw_json, line_hash)
                   values ($1,$2,$3,$4)`,
                  [importId, i + 1, JSON.stringify(rowObj), h]
                );
              } catch (_) { /* prov. duplicata pelo mesmo hash nessa import → ignora */ }
            }

            const r = await conciliarLinha(model, { dryRun: dry });
            if (r.ok) conc++;
            else if (r.reason === 'no-match' || r.reason === 'no-op') ign++;
            else err++;
          } catch (e) {
            console.warn('[CSV linha ERRO]', { linha: i+1, erro: String(e?.message || e) });
            err++;
          }
        }

        if (!dry) {
          await query(
            `update ml_csv_imports
                set total_linhas=$1, conciliadas=$2, ignoradas=$3, erros=$4
              where id=$5`,
            [total, conc, ign, err, importId]
          );
        }

        res.json({
          ok: true,
          dry_run: dry,
          linhas_lidas: total,
          conciliadas: conc,
          ignoradas: ign,
          erros: err,
          import_id: importId
        });
      } catch (e) {
        console.error('CSV upload erro:', e);
        res.status(500).json({ error: 'Falha ao processar CSV.' });
      }
    }
  );

  // GET /api/csv/template — CSV mínimo compatível
  app.get('/api/csv/template', (req, res) => {
    // Cabeçalhos compatíveis com o parser (aceita tanto 'frete' quanto shipping_out/return)
    const csv = [
      'order_id,shipment_id,event_date,product_price,shipping_out,shipping_return,cancellation_fee,ml_fee,total,reason,event_type,sku',
      '1234567890,998877,2025-10-03T13:00:00Z,100,15,15,0,0,130,arrependimento,refund,SKU-XYZ'
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.status(200).send(csv);
  });
};
