const express = require('express');
const router = express.Router();
const { query } = require('../db');

const CLIENT_ID = process.env.ML_CLIENT_ID;
const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const REDIRECT_URI = process.env.ML_REDIRECT_URI;

// 1. Iniciar Login
router.get('/ml/login', (req, res) => {
  const url = `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
  res.redirect(url);
});

// 2. Callback (Salva o Token)
router.get('/ml/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/settings/config.html?error=' + encodeURIComponent(error));
  if (!code) return res.redirect('/settings/config.html?error=no_code');

  try {
    // Troca Code por Token
    const tokenRes = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: code,
        redirect_uri: REDIRECT_URI
      })
    });

    const data = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(data.message || 'Falha no token');

    // Pega dados do usuário ML
    const userRes = await fetch(`https://api.mercadolibre.com/users/me`, {
      headers: { Authorization: `Bearer ${data.access_token}` }
    });
    const userData = await userRes.json();

    // Calcula Expiração
    const expiresIn = data.expires_in || 21600;
    const expiresAt = new Date(Date.now() + (expiresIn - 300) * 1000).toISOString();

    // Pega o Tenant ID da sessão (se existir) ou define null
    const tenantId = req.session?.user?.tenant_id || null;

    // UPSERT (Salva ou Atualiza se já existir esse ID do ML)
    await query(`
      INSERT INTO ml_tokens (
        user_id, nickname, access_token, refresh_token, 
        expires_at, token_type, scope, raw, updated_at, tenant_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9)
      ON CONFLICT (user_id) DO UPDATE SET
        nickname = EXCLUDED.nickname,
        access_token = EXCLUDED.access_token,
        refresh_token = EXCLUDED.refresh_token,
        expires_at = EXCLUDED.expires_at,
        updated_at = NOW(),
        tenant_id = EXCLUDED.tenant_id;
    `, [
      userData.id, userData.nickname, data.access_token, data.refresh_token,
      expiresAt, data.token_type, data.scope, JSON.stringify(data), tenantId
    ]);

    res.redirect('/settings/config.html?status=connected');
  } catch (e) {
    console.error('[ML AUTH] Erro:', e);
    res.redirect('/settings/config.html?error=' + encodeURIComponent(e.message));
  }
});

// 3. Listar Contas Conectadas (NOVO)
router.get('/ml/list', async (req, res) => {
  try {
    // Se tiver tenant_id, filtra por ele. Se não, pega tudo (modo dev mono-usuário)
    let sql = 'SELECT user_id, nickname, expires_at, updated_at FROM ml_tokens ORDER BY updated_at DESC';
    let params = [];

    if (req.session?.user?.tenant_id) {
      sql = 'SELECT user_id, nickname, expires_at, updated_at FROM ml_tokens WHERE tenant_id = $1 ORDER BY updated_at DESC';
      params = [req.session.user.tenant_id];
    }

    const { rows } = await query(sql, params);
    res.json({ accounts: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 4. Desconectar UMA conta específica
router.post('/ml/disconnect/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    await query('DELETE FROM ml_tokens WHERE user_id = $1', [userId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Rota antiga de status (mantida para compatibilidade, retorna a primeira conta)
router.get('/ml/status', async (req, res) => {
    // Redireciona lógica para a lista, pegando o primeiro
    const { rows } = await query('SELECT nickname FROM ml_tokens LIMIT 1');
    if (rows.length) res.json({ connected: true, nickname: rows[0].nickname });
    else res.json({ connected: false });
});

module.exports = router;