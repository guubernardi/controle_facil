// scripts/apply-schema.js
'use strict';
require('dotenv').config();

const path = require('path');
// garante que o require funcione sendo chamado da raiz
const { query } = require(path.join('..', 'server', 'db'));

async function run(sql) {
  return query(sql);
}

(async () => {
  try {
    // Tudo dentro de uma transação simples
    await run(`
BEGIN;

-- ===========================
-- TABELAS
-- ===========================

CREATE TABLE IF NOT EXISTS bling_accounts (
  id           SERIAL PRIMARY KEY,
  apelido      TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bling_accounts_apelido_expires ON bling_accounts(apelido, expires_at);

CREATE TABLE IF NOT EXISTS lojas_bling (
  id         INTEGER PRIMARY KEY,
  nome       TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devolucoes (
  id               BIGSERIAL PRIMARY KEY,
  data_compra      DATE,
  id_venda         TEXT,
  loja_id          INTEGER,
  loja_nome        TEXT,
  sku              TEXT,
  tipo_reclamacao  TEXT,
  status           TEXT,
  log_status       TEXT,
  valor_produto    NUMERIC(12,2),
  valor_frete      NUMERIC(12,2),
  reclamacao       TEXT,
  nfe_numero       TEXT,
  nfe_chave        TEXT,
  cliente_nome     TEXT,
  created_by       TEXT,
  updated_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_devolucoes_created_at ON devolucoes(created_at);

CREATE TABLE IF NOT EXISTS return_events (
  id          BIGSERIAL PRIMARY KEY,
  return_id   BIGINT NOT NULL REFERENCES devolucoes(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  title       TEXT,
  message     TEXT,
  meta        JSONB,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_return_events_return_id ON return_events(return_id);
CREATE INDEX IF NOT EXISTS idx_return_events_created_at ON return_events(created_at);

-- (Opcional) Se quiser forçar tipos permitidos para 'type', crie depois manualmente um CHECK.
-- Evitei aqui para 100% de compatibilidade.

-- ===========================
-- VIEW de logs de custo
-- ===========================
DROP VIEW IF EXISTS v_return_cost_log CASCADE;

CREATE VIEW v_return_cost_log AS
SELECT
  d.created_at                                              AS event_at,
  LOWER(COALESCE(d.status,''))                              AS status,
  LOWER(COALESCE(d.log_status,''))                          AS log_status,
  d.id_venda                                                AS numero_pedido,
  d.cliente_nome                                            AS cliente_nome,
  d.loja_nome                                               AS loja_nome,
  COALESCE(d.valor_produto,0)::NUMERIC(12,2)                AS valor_produto,
  COALESCE(d.valor_frete,0)::NUMERIC(12,2)                  AS valor_frete,
  (
    CASE
      WHEN LOWER(COALESCE(d.status,'')) LIKE '%rej%' OR LOWER(COALESCE(d.status,'')) LIKE '%neg%'
        THEN 0
      WHEN LOWER(COALESCE(d.tipo_reclamacao,'')) LIKE '%cliente%'
        THEN 0
      WHEN LOWER(COALESCE(d.log_status,'')) IN ('recebido_cd','em_inspecao')
        THEN COALESCE(d.valor_frete,0)
      ELSE COALESCE(d.valor_produto,0) + COALESCE(d.valor_frete,0)
    END
  )::NUMERIC(12,2)                                          AS total,
  d.sku                                                     AS sku,
  d.reclamacao                                              AS reclamacao,
  NULL::TEXT                                                AS responsavel_custo
FROM devolucoes d;

COMMIT;
    `);

    console.log('✅ Esquema aplicado com sucesso (tabelas + view v_return_cost_log criadas).');
    process.exit(0);
  } catch (err) {
    console.error('❌ Falha ao aplicar esquema:', err);
    try { await run('ROLLBACK;'); } catch {}
    process.exit(1);
  }
})();
