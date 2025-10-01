// scripts/add-cd-fields.js
'use strict';

require('dotenv').config();
const { query, pool } = require('../server/db');

/**
 * Helpers
 */
async function columnExists(table, column) {
  const sql = `
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = $1
       AND column_name  = $2
     LIMIT 1`;
  const r = await query(sql, [table, column]);
  return !!r.rows[0];
}

async function indexExists(indexName) {
  const sql = `
    SELECT 1
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname  = $1
     LIMIT 1`;
  const r = await query(sql, [indexName]);
  return !!r.rows[0];
}

async function addColumnIfMissing(table, column, typeSql) {
  const has = await columnExists(table, column);
  if (has) return { created: false, table, column };
  await query(`ALTER TABLE public.${table} ADD COLUMN ${column} ${typeSql};`);
  return { created: true, table, column };
}

async function main() {
  const changes = [];

  // 1) Campos opcionais do CD na tabela devolucoes
  changes.push(await addColumnIfMissing('devolucoes', 'log_status',         'text'));
  changes.push(await addColumnIfMissing('devolucoes', 'cd_recebido_em',     'timestamptz'));
  changes.push(await addColumnIfMissing('devolucoes', 'cd_inspecionado_em', 'timestamptz'));
  changes.push(await addColumnIfMissing('devolucoes', 'cd_responsavel',     'text'));
  changes.push(await addColumnIfMissing('devolucoes', 'cd_laudo',           'text'));
  changes.push(await addColumnIfMissing('devolucoes', 'cd_midias',          'jsonb'));

  // 2) Índices úteis (checar antes de criar)
  if (!(await indexExists('ix_devolucoes_log_status'))) {
    await query(`CREATE INDEX ix_devolucoes_log_status ON public.devolucoes (log_status);`);
    changes.push({ created: true, index: 'ix_devolucoes_log_status' });
  } else {
    changes.push({ created: false, index: 'ix_devolucoes_log_status' });
  }

  if (!(await indexExists('ix_devolucoes_status'))) {
    await query(`CREATE INDEX ix_devolucoes_status ON public.devolucoes (status);`);
    changes.push({ created: true, index: 'ix_devolucoes_status' });
  } else {
    changes.push({ created: false, index: 'ix_devolucoes_status' });
  }

  if (!(await indexExists('ix_devolucoes_cd_inspec'))) {
    await query(`CREATE INDEX ix_devolucoes_cd_inspec ON public.devolucoes (cd_inspecionado_em);`);
    changes.push({ created: true, index: 'ix_devolucoes_cd_inspec' });
  } else {
    changes.push({ created: false, index: 'ix_devolucoes_cd_inspec' });
  }

  // 3) Idempotência em return_events (coluna + índice único parcial)
  //    - coluna
  if (!(await columnExists('return_events', 'idemp_key'))) {
    await query(`ALTER TABLE public.return_events ADD COLUMN idemp_key text;`);
    changes.push({ created: true, table: 'return_events', column: 'idemp_key' });
  } else {
    changes.push({ created: false, table: 'return_events', column: 'idemp_key' });
  }

  //    - índice único parcial
  if (!(await indexExists('ux_return_events_idemp_key'))) {
    await query(`
      CREATE UNIQUE INDEX ux_return_events_idemp_key
        ON public.return_events (idemp_key)
       WHERE idemp_key IS NOT NULL;
    `);
    changes.push({ created: true, index: 'ux_return_events_idemp_key' });
  } else {
    changes.push({ created: false, index: 'ux_return_events_idemp_key' });
  }

  // 4) Índice auxiliar por (return_id, created_at) para leitura de eventos
  if (!(await indexExists('ix_return_events_returnid_createdat'))) {
    await query(`
      CREATE INDEX ix_return_events_returnid_createdat
        ON public.return_events (return_id, created_at);
    `);
    changes.push({ created: true, index: 'ix_return_events_returnid_createdat' });
  } else {
    changes.push({ created: false, index: 'ix_return_events_returnid_createdat' });
  }

  console.log('✅ Migration CD finalizada.');
  for (const c of changes) console.log('  -', c);

  await pool.end();
}

main().catch(async (err) => {
  console.error('❌ Erro na migration CD:', err);
  try { await pool.end(); } catch {}
  process.exit(1);
});
