// server/blingClient.js
const axios = require('axios');

const api = axios.create({
  baseURL: process.env.BLING_API_BASE, 
  timeout: 15000,
});

// 🔒 read-only
api.interceptors.request.use((cfg) => {
  const m = (cfg.method || 'get').toLowerCase();
  if (m !== 'get') throw new Error('BlingClient read-only: apenas GET.');
  return cfg;
});

module.exports = {
  async get(path, token, params = {}) {
    const r = await api.get(path, {
      params,
      headers: { Authorization: `Bearer ${token}` },
    });
    return r.data;
  },
};
