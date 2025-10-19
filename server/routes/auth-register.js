// server/routes/auth-register.js
'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db');

async function ensureUsersTable() {
  // Cria tabela básica de usuários se não existir + índice único de email (case-insensitive)
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (lower(email));
  `);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').toLowerCase());
}

module.exports = function registerAuthRegister(app) {
  const router = express.Router();

  // Garantir tabela
  ensureUsersTable().catch(err => {
    console.error('[auth-register] Falha ao garantir tabela users:', err);
  });

  // Verificar email existente (para validação client-side opcional)
  router.get('/check-email', async (req, res) => {
    try {
      const email = String(req.query.email || '').trim().toLowerCase();
      if (!isValidEmail(email)) return res.json({ exists: false });
      const r = await query(`SELECT 1 FROM users WHERE lower(email)=lower($1) LIMIT 1`, [email]);
      res.json({ exists: r.rowCount > 0 });
    } catch (e) {
      console.error('[auth-register] /check-email erro:', e);
      res.status(500).json({ error: 'Falha ao verificar email' });
    }
  });

  // Cadastro
  router.post('/register', async (req, res) => {
    try {
      const name = String(req.body.name || '').trim();
      const email = String(req.body.email || '').trim().toLowerCase();
      const password = String(req.body.password || '');

      if (!name || name.length < 2) return res.status(400).json({ error: 'Nome inválido' });
      if (!isValidEmail(email))     return res.status(400).json({ error: 'Email inválido' });
      if (password.length < 6)      return res.status(400).json({ error: 'Senha deve ter ao menos 6 caracteres' });

      const dup = await query(`SELECT id FROM users WHERE lower(email)=lower($1) LIMIT 1`, [email]);
      if (dup.rowCount) return res.status(409).json({ error: 'Email já cadastrado' });

      const hash = await bcrypt.hash(password, 10);
      const ins = await query(
        `INSERT INTO users (name, email, password_hash, role)
         VALUES ($1,$2,$3,'user')
         RETURNING id, name, email, role, created_at AS "createdAt"`,
        [name, email, hash]
      );
      const user = ins.rows[0];

      // cria sessão automaticamente
      try {
        req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
      } catch (_) {}

      res.status(201).json({ ok: true, user });
    } catch (e) {
      console.error('[auth-register] /register erro:', e);
      res.status(500).json({ error: 'Falha ao cadastrar' });
    }
  });

  app.use('/api/auth', router);
};
