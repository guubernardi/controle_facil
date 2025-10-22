// server/routes/auth-register.js
'use strict';

const express = require('express');
const bcrypt = require('bcrypt');               // unifica com o auth.js
const { query } = require('../db');

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);

function signupEnabled() {
  return String(process.env.OPEN_SIGNUP ?? 'false').toLowerCase() === 'true';
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').toLowerCase());
}

// Em ambientes novos SEM migrations rodadas, criamos o básico.
// Em bancos já migrados (001_users.sql), isso só faz no-ops.
async function ensureUsersTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'operador',   -- alinhar com o CHECK das migrations
      company TEXT,
      tenant_id INT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (lower(email));`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS company   TEXT;`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_id INT;`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;`);
}

module.exports = function registerAuthRegister(app) {
  const router = express.Router();

  ensureUsersTable().catch(err => {
    console.error('[auth-register] Falha ao garantir tabela users:', err);
  });

  // GET /api/auth/check-email
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

  // POST /api/auth/register
  router.post('/register', async (req, res) => {
    try {
      if (!signupEnabled()) return res.status(403).json({ ok: false, error: 'signup_disabled' });

      const {
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

      // IMPORTANT: alinhar com o CHECK das migrations (admin|gestor|operador)
      const role = isFirst ? 'admin' : 'operador';

      const hash = await bcrypt.hash(pass, BCRYPT_ROUNDS);

      const ins = await query(
        `INSERT INTO users (name, email, password_hash, role, is_active, company)
         VALUES ($1,$2,$3,$4, TRUE, $5)
         RETURNING id, name, email, role, company, tenant_id, created_at AS "createdAt"`,
        [displayName, mail, hash, role, comp || null]
      );
      const user = ins.rows[0];

      // cria sessão automaticamente
      req.session.user = {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        company: user.company || null,
        tenant_id: user.tenant_id ?? null
      };

      res.status(201).json({ ok: true, user: req.session.user });
    } catch (e) {
      // Mapeia erros comuns (CHECK/constraint/NULL)
      const code = String(e?.code || '');
      if (code === '23514') return res.status(400).json({ error: 'Perfil inválido para cadastro. Contate o administrador.' });
      if (code === '23505') return res.status(409).json({ error: 'Email já cadastrado' });
      console.error('[auth-register] /register erro:', e);
      res.status(500).json({ error: 'Falha ao cadastrar' });
    }
  });

  app.use('/api/auth', router);
};
