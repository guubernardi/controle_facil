// services/meliApi.js
const axios = require('axios');
const FormData = require('form-data');

const BASE = 'https://api.mercadolibre.com';

/**
 * Como você obtém o access token?
 * - para comunicações do seller: token do seller
 * - para comunicações do integrador (owner): token do owner da app
 * Implemente getAccessToken(userId) de acordo com o seu banco.
 */
async function getAccessToken(ctx) {
  // ctx pode carregar: { sellerId } OU { owner: true }
  // TODO: troque pela sua leitura real do banco/kv
  if (ctx?.owner) return process.env.MELI_OWNER_TOKEN; // autogrant do owner
  if (ctx?.sellerToken) return ctx.sellerToken;
  throw new Error('ACCESS_TOKEN indisponível');
}

async function meliGet(path, ctx, { params } = {}) {
  const token = await getAccessToken(ctx);
  const r = await axios.get(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    params
  });
  return r.data;
}

async function meliPost(path, body, ctx, { asFormData = false } = {}) {
  const token = await getAccessToken(ctx);
  const headers = { Authorization: `Bearer ${token}` };

  if (asFormData) {
    // body deve ser { formData }
    const r = await axios.post(`${BASE}${path}`, body.formData, {
      headers: { ...headers, ...body.formData.getHeaders?.() }
    });
    return r.data;
  }

  const r = await axios.post(`${BASE}${path}`, body, {
    headers: { ...headers, 'Content-Type': 'application/json' }
  });
  return r.data;
}

async function meliDownload(path, ctx) {
  const token = await getAccessToken(ctx);
  const r = await axios.get(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    responseType: 'arraybuffer'
  });
  return { buf: r.data, headers: r.headers };
}

module.exports = {
  meliGet,
  meliPost,
  meliDownload,
  FormData
};
