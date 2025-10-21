// server/routes/auth-register.js
'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db');

function signupEnabled() {
  return String(process.env.OPEN_SIGNUP ?? 'false').toLowerCase() === 'true';
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').toLowerCase());
}

async function ensureUsersTable() {
  // Cria tabela básica (se não existir)
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      company TEXT,
      tenant_id INT,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);
  // Unicidade case-insensitive de e-mail
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (lower(email));`);
  // Garante colunas extras caso a tabela já existisse
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS company   TEXT;`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_id INT;`);
}

module.exports = function registerAuthRegister(app) {
  const router = express.Router();

  ensureUsersTable().catch(err => {
    console.error('[auth-register] Falha ao garantir tabela users:', err);
  });

  // Checar se o e-mail já existe (para validação client-side)
  router.get('/check-email', async (req, res) => {
    try {
      if (!signupEnabled()) return res.status(403).json({ ok: false, error: 'signup_disabled' });
      const email = String(req.query.email || '').trim().toLowerCase();
      if (!isValidEmail(email)) return res.json({ exists: false });
      const r = await query(`SELECT 1 FROM users WHERE lower(email)=lower($1) LIMIT 1`, [email]);
      res.json({ exists: r.rowCount > 0 });
    } catch (e) {
      console.error('[auth-register] /check-email erro:', e);
      res.status(500).json({ error: 'Falha ao verificar email' });
    }
  });

  // Registrar novo usuário
  router.post('/register', async (req, res) => {
    try {
      if (!signupEnabled()) return res.status(403).json({ ok: false, error: 'signup_disabled' });

      const {
        // aceita ambos formatos
        name,
        firstName, lastName,
        empresa, company,
        email,
        password
      } = req.body || {};

      const displayName = (name && String(name).trim())
        || [String(firstName||'').trim(), String(lastName||'').trim()].filter(Boolean).join(' ')
        || '';

      const comp = String(company ?? empresa ?? '').trim();
      const mail = String(email || '').trim().toLowerCase();
      const pass = String(password || '');

      if (!displayName || displayName.length < 2) return res.status(400).json({ error: 'Nome inválido' });
      if (!isValidEmail(mail))                    return res.status(400).json({ error: 'Email inválido' });
      if (pass.length < 6)                        return res.status(400).json({ error: 'Senha deve ter ao menos 6 caracteres' });

      const dup = await query(`SELECT id FROM users WHERE lower(email)=lower($1) LIMIT 1`, [mail]);
      if (dup.rowCount) return res.status(409).json({ error: 'Email já cadastrado' });

      const { rows: cntR } = await query(`SELECT COUNT(*)::int AS n FROM users`);
      const isFirst = (cntR[0]?.n || 0) === 0;
      const role = isFirst ? 'admin' : 'user';

      const hash = await bcrypt.hash(pass, 10);

      const ins = await query(
        `INSERT INTO users (name, email, password_hash, role, company)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id, name, email, role, company, tenant_id, created_at AS "createdAt"`,
        [displayName, mail, hash, role, comp || null]
      );
      const user = ins.rows[0];

      // cria sessão automaticamente
      try {
        req.session.user = {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          company: user.company || null,
          tenant_id: user.tenant_id ?? null
        };
      } catch (_) {}

      res.status(201).json({ ok: true, user: req.session.user });
    } catch (e) {
      console.error('[auth-register] /register erro:', e);
      res.status(500).json({ error: 'Falha ao cadastrar' });
    }
  });

  app.use('/api/auth', router);
};
