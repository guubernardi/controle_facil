// Centraliza a conexão com o banco de dados e expõe um helper de query (Postgres/Neon)
'use strict';

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // ssl: { rejectUnauthorized: false } // <- habilite se seu provedor exigir SSL (Neon/Render/etc.)
});

// Helper para executar SQL com pool
async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    const res = await client.query(sql, params);
    return res;
  } finally {
    client.release();
  }
}

module.exports = { pool, query };
