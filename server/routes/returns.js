// server/routes/ml-returns.js
'use strict';

const express = require('express');
const router  = express.Router();
const { query } = require('../db');

/* ================= fetch polyfill ================= */
const _fetch = (typeof fetch === 'function')
  ? fetch
  : (...a) => import('node-fetch').then(({ default: f }) => f(...a));

/* ================= helpers ================= */
const lower = x => String(x || '').toLowerCase();
const toNumber = x => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
function take(obj, path, dflt=null){
  try{
    const ps = Array.isArray(path) ? path : String(path).split('.');
    let cur = obj; for (const p of ps){ if(cur==null) return dflt; cur = cur[p]; }
    return cur ?? dflt;
  }catch{ return dflt; }
}

/** Domínio permitido no CHECK da tabela devolucoes.log_status */
const FLOW_ALLOWED = new Set([
  'pendente','em_preparacao','em_transporte','recebido_cd',
  'mediacao','disputa','agendado','retorno_comprador',
  'cancelado','fechado','expirado'
]);

/** Converte qualquer rótulo para um valor aceito pelo CHECK da tabela */
function canonFlowForDb(s){
  let v = lower(s).replace(/\s+/g,'_');
  // sinônimos
  if (v === 'pronto_envio' || v === 'ready_to_ship' || v === 'label_generated') v = 'em_preparacao';
  if (v === 'a_caminho' || v === 'em_transito' || v === 'on_the_way' || v === 'in_transit') v = 'em_transporte';
  if (v === 'entregue' || v === 'delivered' || v === 'recebido_no_cd') v = 'recebido_cd';
  if (v === 'mediation') v = 'mediacao';
  if (v === 'claim' || v === 'opened' || v === 'open') v = 'disputa';
  if (v === 'canceled') v = 'cancelado';
  if (v === 'expired') v = 'expirado';
  if (FLOW_ALLOWED.has(v)) return v;
  return 'pendente';
}

/* ================= column check / upsert ================= */
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
  if (!rec || !rec.id_venda) return { inserted:false, updated:false };

  // garante compatibilidade com o CHECK
  if (rec.log_status) rec.log_status = canonFlowForDb(rec.log_status);

  const cols = await tableHasColumns('devolucoes', [
    'id_venda','ml_claim_id','ml_return_status','ml_shipping_status','log_status',
    'cliente_nome','valor_produto','valor_frete','created_at','updated_at','loja_nome'
  ]);

  // UPDATE primeiro
  const upd = []; const params = []; let p = 1;
  const add = (k,v)=>{ if(cols[k] && v !== undefined){ upd.push(`${k}=$${p++}`); params.push(v); } };
  add('ml_claim_id',        rec.ml_claim_id ?? null);
  add('ml_return_status',   rec.ml_return_status ?? null);
  add('ml_shipping_status', rec.ml_shipping_status ?? null);
  add('log_status',         rec.log_status ?? null);
  add('cliente_nome',       rec.cliente_nome ?? null);
  add('valor_produto',      rec.valor_produto ?? null);
  add('valor_frete',        rec.valor_frete ?? null);
  add('loja_nome',          rec.loja_nome ?? null);
  if (cols.updated_at) upd.push('updated_at=now()');
  params.push(rec.id_venda);

  if (upd.length){
    const r = await query(`UPDATE devolucoes SET ${upd.join(',')} WHERE id_venda=$${p}`, params);
    if ((r.rowCount||0)>0) return { inserted:false, updated:true };
  }

  // INSERT
  const insC = ['id_venda']; const insV = ['$1']; const insP=[rec.id_venda]; let i=2;
  const ins=(k,v)=>{ if(cols[k] && v !== undefined){ insC.push(k); insV.push(`$${i++}`); insP.push(v); } };
  ins('ml_claim_id',        rec.ml_claim_id ?? null);
  ins('ml_return_status',   rec.ml_return_status ?? null);
  ins('ml_shipping_status', rec.ml_shipping_status ?? null);
  ins('log_status',         rec.log_status ?? null);
  ins('cliente_nome',       rec.cliente_nome ?? null);
  ins('valor_produto',      rec.valor_produto ?? null);
  ins('valor_frete',        rec.valor_frete ?? null);
  ins('loja_nome',          rec.loja_nome ?? 'Mercado Livre');
  if (cols.created_at){ insC.push('created_at'); insV.push(`COALESCE($${i++},now())`); insP.push(rec.created_at ?? null); }
  if (cols.updated_at){ insC.push('updated_at'); insV.push('now()'); }

  await query(`INSERT INTO devolucoes (${insC.join(',')}) VALUES (${insV.join(',')})`, insP);
  return { inserted:true, updated:false };
}

