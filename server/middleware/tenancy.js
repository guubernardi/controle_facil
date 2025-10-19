'use strict';

/**
 * Tenancy middleware
 * - exige req.session.user com tenantId/orgId
 * - expõe req.tenantId para as rotas
 */
module.exports = function tenancy() {
  return (req, res, next) => {
    const t = req.session?.user?.orgId || req.session?.user?.tenantId;
    if (!t) return res.status(403).json({ error: 'tenant_missing' });
    req.tenantId = Number(t) || t;
    next();
  };
};
