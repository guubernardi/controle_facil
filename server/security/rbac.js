// server/security/rbac.js
'use strict';

/** Papéis conhecidos: admin > operador > leitura */
const LEVEL = { leitura: 0, operador: 1, admin: 2 };

function getRole(req) {
  return (req.session && req.session.user && req.session.user.role) || 'leitura';
}

/** Garante que o usuário tenha UMA das roles informadas. */
function requireRole(...allowed) {
  return function(req, res, next) {
    try {
      const role = getRole(req);
      if (allowed.includes(role)) return next();
      return res.status(403).json({ error: 'forbidden', details: { have: role, needOneOf: allowed } });
    } catch (e) {
      return res.status(403).json({ error: 'forbidden' });
    }
  };
}

/** Verifica se a role do usuário é >= a requerida (hierarquia). */
function requireAtLeast(minRole) {
  return function(req, res, next) {
    const role = getRole(req);
    if ((LEVEL[role] || 0) >= (LEVEL[minRole] || 0)) return next();
    return res.status(403).json({ error: 'forbidden', details: { have: role, min: minRole } });
  };
}

module.exports = { requireRole, requireAtLeast, getRole };
