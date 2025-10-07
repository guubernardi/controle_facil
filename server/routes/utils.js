'use strict';
const express = require('express');
const router = express.Router();
const { resolveSkuByMlb } = require('../blingResolver');

router.get('/api/utils/resolve-sku', async (req, res) => {
  const mlb = String(req.query.mlb || '').trim();
  if (!mlb) return res.status(400).json({ ok:false, error:'Parâmetro mlb é obrigatório' });
  try {
    const sku = await resolveSkuByMlb(mlb);
    res.json({ ok:true, mlb, sku });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

module.exports = router;
