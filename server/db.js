// Centraliza a conexão com o banco de dados e expõe um helper de query.

require('dotenv').config();  // Carrega variaveis do .env
const { Pool } = require('pg');

// Usa a string de conexão do .env
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

// Helper para executar SQL
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
