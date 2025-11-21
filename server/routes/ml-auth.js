const express = require('express');
const router = express.Router();
const { query } = require('../db');

// Configurações do ML (Carregadas do .env)
const CLIENT_ID = process.env.ML_CLIENT_ID;
const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const REDIRECT_URI = process.env.ML_REDIRECT_URI; // Ex: https://seu-app.onrender.com/api/auth/ml/callback

// 1. Rota que inicia o Login (Redireciona o usuário para o ML)
router.get('/ml/login', (req, res) => {
  if (!CLIENT_ID || !REDIRECT_URI) {
    return res.status(500).send('Configuração ML_CLIENT_ID ou ML_REDIRECT_URI ausente no servidor.');
  }
  
  const url = `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
  res.redirect(url);
});

// 2. Rota de Callback (Onde o ML devolve o usuário com o código)
router.get('/ml/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) return res.redirect('/settings/config.html?error=' + encodeURIComponent(error));
  if (!code) return res.redirect('/settings/config.html?error=no_code');

  try {
    // Troca o Code pelo Token
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

    if (!tokenRes.ok) {
      throw new Error(data.message || data.error || 'Falha na troca do token');
    }

    // Calcula expiração (6h padrão)
    const expiresIn = data.expires_in || 21600;
    const expiresAt = new Date(Date.now() + (expiresIn - 300) * 1000).toISOString(); // -5min margem

    // Pega dados do usuário (para saber o ID e Nickname)
    const userRes = await fetch(`https://api.mercadolibre.com/users/me`, {
      headers: { Authorization: `Bearer ${data.access_token}` }
    });
    const userData = await userRes.json();
    
    // Salva no Banco (Upsert - Cria ou Atualiza)
    await query(`
      INSERT INTO ml_tokens (
        user_id, nickname, access_token, refresh_token, 
        expires_at, token_type, scope, raw, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        nickname = EXCLUDED.nickname,
        access_token = EXCLUDED.access_token,
        refresh_token = EXCLUDED.refresh_token,
        expires_at = EXCLUDED.expires_at,
        updated_at = NOW();
    `, [
      userData.id,
      userData.nickname,
      data.access_token,
      data.refresh_token,
      expiresAt,
      data.token_type,
      data.scope,
      JSON.stringify(data)
    ]);

    // Sucesso! Manda de volta pra tela de config
    res.redirect('/settings/config.html?status=connected');

  } catch (e) {
    console.error('[ML AUTH] Erro:', e);
    res.redirect('/settings/config.html?error=' + encodeURIComponent(e.message));
  }
});

// 3. Rota para o Frontend saber se já está conectado
router.get('/ml/status', async (req, res) => {
  try {
    // Pega o token mais recente (simples para mono-usuário)
    const { rows } = await query('SELECT nickname, updated_at, expires_at FROM ml_tokens ORDER BY updated_at DESC LIMIT 1');
    
    if (rows.length === 0) {
      return res.json({ connected: false });
    }

    const token = rows[0];
    const isExpired = new Date(token.expires_at) < new Date();

    res.json({
      connected: true,
      nickname: token.nickname,
      expired: isExpired,
      last_update: token.updated_at
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;