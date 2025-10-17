// server/routes/auth.js
"use strict";

const express = require("express");
const bcrypt = require("bcrypt");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit"); // <- v7
const crypto = require("crypto");
const { query } = require("../db");

const router = express.Router();
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || "12", 10);

// validações simples
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").toLowerCase());
const isStrong = (s) => typeof s === "string" && s.length >= 8;

/**
 * Rate limit de login (5 tentativas / 15min por IP)
 * - v7 usa `limit` (não `max`)
 * - usar `ipKeyGenerator` para normalizar IPv4/IPv6 com segurança
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  handler: (_req, res) => {
    res.status(429).json({ error: "Muitas tentativas. Tente novamente em alguns minutos." });
  },
});

// bloqueio curto em memória após várias falhas (IP+email)
const fails = new Map();
const keyFor = (ip, email) => `${ip}|${String(email || "").toLowerCase()}`;
const isBlocked = (key) => {
  const e = fails.get(key);
  return e && e.until && e.until > Date.now();
};
const regFail = (key) => {
  const e = fails.get(key) || { n: 0, until: 0 };
  e.n += 1;
  if (e.n >= 5) { e.until = Date.now() + 15 * 60 * 1000; e.n = 0; }
  fails.set(key, e);
};
const clearFail = (key) => fails.delete(key);

// --- middlewares reusáveis ---
function authRequired(req, res, next) {
  if (req.session?.user) return next();
  return res.status(401).json({ error: "Não autorizado" });
}
function roleRequired(...roles) {
  const set = new Set(roles);
  return (req, res, next) => {
    const r = req.session?.user?.role;
    if (r && set.has(r)) return next();
    return res.status(403).json({ error: "Proibido" });
  };
}

// --- rotas ---
router.get("/me", (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: "Não autorizado" });
  res.json({ user: req.session.user });
});

router.post("/login", loginLimiter, async (req, res) => {
  try {
    const { email, password, remember } = req.body || {};
    const key = keyFor(req.ip, email);
    if (isBlocked(key)) {
      return res.status(429).json({ error: "Temporariamente bloqueado por tentativas falhas. Aguarde alguns minutos." });
    }

    if (!isEmail(email) || !isStrong(password)) {
      return res.status(400).json({ error: "Credenciais inválidas." });
    }

    const { rows } = await query(
      `SELECT id, name, email, role, is_active, password_hash
         FROM users WHERE lower(email)=lower($1) LIMIT 1`,
      [email]
    );
    const u = rows[0];
    if (!u || !u.is_active) {
      regFail(key);
      return res.status(401).json({ error: "E-mail ou senha incorretos." });
    }

    const ok = await bcrypt.compare(String(password), u.password_hash);
    if (!ok) {
      regFail(key);
      return res.status(401).json({ error: "E-mail ou senha incorretos." });
    }

    clearFail(key);
    await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [u.id]);

    req.session.user = { id: u.id, name: u.name, email: u.email, role: u.role };
    // 12h padrão; 30d se lembrar
    req.session.cookie.maxAge = (remember ? 30 * 24 : 12) * 60 * 60 * 1000;

    console.log(`[auth] login OK: ${u.email} (${u.role})`);
    res.json({ user: req.session.user });
  } catch (e) {
    console.error("[auth/login] erro", e);
    res.status(500).json({ error: "Falha ao autenticar." });
  }
});

router.post("/logout", (req, res) => {
  const who = req.session?.user?.email;
  req.session.destroy(() => {
    if (who) console.log(`[auth] logout: ${who}`);
    res.json({ ok: true });
  });
});

// fluxo de reset (gera token, loga link no server)
router.post("/request-reset", async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!isEmail(email)) {
      return res.json({ message: "Se o e-mail existir, enviaremos instruções para redefinir a senha." });
    }

    const r = await query(`SELECT id FROM users WHERE lower(email)=lower($1) LIMIT 1`, [email]);
    if (r.rows[0]) {
      const userId = r.rows[0].id;
      const raw = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(raw).digest("hex");
      const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2h

      await query(
        `INSERT INTO password_resets (user_id, token_hash, expires_at, created_at)
         VALUES ($1, $2, $3, now())`,
        [userId, tokenHash, expiresAt]
      );

      const base = process.env.BASE_URL || "";
      const url = `${base}/reset.html?token=${raw}`;
      console.log(`[auth] reset link para ${email}: ${url}`);
    }
    res.json({ message: "Se o e-mail existir, enviaremos instruções para redefinir a senha." });
  } catch (e) {
    console.error("[auth/request-reset] erro", e);
    res.json({ message: "Se o e-mail existir, enviaremos instruções para redefinir a senha." });
  }
});

router.post("/reset", async (req, res) => {
  try {
    const { token, nova_senha } = req.body || {};
    if (!isStrong(nova_senha)) return res.status(400).json({ error: "Senha fraca. Use 8+ caracteres." });

    const tokenHash = crypto.createHash("sha256").update(String(token || "")).digest("hex");
    const r = await query(
      `SELECT id, user_id
         FROM password_resets
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
        ORDER BY id DESC LIMIT 1`,
      [tokenHash]
    );
    const pr = r.rows[0];
    if (!pr) return res.status(400).json({ error: "Token inválido ou expirado." });

    const hash = await bcrypt.hash(String(nova_senha), BCRYPT_ROUNDS);
    await query("BEGIN");
    await query(`UPDATE users SET password_hash=$1, updated_at=now() WHERE id=$2`, [hash, pr.user_id]);
    await query(`UPDATE password_resets SET used_at=now() WHERE id=$1`, [pr.id]);
    await query("COMMIT");

    res.json({ ok: true });
  } catch (e) {
    await query("ROLLBACK").catch(() => {});
    console.error("[auth/reset] erro", e);
    res.status(500).json({ error: "Falha ao redefinir senha." });
  }
});

// Admin cria usuários
router.post("/register", authRequired, roleRequired("admin"), async (req, res) => {
  try {
    const { name, email, role = "operador", is_active = true, password } = req.body || {};
    if (!name || !isEmail(email) || !["admin","gestor","operador"].includes(role)) {
      return res.status(400).json({ error: "Dados inválidos" });
    }
    if (!isStrong(password)) return res.status(400).json({ error: "Senha fraca (mín. 8 chars)." });

    const hash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
    const ins = await query(
      `INSERT INTO users (name,email,password_hash,role,is_active)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id,name,email,role,is_active,created_at`,
      [name, String(email).toLowerCase(), hash, role, !!is_active]
    );
    res.status(201).json({ user: ins.rows[0] });
  } catch (e) {
    if (String(e.code) === "23505") return res.status(409).json({ error: "E-mail já cadastrado" });
    console.error("[auth/register] erro", e);
    res.status(500).json({ error: "Falha ao cadastrar" });
  }
});

// exporta middlewares para uso no server.js
router.authRequired = authRequired;
router.roleRequired = roleRequired;

module.exports = router;
