'use strict';

const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const { query } = require('./db');

const BLING_BASE  = process.env.BLING_BASE  || process.env.BLING_API_BASE || 'https://api.bling.com.br/Api/v3';
const BLING_TOKEN = process.env.BLING_TOKEN;             // "Bearer xxxxxx"
const LOJAS       = (process.env.BLING_LOJAS || '').split(',').map(s => s.trim()).filter(Boolean);

async function blingGET(path, params = {}) {
  const usp = new URLSearchParams(params);
  const url = `${BLING_BASE}${path}${usp.toString() ? `?${usp}` : ''}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${BLING_TOKEN}`, Accept: 'application/json' }
  });
  if (!r.ok) {
    const t = await r.text().catch(()=>'');
    throw new Error(`Bling GET ${path} -> ${r.status} ${t}`);
  }
  return r.json();
}

async function getStores() {
  if (LOJAS.length) return LOJAS;
  // se quiser descobrir dinamicamente, adapte aqui;
  return [];
}

/**
 * AJUSTE este método p/ o endpoint de anúncios da sua conta Bling.
 * A ideia é: buscar por "id de integração" (MLB...) dentro da loja e retornar o SKU.
 */
async function fetchListingInStore(lojaId, mlbId) {
  // Ex.: /lojas/{lojaId}/anuncios?busca=MLB123...
  const data = await blingGET(`/lojas/${lojaId}/anuncios`, { busca: mlbId });

  const anuncios = data?.data || [];
  const hit = anuncios.find(a =>
    String(a?.idIntegracao || a?.integracao || a?.id_externo || '')
      .toUpperCase() === String(mlbId).toUpperCase()
  ) || anuncios.find(a =>
    String(a?.titulo || '').toUpperCase().includes(String(mlbId).toUpperCase())
  );

  if (!hit) return null;

  const produto = hit?.produto || hit?.produtoVinculado || {};
  const sku = produto?.codigo || produto?.sku || produto?.idProduto || null;

  return sku ? {
    sku,
    produto_id: String(produto?.id || produto?.idProduto || ''),
    produto_codigo: String(produto?.codigo || ''),
    raw: hit
  } : null;
}

async function resolveSkuByMlb(mlbId) {
  const mlb = String(mlbId || '').trim().toUpperCase();
  if (!mlb.startsWith('MLB')) return null;

  // cache
  const got = await query(`select sku from ml_mlb_sku_map where mlb_id = $1 limit 1`, [mlb]);
  if (got.rows[0]?.sku) return got.rows[0].sku;

  const lojas = await getStores();
  for (const lojaId of lojas) {
    try {
      const r = await fetchListingInStore(lojaId, mlb);
      if (r?.sku) {
        await query(
          `insert into ml_mlb_sku_map (mlb_id, loja_id, sku, produto_id, produto_codigo, raw, resolved_at)
           values ($1,$2,$3,$4,$5,$6, now())
           on conflict (mlb_id) do update
             set loja_id=excluded.loja_id, sku=excluded.sku, produto_id=excluded.produto_id,
                 produto_codigo=excluded.produto_codigo, raw=excluded.raw, resolved_at=excluded.resolved_at`,
          [mlb, lojaId, r.sku, r.produto_id, r.produto_codigo, JSON.stringify(r.raw)]
        );
        return r.sku;
      }
    } catch (e) {
      console.warn(`[blingResolver] loja ${lojaId} -> ${mlb}: ${e.message}`);
    }
  }

  await query(
    `insert into ml_mlb_sku_map (mlb_id, loja_id, sku, raw, resolved_at)
     values ($1,null,null,null, now())
     on conflict (mlb_id) do nothing`,
    [mlb]
  );
  return null;
}

module.exports = { resolveSkuByMlb };
