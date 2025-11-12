// server/routes/ml-returns.js
'use strict';

/**
 * Importador resiliente de devoluções/claims do Mercado Livre
 * - GET /api/ml/returns/sync?days=30&status=opened,in_progress&silent=1
 * - GET /api/ml/returns/sync?order_id=2000012345678901
 *
 * Estratégia:
 * 1) Resolve access_token (header x-seller-token OU x-seller-id -> tabela ml_tokens com auto-refresh)
 * 2) Tenta múltiplos endpoints/documentos do ML (claims v1 / returns v2) com paginação
 * 3) Normaliza records e faz UPSERT em "devolucoes" por id_venda
 * 4) Retorna resumo (e opcionalmente os itens tocados)
 */

const express = require('express');
const router  = express.Router();
const { query } = require('../db');

// ---------- utils: checagem de colunas e UPSERT seguro ----------
const _colsCache = {};
async function tableHasColumns(table, cols) {
  const key = `${table}:${cols.join(',')}`;
  if (_colsCache[key]) return _colsCache[key];
  const { rows } = await query(
    `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1`,
    [table]
  );
  const set = new Set(rows.map(r => r.column_name));
  const out = {}; for (const c of cols) out[c] = set.has(c);
  _colsCache[key] = out;
  return out;
}

async function upsertDevolucao(rec) {
  // rec: { id_venda, ml_claim_id, ml_return_status, ml_shipping_status, log_status,
  //        cliente_nome, valor_produto, valor_frete, created_at }
  if (!rec || !rec.id_venda) return { inserted: false, updated: false };

  const cols = await tableHasColumns('devolucoes', [
    'id_venda','ml_claim_id','ml_return_status','ml_shipping_status','log_status',
    'cliente_nome','valor_produto','valor_frete','created_at','updated_at','loja_nome'
  ]);

  // UPDATE primeiro (evita depender de UNIQUE para ON CONFLICT)
  const updFields = [];
  const params    = [];
  let p = 1;

  function add(field, value) {
    if (cols[field] && value !== undefined) {
      updFields.push(`${field} = $${p++}`);
      params.push(value);
    }
  }

  add('ml_claim_id',       rec.ml_claim_id ?? null);
  add('ml_return_status',  rec.ml_return_status ?? null);
  add('ml_shipping_status',rec.ml_shipping_status ?? null);
  add('log_status',        rec.log_status ?? null);
  add('cliente_nome',      rec.cliente_nome ?? null);
  add('valor_produto',     rec.valor_produto ?? null);
  add('valor_frete',       rec.valor_frete ?? null);
  add('loja_nome',         rec.loja_nome ?? null);
  if (cols.updated_at) { updFields.push(`updated_at = now()`); }

  params.push(rec.id_venda);

  let updated = false;
  if (updFields.length) {
    const sqlUpd = `UPDATE devolucoes SET ${updFields.join(', ')} WHERE id_venda = $${p}`;
    const r = await query(sqlUpd, params);
    updated = (r.rowCount || 0) > 0;
  }

  if (updated) return { inserted: false, updated: true };

  // INSERT se não há registro
  const insCols = ['id_venda'];
  const insVals = ['$1'];
  const insParams = [rec.id_venda];
  let i = 2;

  function ins(field, value) {
    if (cols[field] && value !== undefined) {
      insCols.push(field);
      insVals.push(`$${i++}`);
      insParams.push(value);
    }
  }

  ins('ml_claim_id',        rec.ml_claim_id ?? null);
  ins('ml_return_status',   rec.ml_return_status ?? null);
  ins('ml_shipping_status', rec.ml_shipping_status ?? null);
  ins('log_status',         rec.log_status ?? null);
  ins('cliente_nome',       rec.cliente_nome ?? null);
  ins('valor_produto',      rec.valor_produto ?? null);
  ins('valor_frete',        rec.valor_frete ?? null);
  ins('loja_nome',          rec.loja_nome ?? 'Mercado Livre');
  if (cols.created_at)      { insCols.push('created_at'); insVals.push('COALESCE($' + (i++) + ', now())'); insParams.push(rec.created_at ?? null); }
  if (cols.updated_at)      { insCols.push('updated_at'); insVals.push('now()'); }

  const sqlIns = `INSERT INTO devolucoes (${insCols.join(',')}) VALUES (${insVals.join(',')})`;
  await query(sqlIns, insParams);
  return { inserted: true, updated: false };
}

// ---------- token resolver com auto-refresh de ml_tokens ----------
const ML_TOKEN_URL = process.env.ML_TOKEN_URL || 'https://api.mercadolibre.com/oauth/token';
const AHEAD_SEC = parseInt(process.env.ML_REFRESH_AHEAD_SEC || '600', 10) || 600; // renova 10min antes