/* ================= token resolve + refresh ================= */
const ML_TOKEN_URL = process.env.ML_TOKEN_URL || 'https://api.mercadolibre.com/oauth/token';
const AHEAD_SEC = parseInt(process.env.ML_REFRESH_AHEAD_SEC || '600', 10) || 600;

async function loadTokenRowFromDb(sellerId, q=query){
  const { rows } = await q(`
    SELECT user_id, nickname, access_token, refresh_token, expires_at
      FROM public.ml_tokens
     WHERE user_id=$1
     ORDER BY updated_at DESC
     LIMIT 1
  `,[sellerId]);
  return rows[0]||null;
}
function isExpiringSoon(expiresAtIso, ahead=AHEAD_SEC){
  if(!expiresAtIso) return true;
  const t = new Date(expiresAtIso).getTime();
  if(!Number.isFinite(t)) return true;
  return (t - Date.now()) <= ahead*1000;
}
async function refreshAccessToken({ sellerId, refreshToken, q=query }){
  if(!refreshToken) return null;
  const body = new URLSearchParams({
    grant_type:'refresh_token',
    client_id:     process.env.ML_CLIENT_ID || '',
    client_secret: process.env.ML_CLIENT_SECRET || '',
    refresh_token: refreshToken
  }).toString();
  const r = await _fetch(ML_TOKEN_URL, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body });
  const ct=r.headers.get('content-type')||''; const b=ct.includes('json')?await r.json().catch(()=>null):await r.text().catch(()=>null);
  if(!r.ok){ const e=new Error((b&&(b.message||b.error))||r.statusText); e.status=r.status; e.body=b; throw e; }
  const { access_token, refresh_token, token_type, scope, expires_in } = b||{};
  const expiresAt = new Date(Date.now() + (Math.max(60, Number(expires_in)||600))*1000).toISOString();
  await q(`
    INSERT INTO public.ml_tokens (user_id, access_token, refresh_token, token_type, scope, expires_at, raw, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,now())
    ON CONFLICT (user_id) DO UPDATE SET
      access_token=EXCLUDED.access_token, refresh_token=EXCLUDED.refresh_token,
      token_type=EXCLUDED.token_type, scope=EXCLUDED.scope,
      expires_at=EXCLUDED.expires_at, raw=EXCLUDED.raw, updated_at=now()
  `,[sellerId, access_token||null, refresh_token||null, token_type||null, scope||null, expiresAt, JSON.stringify(b||{})]);
  return { access_token, refresh_token, expires_at: expiresAt };
}
async function resolveSellerAccessToken(req){
  const direct = req.get('x-seller-token');
  if (direct) return { token: direct, sellerId: (req.get('x-seller-id')||'') };

  const sellerId = String(req.get('x-seller-id') || req.query.seller_id || req.session?.ml?.user_id || '').replace(/\D/g,'');
  if (sellerId){
    const row = await loadTokenRowFromDb(sellerId);
    if (row?.access_token){
      if (!isExpiringSoon(row.expires_at)) return { token: row.access_token, sellerId };
      try {
        const r = await refreshAccessToken({ sellerId, refreshToken: row.refresh_token });
        if (r?.access_token) return { token:r.access_token, sellerId };
        return { token: row.access_token, sellerId };
      } catch {
        if (!isExpiringSoon(row.expires_at,0)) return { token: row.access_token, sellerId };
        const e=new Error('missing_access_token'); e.status=401; throw e;
      }
    }
  }
  if (req.session?.ml?.access_token) return { token:req.session.ml.access_token, sellerId: sellerId || (req.session.ml.user_id||'') };
  if (process.env.MELI_OWNER_TOKEN)   return { token:process.env.MELI_OWNER_TOKEN, sellerId };
  const e=new Error('missing_access_token'); e.status=401; throw e;
}

