// server/services/mlWorker.js
'use strict';

const { query } = require('../db'); // Ajuste o caminho conforme necessário

// Variáveis de controle interno
let _syncTimer = null;
let _refreshTimer = null;

const MlWorker = {
  /**
   * Inicia todos os jobs de background
   * @param {number} port Porta onde o servidor está rodando (para chamadas internas)
   */
  start(port) {
    console.log('👷 [WORKER] Iniciando serviços de background...');
    this.startSync(port);
    this.startTokenRefresh();
  },

  /**
   * Job 1: Sincronização de Vendas/Claims (Chama a API interna)
   */
  startSync(port) {
    const enabled = String(process.env.ML_AUTO_SYNC_ENABLED ?? 'true') === 'true';
    if (!enabled) return console.log('⏸️ [WORKER] AutoSync desabilitado por ENV');

    const intervalMs = parseInt(process.env.ML_AUTO_SYNC_INTERVAL_MS || '600000'); // Padrão: 10 min
    const jobToken = process.env.JOB_TOKEN || process.env.ML_JOB_TOKEN || 'dev-job';

    const run = async () => {
      console.log('🔄 [WORKER] Disparando sync ML...');
      try {
        // Chama a rota localmente. 
        // Nota: Em uma arquitetura perfeita, chamaria o Controller direto, mas via HTTP garante que passe pelos Middlewares.
        const url = `http://127.0.0.1:${port}/api/ml/claims/import?silent=1`;
        const res = await fetch(url, {
          headers: { 'x-job-token': jobToken }
        });
        
        if (!res.ok) {
          const txt = await res.text();
          console.error(`❌ [WORKER] Erro no sync HTTP ${res.status}:`, txt.substring(0, 100));
        }
      } catch (e) {
        console.error('❌ [WORKER] Erro de conexão no sync:', e.message);
      }
    };

    // Executa imediatamente após 5s de boot
    setTimeout(run, 5000);
    // Agenda repetição
    _syncTimer = setInterval(run, intervalMs);
    console.log(`✅ [WORKER] AutoSync agendado a cada ${intervalMs / 1000}s`);
  },

  /**
   * Job 2: Renovação de Tokens OAuth (Lógica direta no Banco)
   */
  startTokenRefresh() {
    const enabled = String(process.env.ML_AUTO_REFRESH_ENABLED ?? 'true') === 'true';
    if (!enabled) return;

    const intervalMs = 15 * 60 * 1000; // Verifica a cada 15 min
    const aheadSec = 900; // Renova se faltar menos de 15 min para vencer

    const run = async () => {
      try {
        // 1. Busca tokens vencendo
        const { rows } = await query(`
          SELECT user_id, refresh_token 
          FROM ml_tokens 
          WHERE expires_at < now() + INTERVAL '${aheadSec} seconds'
            AND coalesce(refresh_token, '') <> ''
        `);

        if (rows.length === 0) return; // Nada a fazer

        console.log(`🔄 [WORKER] Renovando ${rows.length} tokens ML que vão expirar...`);

        // 2. Processa cada um
        for (const row of rows) {
          await this._refreshToken(row.user_id, row.refresh_token);
        }
      } catch (e) {
        console.error('❌ [WORKER] Erro geral no Refresh:', e.message);
      }
    };

    _refreshTimer = setInterval(run, intervalMs);
    // Roda uma vez no boot (com atraso pra não pesar o start)
    setTimeout(run, 10000);
    console.log(`✅ [WORKER] TokenRefresh iniciado`);
  },

  /**
   * Lógica privada de renovação individual
   */
  async _refreshToken(userId, refreshToken) {
    const clientId = process.env.ML_CLIENT_ID;
    const clientSecret = process.env.ML_CLIENT_SECRET;
    const tokenUrl = 'https://api.mercadolibre.com/oauth/token';

    try {
      const params = new URLSearchParams();
      params.append('grant_type', 'refresh_token');
      params.append('client_id', clientId);
      params.append('client_secret', clientSecret);
      params.append('refresh_token', refreshToken);

      const resp = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params
      });

      if (!resp.ok) {
        const errTxt = await resp.text();
        throw new Error(`ML API ${resp.status}: ${errTxt}`);
      }

      const data = await resp.json();
      
      // Calcula nova expiração (tira 5 min de margem de segurança)
      const expiresIn = (data.expires_in || 21600) - 300; 
      const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

      // Atualiza no banco
      await query(`
        UPDATE ml_tokens
           SET access_token = $1,
               refresh_token = $2,
               expires_at = $3,
               updated_at = now()
         WHERE user_id = $4
      `, [data.access_token, data.refresh_token, expiresAt, userId]);

      console.log(`   -> Token renovado para User ID ${userId}`);

    } catch (e) {
      console.error(`   -> Falha ao renovar User ID ${userId}:`, e.message);
    }
  }
};

module.exports = MlWorker;