async function loadTokenRowFromDb(sellerId, q = query) {
  const { rows } = await q(`
    SELECT user_id, nickname, access_token, refresh_token, expires_at
      FROM public.ml_tokens
     WHERE user_id = $1
     ORDER BY updated_at DESC
     LIMIT 1
  `, [sellerId]);
  return rows[0] || null;
}
function isExpiringSoon(expiresAtIso, aheadSec = AHEAD_SEC) {
  if (!expiresAtIso) return true;
  const exp = new Date(expiresAtIso).getTime();
  if (!Number.isFinite(exp)) return true;
  return (exp - Date.now()) <= aheadSec * 1000;
}
async function refreshAccessToken({ sellerId, refreshToken, q = query }) {
  if (!refreshToken) return null;
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id:     process.env.ML_CLIENT_ID || '',
    client_secret: process.env.ML_CLIENT_SECRET || '',
    refresh_token: refreshToken
  });
  const r = await fetch(ML_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });
  const ct = r.headers.get('content-type') || '';
  const body = ct.includes('application/json') ? await r.json().catch(() => null)
                                               : await r.text().catch(() => '');
  if (!r.ok) {
    const msg = (body && (body.message || body.error)) || r.statusText || 'refresh_failed';
    const err = new Error(msg);
    err.status = r.status;
    err.body   = body;
    throw err;
  }
  const { access_token, refresh_token, token_type, scope, expires_in } = body || {};
  const expiresAt = new Date(Date.now() + (Math.max(60, Number(expires_in) || 600)) * 1000).toISOString();
  await q(`
    INSERT INTO public.ml_tokens
      (user_id, access_token, refresh_token, token_type, scope, expires_at, raw, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7, now())
    ON CONFLICT (user_id) DO UPDATE SET
      access_token = EXCLUDED.access_token,
      refresh_token= EXCLUDED.refresh_token,
      token_type   = EXCLUDED.token_type,
      scope        = EXCLUDED.scope,
      expires_at   = EXCLUDED.expires_at,
      raw          = EXCLUDED.raw,
      updated_at   = now()
  `, [sellerId, access_token || null, refresh_token || null, token_type || null, scope || null, expiresAt, JSON.stringify(body || {})]);
  return { access_token, refresh_token, expires_at: expiresAt };
}
async function resolveSellerAccessToken(req) {
  const direct = req.get('x-seller-token');
  if (direct) return { token: direct, sellerId: (req.get('x-seller-id')||'') };

  const sellerId = String(
    req.get('x-seller-id') || req.query.seller_id || req.session?.ml?.user_id || ''
  ).replace(/\D/g, '');

  if (sellerId) {
    const row = await loadTokenRowFromDb(sellerId);
    if (row?.access_token) {
      if (!isExpiringSoon(row.expires_at)) return { token: row.access_token, sellerId };
      try {
        const refreshed = await refreshAccessToken({ sellerId, refreshToken: row.refresh_token });
        if (refreshed?.access_token) return { token: refreshed.access_token, sellerId };
        return { token: row.access_token, sellerId }; // fallback curto
      } catch {
        if (!isExpiringSoon(row.expires_at, 0)) return { token: row.access_token, sellerId };
        const e = new Error('missing_access_token'); e.status = 401; throw e;
      }
    }
  }
  if (req.session?.ml?.access_token) return { token: req.session.ml.access_token, sellerId: sellerId || (req.session.ml.user_id || '') };
  if (process.env.MELI_OWNER_TOKEN)   return { token: process.env.MELI_OWNER_TOKEN, sellerId };
  const e = new Error('missing_access_token'); e.status = 401; throw e;
}

// ---------- HTTP helper resiliente ----------
async function mlFetch(token, url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
      ...(opts.headers || {})
    }
  });
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('application/json') ? await res.json().catch(() => null)
                                               : await res.text().catch(() => '');
  if (!res.ok) {
    const err = new Error((body && (body.message || body.error)) || res.statusText || `HTTP ${res.status}`);
    err.status = res.status;
    err.body   = body;
    throw err;
  }
  return body;
}

// ---------- Normalizações (record -> devolucoes) ----------
function take(obj, path, dflt=null){
  try{
    const parts = Array.isArray(path) ? path : String(path).split('.');
    let cur = obj; for (const p of parts){ if(cur==null) return dflt; cur = cur[p]; }
    return cur ?? dflt;
  }catch{ return dflt; }
}
function toNumber(x){ const n = Number(x); return Number.isFinite(n) ? n : 0; }
function lower(x){ return String(x||'').toLowerCase(); }

