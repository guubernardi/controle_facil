'use strict';
const express = require('express');
const router = express.Router();
const { resolveSkuByMlb } = require('../blingResolver');

router.get('/api/utils/resolve-sku', async (req, res) => {
  const mlb = String(req.query.mlb || '').trim().toUpperCase();
  if (!mlb) return res.status(400).json({ ok: false, error: 'Parâmetro mlb é obrigatório' });

  try {
    const sku = await resolveSkuByMlb(mlb);

    if (!sku) {
      return res.status(404).json({ ok: false, mlb, error: 'SKU não encontrado para este MLB' });
    }

    res.json({ ok: true, mlb, sku });
  } catch (e) {
    res.status(500).json({ ok: false, mlb, error: e.message || 'Falha ao consultar' });
  }
});

module.exports = router;