/* ================= HTTP helper ================= */
async function mlFetch(token, url, opts={}){
  const res = await _fetch(url, {
    ...opts,
    headers: { 'Authorization':`Bearer ${token}`, 'Accept':'application/json', ...(opts.headers||{}) }
  });
  const ct=res.headers.get('content-type')||''; 
  const body=ct.includes('json')?await res.json().catch(()=>null):await res.text().catch(()=>null);
  if(!res.ok){ const err=new Error((body&&(body.message||body.error))||res.statusText||`HTTP ${res.status}`); err.status=res.status; err.body=body; throw err; }
  return body;
}

/* ================= flow helpers ================= */
function flowFromStage(stage){
  const s = lower(stage);
  if (s === 'dispute') return 'mediacao';
  if (s === 'claim')   return 'disputa';
  // recontact / none / stale -> não promovemos
  return 'pendente';
}
function suggestFlow(mlReturnStatus, shipStatus, shipSub){
  const s = lower(mlReturnStatus);
  const ship = [lower(shipStatus), lower(shipSub)].join('_');

  // returns v2
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

  // shipping
  if (/ready_to_ship|handling|aguardando_postagem|label|etiq|prepar/.test(ship)) return 'em_preparacao';
  if (/in_transit|on_the_way|transit|a_caminho|posted|shipped|out_for_delivery|returning_to_sender|em_transito/.test(ship)) return 'em_transporte';
  if (/delivered|entreg|arrived|recebid/.test(ship)) return 'pendente'; // não promovemos via shipping
  if (/not_delivered|cancel/.test(ship)) return 'pendente';

  return 'pendente';
}

/* ================= record mapping ================= */
function mapReturnRecord(rec, sellerNick){
  const orderId =
    take(rec,['order_id']) ||
    take(rec,['order','id']) ||
    take(rec,['purchase','order_id']) ||
    take(rec,['resource','order_id']) ||
    take(rec,['sale','order_id']) ||
    take(rec,['resource_id']) ||
    take(rec,['context','resource_id']) ||
    take(rec,['shipment','order_id']) ||
    null;
  if (!orderId) return null;

  const claimId =
    take(rec,['claim_id']) ||
    take(rec,['id']) ||
    take(rec,['claim','id']) ||
    take(rec,['resource_id']) ||
    null;

  const buyer =
    take(rec,['buyer','nickname']) ||
    take(rec,['buyer','name']) ||
    take(rec,['buyer_nickname']) ||
    take(rec,['buyer_name']) || '—';

  const mlReturnStatus =
    lower(take(rec,['status'])) ||
    lower(take(rec,['return_status'])) ||
    lower(take(rec,['state'])) || '';

  const stage = lower(take(rec,['stage']) || '');

  const mlShipStatus = lower(take(rec,['shipping','status'])||'');
  const mlShipSub    = lower(take(rec,['shipping','substatus'])||'');
  const mlShipAny    = mlShipSub || mlShipStatus;

  const saleAmount     = toNumber(take(rec,['amounts','sale_amount']) || take(rec,['amounts','value']) || 0);
  const shippingAmount = toNumber(take(rec,['amounts','shipping_amount']) || 0);

  const created =
    take(rec,['date_created']) ||
    take(rec,['creation_date']) ||
    take(rec,['created_at']) ||
    take(rec,['created']) ||
    new Date().toISOString();

  // fluxo sugerido
  let flow = suggestFlow(mlReturnStatus, mlShipStatus, mlShipSub);
  const fromStage = flowFromStage(stage);
  if (fromStage !== 'pendente') flow = fromStage;
  flow = canonFlowForDb(flow);

  return {
    id_venda: String(orderId),
    ml_claim_id: claimId ? String(claimId) : null,
    ml_return_status: mlReturnStatus || null,
    ml_shipping_status: mlShipAny || null,
    log_status: flow,
    cliente_nome: String(buyer),
    valor_produto: saleAmount,
    valor_frete: shippingAmount,
    loja_nome: sellerNick ? `Mercado Livre · ${sellerNick}` : 'Mercado Livre',
    created_at: created
  };
}

