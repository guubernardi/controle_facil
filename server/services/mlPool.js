// server/services/mlPool.js
'use strict';

const { query } = require('../db');

// Cache simples para não bater no banco toda hora (opcional, mas bom para performance)
let _tokensCache = null;
let _lastCacheTime = 0;
const CACHE_TTL = 30 * 1000; // 30 segundos

const MlPool = {
  /**
   * 1. Carrega todos os tokens válidos do banco
   */
  async getAllTokens() {
    // Se o cache estiver fresco, usa ele
    if (_tokensCache && (Date.now() - _lastCacheTime < CACHE_TTL)) {
      return _tokensCache;
    }

    const { rows } = await query(`
      SELECT user_id, nickname, access_token 
      FROM ml_tokens 
      WHERE access_token IS NOT NULL 
      ORDER BY updated_at DESC
    `);
    
    _tokensCache = rows;
    _lastCacheTime = Date.now();
    return rows;
  },

  /**
   * 2. A "Mágica": Tenta executar uma chamada usando o pool de tokens
   * até encontrar um que funcione (retorne 200 OK).
   * * @param {string} path - O endpoint da API (ex: /orders/12345)
   * @param {string} method - GET, POST, etc.
   * @param {object} body - Dados para enviar (opcional)
   */
  async fetchWithPool(path, method = 'GET', body = null) {
    const tokens = await this.getAllTokens();
    
    if (tokens.length === 0) {
      throw new Error('Nenhuma conta do Mercado Livre conectada.');
    }

    let lastError = null;

    // Loop de tentativa (Round Robin "burro" mas eficaz)
    for (const account of tokens) {
      try {
        const url = `https://api.mercadolibre.com${path}`;
        const options = {
          method,
          headers: {
            'Authorization': `Bearer ${account.access_token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        };

        if (body) options.body = JSON.stringify(body);

        const res = await fetch(url, options);

        // Se deu 401/403/404, provavelmente esse token não é o dono do pedido
        // Então lançamos erro para o loop continuar
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          throw new Error(`HTTP ${res.status}`);
        }

        if (!res.ok) {
          // Se for outro erro (500, 400), pode ser erro real da API
          const errText = await res.text();
          throw new Error(`Erro ML (${res.status}): ${errText}`);
        }

        // SUCESSO! Achamos o dono.
        const data = await res.json();
        return { 
          data, 
          used_account: account // Retorna qual conta funcionou para podermos salvar
        };

      } catch (e) {
        // Apenas loga debug e tenta o próximo
        // console.debug(`[ML POOL] Falha com conta ${account.nickname}: ${e.message}`);
        lastError = e;
      }
    }

    // Se saiu do loop, ninguém conseguiu
    throw new Error(`Não foi possível encontrar o recurso em nenhuma das ${tokens.length} contas conectadas. (Último erro: ${lastError?.message})`);
  }
};

module.exports = MlPool;