function mapReturnRecord(rec, sellerNick) {
  // Tenta extrair o máximo de campos, independente do shape da resposta
  const orderId =
    take(rec, ['order_id']) ||
    take(rec, ['order','id']) ||
    take(rec, ['purchase','order_id']) ||
    take(rec, ['resource','order_id']) ||
    take(rec, ['sale','order_id']) ||
    take(rec, ['resource_id']) ||
    take(rec, ['context','resource_id']) ||
    take(rec, ['shipment','order_id']) ||
    null;

  if (!orderId) return null;

  const claimId =
    take(rec, ['claim_id']) ||
    take(rec, ['id']) ||
    take(rec, ['claim','id']) ||
    take(rec, ['resource_id']) ||
    null;

  const buyer =
    take(rec, ['buyer','nickname']) ||
    take(rec, ['buyer','name']) ||
    take(rec, ['buyer_nickname']) ||
    take(rec, ['buyer_name']) ||
    '—';

  const mlReturnStatus =
    lower(take(rec, ['status'])) ||
    lower(take(rec, ['return_status'])) ||
    lower(take(rec, ['state'])) || '';

  const mlShipStatus  = lower(take(rec, ['shipping','status']) || '');
  const mlShipSub     = lower(take(rec, ['shipping','substatus']) || '');
  const mlShipAny     = mlShipSub || mlShipStatus;

  const saleAmount    = toNumber(take(rec, ['amounts','sale_amount']) || take(rec, ['amounts','value']) || 0);
  const shippingAmount= toNumber(take(rec, ['amounts','shipping_amount']) || 0);

  const created =
    take(rec, ['date_created']) ||
    take(rec, ['creation_date']) ||
    take(rec, ['created_at']) ||
    take(rec, ['created']) ||
    new Date().toISOString();

  return {
    id_venda: String(orderId),
    ml_claim_id: claimId ? String(claimId) : null,
    ml_return_status: mlReturnStatus || null,
    ml_shipping_status: mlShipAny || null,
    log_status: suggestFlow(mlReturnStatus, mlShipStatus, mlShipSub),
    cliente_nome: String(buyer),
    valor_produto: saleAmount,
    valor_frete: shippingAmount,
    loja_nome: sellerNick ? `Mercado Livre · ${sellerNick}` : 'Mercado Livre',
    created_at: created
  };
}

function suggestFlow(mlReturnStatus, shipStatus, shipSub) {
  const s = lower(mlReturnStatus);
  const ship = [lower(shipStatus), lower(shipSub)].join('_');
  if (/^label_generated$|ready_to_ship|etiqueta|prepar/.test(s)) return 'pronto_envio';
  if (/^pending(_.*)?$|pending_cancel|pending_failure|pending_expiration/.test(s)) return 'pendente';
  if (/^shipped$|pending_delivered$/.test(s)) return 'em_transporte';
  if (/^delivered$/.test(s)) return 'recebido_cd';
  if (/^not_delivered$/.test(s)) return 'pendente';
  if (/^return_to_buyer$/.test(s)) return 'retorno_comprador';
  if (/^scheduled$/.test(s)) return 'agendado';
  if (/^expired$/.test(s)) return 'expirado';
  if (/^failed$/.test(s)) return 'pendente';
  if (/^cancelled$|^canceled$/.test(s)) return 'cancelado';

  if (/ready_to_ship|handling|aguardando_postagem|label|etiq|prepar/.test(ship)) return 'em_preparacao';
  if (/in_transit|on_the_way|transit|a_caminho|posted|shipped|out_for_delivery|returning_to_sender|em_transito/.test(ship)) return 'em_transporte';
  if (/delivered|entreg|arrived|recebid/.test(ship)) return 'recebido_cd';
  if (/not_delivered|cancel/.test(ship)) return 'pendente';

  return 'pendente';
}

// ---------- Listagens resilientes (tentando vários endpoints) ----------
async function paginatedTry(token, builders, limit=50, maxPages=10) {
  const out = [];
  for (const build of builders) {
    let offset = 0;
    for (let page=0; page<maxPages; page++) {
      const { url } = build({ offset, limit });
      try {
        const data = await mlFetch(token, url);
        const list = Array.isArray(data?.results) ? data.results
                   : Array.isArray(data?.items)    ? data.items
                   : Array.isArray(data?.data)     ? data.data
                   : Array.isArray(data?.returns)  ? data.returns
                   : Array.isArray(data)           ? data
                   : [];
        if (!list.length) break;
        out.push(...list);
        if (list.length < limit) break;
        offset += limit;
      } catch (e) {
        // tenta o próximo builder
        break;
      }
    }
    if (out.length) break;
  }
  return out;
}

function isoDateNDaysAgo(n) {
  const d = new Date(); d.setUTCDate(d.getUTCDate()-n);
  return d.toISOString();
}