/* ================= /returns/state ================= */
/**
 * GET /api/ml/returns/state?claim_id=...&order_id=...&update=1
 * - Tenta GET e, se preciso, POST em /post-purchase/v2/claims/{claim_id}/returns
 * - Se não vier, cai para /post-purchase/v1/claims/{claim_id} e usa stage→flow.
 * - Sempre 200 com { ok, flow, raw_status }.
 */
router.get('/returns/state', async (req, res) => {
  try {
    const claimRaw = String(req.query.claim_id || req.query.claimId || '').trim();
    const claimId  = claimRaw.replace(/\D/g,'');
    const orderIdQ = req.query.order_id || req.query.orderId || null;
    const doUpdate = String(req.query.update ?? '1') !== '0';

    if (!claimId) return res.json({ ok:false, error:'missing_claim_id' });

    const { token } = await resolveSellerAccessToken(req);

    let ret = null;
    // 1) GET v2
    try {
      const r = await mlFetch(token, `https://api.mercadolibre.com/post-purchase/v2/claims/${encodeURIComponent(claimId)}/returns`);
      ret = Array.isArray(r?.data) ? r.data[0] : Array.isArray(r) ? r[0] : r;
    } catch (_){ /* tenta POST */ }
    // 2) POST v2 (algumas contas precisam de POST vazio)
    if (!ret) {
      try {
        const r = await mlFetch(
          token,
          `https://api.mercadolibre.com/post-purchase/v2/claims/${encodeURIComponent(claimId)}/returns`,
          { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({}) }
        );
        ret = Array.isArray(r?.data) ? r.data[0] : Array.isArray(r) ? r[0] : r;
      } catch(_){}
    }

    let rawStatus = ret?.status || ret?.return_status || null;
    let orderId   = orderIdQ || ret?.resource_id || ret?.order_id || null;
    let flow      = rawStatus ? suggestFlow(rawStatus, null, null) : null;
    let stage     = null;

    // 3) Fallback: claim v1 → stage
    if (!rawStatus) {
      try {
        const c = await mlFetch(token, `https://api.mercadolibre.com/post-purchase/v1/claims/${encodeURIComponent(claimId)}`);
        stage   = c?.stage || c?.status || null;
        orderId = orderId || c?.resource_id || c?.order_id || null;
        flow    = flowFromStage(stage) || flow || 'pendente';
      } catch(_){}
    }

    flow = canonFlowForDb(flow || 'pendente');

    // Atualiza DB se possível
    if (doUpdate && orderId) {
      try {
        await upsertDevolucao({
          id_venda: String(orderId),
          ml_claim_id: String(claimId),
          ml_return_status: rawStatus || null,
          log_status: flow
        });
      } catch(_) {}
    }

    return res.json({
      ok: true,
      claim_id: claimId,
      order_id: orderId || null,
      raw_status: rawStatus || null,
      stage: stage || null,
      flow
    });
  } catch (e) {
    return res.json({ ok:false, error:String(e?.message||e) });
  }
});

