// server/middleware/tenant-mw.js
'use strict';

const { pool } = require('../db'); // precisa exportar pool em db.js (veja nota abaixo)

// slug simples a partir do nome da empresa / email
function slugify(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'default';
}

module.exports = function tenantMw() {
  return async (req, _res, next) => {
    try {
      const u = req.session?.user || {};
      // Preferimos o ID se existir; senão usamos um slug textual
      const tenantId   = u.tenant_id ?? null;
      const tenantSlug = req.tenant?.slug || u.company || (u.email ? u.email.split('@')[0] : '') || process.env.TENANT_TEXT_FALLBACK || 'default';
      const slug = slugify(tenantSlug);

      // Helper: executa UMA query dentro de uma transação curta com SET LOCAL
      req.q = async (text, params = []) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          // Setamos as duas chaves: por ID e por SLUG (use a que a sua policy usar)
          await client.query(
            `SELECT set_config('app.tenant_id',   $1, true),
                    set_config('app.tenant_slug', $2, true)`,
            [tenantId == null ? '' : String(tenantId), slug]
          );
          const r = await client.query(text, params);
          await client.query('COMMIT');
          return r;
        } catch (e) {
          try { await client.query('ROLLBACK'); } catch (_) {}
          throw e;
        } finally {
          client.release();
        }
      };

      // Deixe a informação disponível para logs/rotas
      req.tenant = {
        id: tenantId ?? null,
        slug: slug
      };

      next();
    } catch (e) {
      next(e);
    }
  };
};
