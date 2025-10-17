// server/db.js
'use strict';

const { Pool } = require('pg');

// 1) Pegamos só a DATABASE_URL do .env (dotenv já carregou no server.js)
const rawUrl = process.env.DATABASE_URL;
if (!rawUrl) {
  throw new Error('DATABASE_URL ausente no ambiente (.env)');
}

// 2) Opcional: log seguro do host (sem credenciais)
try {
  const u = new URL(rawUrl);
  console.log('[DB] usando host:', u.hostname);
} catch {
  console.warn('[DB] DATABASE_URL inválida?');
}

// 3) Cria o pool **somente** com connectionString (ignora PGHOST/PGPORT, etc.)
const pool = new Pool({
  connectionString: rawUrl,
  max: parseInt(process.env.PGPOOL_MAX || '10', 10),
  idleTimeoutMillis: 30_000,
  ssl: (() => {
    const s = rawUrl.toLowerCase();
    // Neon e similares pedem SSL; se já tiver sslmode=require na URL, ok.
    if (s.includes('neon.tech') || s.includes('sslmode=require')) {
      return { rejectUnauthorized: false };
    }
    // Se quiser forçar por env:
    return process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false;
  })(),
});

// 4) Helper padrão
async function query(text, params) {
  return pool.query(text, params);
}

module.exports = { pool, query };
