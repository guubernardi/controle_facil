'use strict';

/**
 * CSV Upload (Mercado Livre pós-venda)
 *
 * Este módulo expõe a rota POST /api/csv/upload que:
 *  - aceita um CSV bruto (texto) do relatório de pós-venda do ML,
 *  - detecta o delimitador de forma heurística,
 *  - normaliza cabeçalhos (acentos, espaços),
 *  - mapeia campos relevantes (orderId/shipment/tipo/descrição/valores),
 *  - aplica regras de conciliação em nossa tabela `devolucoes`,
 *  - registra auditoria (ml_csv_imports + ml_csv_raw) quando NÃO é dry-run,
 *  - gera eventos em `return_events` via addReturnEvent(injetado).
 *
 * ⚠️ Importante:
 *  - Não dependemos do server.js para evitar import circular.
 *  - Recebemos `app` e `deps` de fora (injeção de dependências).
 */

const express = require('express');
const crypto  = require('crypto');
const { query } = require('../db');   // <- caminho certo pro seu layout

/**
 * Registra as rotas deste módulo.
 * @param {import('express').Express} app - instância do Express do seu servidor
 * @param {{ addReturnEvent?: Function }} deps - dependências injetadas
 */
module.exports = function registrarRotasCsv(app, deps = {}) {
  // Preferimos usar a função de eventos do servidor (para manter idempotência, formato etc.)
  const addReturnEvent =  
    typeof deps.addReturnEvent === 'function'
      ? deps.addReturnEvent
      : async function fallbackAddReturnEvent(ev) {
          // Fallback ultra-minimalista, só para não quebrar se esquecer de injetar.
          // Recomendo FORTEMENTE usar a versão do server.js (tem idempotência e meta).
          const metaStr = ev.meta ? JSON.stringify(ev.meta) : null;
          const { rows } = await query(
            `
              INSERT INTO return_events (return_id, type, title, message, meta, created_by, created_at, idemp_key)
              VALUES ($1,$2,$3,$4,$5,$6, now(), $7)
              RETURNING id
            `,
            [
              ev.returnId,
              ev.type || 'csv',
              ev.title || null,
              ev.message || null,
              metaStr,
              ev.createdBy || 'csv-upload',
              ev.idempKey || null
            ]
          );
          return rows[0];
        };

  /** Heurística simples para detectar delimitador do CSV.
   *  - prioriza ; depois , depois TAB
   *  - ⚠️ não lida com vírgulas dentro de aspas (gambiarra “suficiente” pro nosso relatório).
   *    Se precisar 100% robusto, trocar por `csv-parse` ou `papaparse` no backend.
   */
  function detectDelimiter(text) {
    const firstLine = text.split(/\r?\n/).find(Boolean) || '';
    const counts = {
      ';': (firstLine.match(/;/g) || []).length,
      ',': (firstLine.match(/,/g) || []).length,
      '\t': (firstLine.match(/\t/g) || []).length,
    };
    const delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    return delim || ',';
  }

  /** Normaliza rótulos de coluna: remove acento, põe snake_case, tira símbolos. */
  function norm(s = '') {
    return String(s)
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // tira acento
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^\w_]/g, '')
      .trim();
  }

  /** Pega o primeiro valor existente dentre várias chaves candidatas. */
  function pick(obj, keys) {
    for (const k of keys) {
      if (obj[k] != null && obj[k] !== '') return obj[k];
    }
    return null;
  }

  /** Converte uma linha (obj cabeçalho->valor) em nosso modelo interno. */
  function mapRowToModel(rowObj) {
    // headers normalizados
    const o = {};
    for (const [k, v] of Object.entries(rowObj)) o[norm(k)] = v;

    // Tolerância a diversos nomes entre países / layouts.
    const orderId   = pick(o, ['id_da_venda', 'id_venda', 'order_id', 'idpedido', 'pedido']);
    const shipment  = pick(o, ['id_do_envio', 'shipment_id', 'idenvio']);
    const tipo      = pick(o, ['tipo', 'type', 'evento', 'movimento']);
    const descricao = pick(o, ['descricao', 'description', 'detalhe', 'motivo']);
    const data      = pick(o, ['data', 'data_da_operacao', 'created_at', 'data_evento']);
    const valor     = pick(o, ['valor', 'amount', 'valor_total', 'valor_da_operacao']);
    const moeda     = pick(o, ['moeda', 'currency']);
    const tarifa    = pick(o, ['tarifa', 'fee', 'taxa']);
    const frete     = pick(o, ['frete', 'shipping_cost', 'custo_envio']);

    // Converte números em float (gambiarra para “1.234,56” virar 1234.56).
    const toNum = (x) => {
      if (x == null || x === '') return null;
      const s = String(x).replace(/\./g, '').replace(',', '.');
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    };

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

  /** Hash idempotente por linha, baseado nos campos relevantes. */
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

  /**
   * Aplica regras de conciliação na nossa devolução, dado o "model" (linha CSV).
   * Gambis/assunções:
   *  - Procuramos devolução por `id_venda` (pode mudar para NFe etc).
   *  - Se a linha falar de frete/tarifa, atualizamos `valor_frete` com o MAIOR absoluto.
   *  - Se for "reembolso" (refund), reduzimos `valor_produto` (nunca < 0).
   *  - É propositalmente simples; refine os “if” conforme os tipos/descrições do seu CSV.
   */
  async function conciliarLinha(model, { dryRun = false } = {}) {
    // Localiza devo por id_venda
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

    if (!dev) {
      // Sem correspondência — consideramos “ignorada” por ora (no-match).
      return { ok: false, reason: 'no-match' };
    }

    const updates = {};

    // se linha reporta um custo de frete, guardamos o maior (absoluto) visto
    if (model.frete != null && Math.abs(model.frete) > 0) {
      updates.valor_frete = Math.max(Math.abs(Number(dev.valor_frete || 0)), Math.abs(model.frete));
    }

    // se linha reporta tarifa, você pode guardar em coluna própria (se existir)
    if (model.tarifa != null && Math.abs(model.tarifa) > 0) {
      // TODO opcional: se tiver coluna `tarifa_ml`, habilite:
      // updates.tarifa_ml = Number(model.tarifa);
    }

    // reembolso/refund → reduz valor_produto
    if (model.tipo && /reembolso|refund/i.test(model.tipo)) {
      const vp = Number(dev.valor_produto || 0);
      const novo = Math.max(0, vp - Math.abs(model.valor || 0));
      updates.valor_produto = novo;
    }

    if (Object.keys(updates).length === 0) {
      return { ok: false, reason: 'no-op' };
    }

    if (!dryRun) {
      const sets = [], args = [];
      for (const [k, v] of Object.entries(updates)) {
        args.push(v);
        sets.push(`${k} = $${args.length}`);
      }
      args.push(dev.id);
      await query(
        `update devolucoes set ${sets.join(', ')}, updated_at = now() where id = $${args.length}`,
        args
      );

      // Evento de auditoria (idempotente, usando hash da linha)
      await addReturnEvent({
        returnId: dev.id,
        type: 'csv_conciliacao',
        title: 'Conciliação Mercado Livre (CSV)',
        message: `Atualizado via CSV: ${Object.keys(updates).join(', ')}`,
        meta: { ml_csv: model.raw },
        createdBy: 'csv-import',
        idempKey: `csv:${lineHash(model)}:${dev.id}`
      });
    }

    return { ok: true, reason: 'updated' };
  }

  /**
   * POST /api/csv/upload
   * Body: texto CSV
   * Query: ?dry=1  -> simulação (não grava ml_csv_imports/ml_csv_raw e não atualiza devoluções)
   * Header opcional: X-Filename para registrar nome do arquivo no import.
   */
  app.post(
    '/api/csv/upload',
    // Middleware para aceitar texto puro até 10mb (⚠️ ajuste se necessário)
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

        // ⚠️ CSV simplista: split por delimitador sem tratar aspas/escapes.
        // Se o seu relatório tiver vírgulas dentro de campos, use um parser robusto.
        const headers = lines[0].split(delim).map(h => h.replace(/^"|"$/g, ''));

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

            // Auditoria de linha (só se não for dry-run)
            if (!dry) {
              try {
                await query(
                  `insert into ml_csv_raw (import_id, line_no, raw_json, line_hash)
                   values ($1,$2,$3,$4)`,
                  [importId, i + 1, JSON.stringify(rowObj), h]
                );
              } catch (e) {
                // Provável duplicata por hash único: ignoramos silenciosamente.
              }
            }

            const r = await conciliarLinha(model, { dryRun: dry });
            if (r.ok) conc++;
            else if (r.reason === 'no-match' || r.reason === 'no-op') ign++;
            else err++;
          } catch (_) {
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
};