/* ================= busca paginada (sync) ================= */
async function paginatedTry(token, builders, limit=50, maxPages=10){
  const out=[];
  for (const build of builders){
    let offset=0;
    for (let page=0; page<maxPages; page++){
      const { url } = build({ offset, limit });
      try{
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
      }catch(_){ break; }
    }
    if (out.length) break;
  }
  return out;
}
function isoDateNDaysAgo(n){ const d=new Date(); d.setUTCDate(d.getUTCDate()-n); return d.toISOString(); }

/* ================= /returns/sync ================= */
router.get('/returns/sync', async (req, res) => {
  try {
    const { token, sellerId } = await resolveSellerAccessToken(req);
    const sellerNick = req.get('x-seller-nick') || null;

    const orderId = req.query.order_id || req.query.orderId || null;
    const days    = parseInt(req.query.days || req.query.range_days || '30', 10) || 30;
    const statuses= String(req.query.status || 'opened,in_progress,shipped,pending_delivered,delivered')
                      .split(',').map(s=>s.trim()).filter(Boolean);
    const silent  = /^1|true$/i.test(String(req.query.silent||'0'));

    const limit=50; const dateFrom=isoDateNDaysAgo(days);

    let raw=[];
    if (orderId){
      const builders = [
        ({offset,limit}) => ({ url: `https://api.mercadolibre.com/post-purchase/v2/returns/search?resource=order&resource_id=${encodeURIComponent(orderId)}&limit=${limit}&offset=${offset}` }),
        ({offset,limit}) => ({ url: `https://api.mercadolibre.com/post-purchase/v1/claims/search?order_id=${encodeURIComponent(orderId)}&limit=${limit}&offset=${offset}` }),
        ({offset,limit}) => ({ url: `https://api.mercadolibre.com/post-purchase/v1/claims/search?resource=order&resource_id=${encodeURIComponent(orderId)}&limit=${limit}&offset=${offset}` })
      ];
      raw = await paginatedTry(token, builders, limit, 3);
    } else {
      const statusQS = statuses.map(s=>`status=${encodeURIComponent(s)}`).join('&');
      const builders = [
        ({offset,limit}) => ({ url: `https://api.mercadolibre.com/post-purchase/v2/returns/search?seller=${encodeURIComponent(sellerId)}&${statusQS}&date_from=${encodeURIComponent(dateFrom)}&limit=${limit}&offset=${offset}` }),
        ({offset,limit}) => ({ url: `https://api.mercadolibre.com/post-purchase/v1/claims/search?seller=${encodeURIComponent(sellerId)}&${statusQS}&date_from=${encodeURIComponent(dateFrom)}&limit=${limit}&offset=${offset}` }),
        ({offset,limit}) => ({ url: `https://api.mercadolibre.com/post-purchase/v1/claims/search?${statusQS}&date_from=${encodeURIComponent(dateFrom)}&limit=${limit}&offset=${offset}` })
      ];
      raw = await paginatedTry(token, builders, limit, 10);
    }

    const touched=[];
    for (const rec of raw){
      const mapped = mapReturnRecord(rec, sellerNick);
      if (!mapped) continue;
      const r = await upsertDevolucao(mapped);
      touched.push({ id_venda: mapped.id_venda, updated:r.updated, inserted:r.inserted });
    }

    const out = { ok:true, total: raw.length, touched: touched.length };
    if (!silent) out.details = touched;
    return res.json(out);
  } catch (e) {
    const code = e.status || 500;
    return res.status(code).json({ error:String(e.message||e), detail:e.body||null });
  }
});

module.exports = router;

/* ================= agendador opcional ================= */
module.exports.scheduleMlReturnsSync = function scheduleMlReturnsSync(){
  const INTERVAL_MS = parseInt(process.env.ML_RETURNS_SYNC_MS || '600000', 10);
  async function tick(){
    try{
      await _fetch(`${process.env.BASE_URL || 'http://127.0.0.1:3000'}/api/ml/returns/sync?days=3&silent=1`, {
        headers:{Accept:'application/json'}
      }).catch(()=>null);
    }finally{
      setTimeout(tick, INTERVAL_MS);
    }
  }
  setTimeout(tick, 5000);
};