// ---------- Rotas ----------
router.get('/returns/sync', async (req, res) => {
  try {
    const { token, sellerId } = await resolveSellerAccessToken(req);
    const sellerNick = req.get('x-seller-nick') || null;

    const orderId = req.query.order_id || req.query.orderId || null;
    const days    = parseInt(req.query.days || req.query.range_days || '30', 10) || 30;
    const statuses= String(req.query.status || 'opened,in_progress,shipped,pending_delivered,delivered')
                      .split(',').map(s => s.trim()).filter(Boolean);
    const silent  = /^1|true$/i.test(String(req.query.silent || '0'));

    const limit   = 50;
    const dateFrom= isoDateNDaysAgo(days);

    let raw = [];

    if (orderId) {
      // builders por order
      const builders = [
        // returns v2 (hipótese comum)
        ({offset,limit}) => ({
          url: `https://api.mercadolibre.com/post-purchase/v2/returns/search?resource=order&resource_id=${encodeURIComponent(orderId)}&limit=${limit}&offset=${offset}`
        }),
        // claims v1 por order_id
        ({offset,limit}) => ({
          url: `https://api.mercadolibre.com/post-purchase/v1/claims/search?order_id=${encodeURIComponent(orderId)}&limit=${limit}&offset=${offset}`
        }),
        // fallback menos específico
        ({offset,limit}) => ({
          url: `https://api.mercadolibre.com/post-purchase/v1/claims/search?resource=order&resource_id=${encodeURIComponent(orderId)}&limit=${limit}&offset=${offset}`
        })
      ];
      raw = await paginatedTry(token, builders, limit, 3);
    } else {
      // builders por seller + datas/estados
      const statusQS = statuses.map(s => `status=${encodeURIComponent(s)}`).join('&');

      const builders = [
        // returns v2 por seller (onde disponível)
        ({offset,limit}) => ({
          url: `https://api.mercadolibre.com/post-purchase/v2/returns/search?seller=${encodeURIComponent(sellerId)}&${statusQS}&date_from=${encodeURIComponent(dateFrom)}&limit=${limit}&offset=${offset}`
        }),
        // claims v1 por seller (abertas / em andamento)
        ({offset,limit}) => ({
          url: `https://api.mercadolibre.com/post-purchase/v1/claims/search?seller=${encodeURIComponent(sellerId)}&${statusQS}&date_from=${encodeURIComponent(dateFrom)}&limit=${limit}&offset=${offset}`
        }),
        // claims v1 sem seller explícito (algumas contas retornam por token)
        ({offset,limit}) => ({
          url: `https://api.mercadolibre.com/post-purchase/v1/claims/search?${statusQS}&date_from=${encodeURIComponent(dateFrom)}&limit=${limit}&offset=${offset}`
        })
      ];
      raw = await paginatedTry(token, builders, limit, 10);
    }

    // normaliza e persiste
    const touched = [];
    for (const rec of raw) {
      const mapped = mapReturnRecord(rec, sellerNick);
      if (!mapped) continue;
      const r = await upsertDevolucao(mapped);
      touched.push({ id_venda: mapped.id_venda, updated: r.updated, inserted: r.inserted });
    }

    const out = { ok: true, total: raw.length, touched: touched.length };
    if (!silent) out.details = touched;
    return res.json(out);
  } catch (e) {
    const code = e.status || 500;
    return res.status(code).json({ error: String(e.message || e), detail: e.body || null });
  }
});

module.exports = router;

/**
 * Agendador opcional: chama returns/sync de tempos em tempos
 * Ex.: no server.js -> const { scheduleMlReturnsSync } = require('./routes/ml-returns');
 *                       scheduleMlReturnsSync(app);
 */
module.exports.scheduleMlReturnsSync = function scheduleMlReturnsSync(app){
  // roda a cada 10 minutos, últimos 3 dias
  const INTERVAL_MS = parseInt(process.env.ML_RETURNS_SYNC_MS || '600000', 10);
  async function tick(){
    try{
      // Se você tem multi-seller, aqui você pode iterar x-seller-id (ml_tokens) e disparar uma chamada por seller
      // Para single-seller: apenas dispara localmente (a resolução de token usa sessão/env)
      const r = await fetch(`${process.env.BASE_URL || 'http://127.0.0.1:3000'}/api/ml/returns/sync?days=3&silent=1`, {
        headers: { 'Accept':'application/json' },
        // se quiser forçar seller pelo header: 'x-seller-id': '<id>'
      }).catch(()=>null);
      if (r && r.ok) { /* opcionalmente logar */ }
    }catch(_){}
    finally{
      setTimeout(tick, INTERVAL_MS);
    }
  }
  setTimeout(tick, 5000);
};
