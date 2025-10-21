'use strict';
const express = require('express');
const router = express.Router();
const { query } = require('../db');

router.post('/dev/set-company', async (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(403).json({ error: 'forbidden' });
  if (!req.session?.user?.email) return res.status(401).json({ error: 'not_logged' });

  const slug = String(req.body?.company || '').trim();
  if (!slug) return res.status(400).json({ error: 'company vazio' });

  await query('UPDATE public.users SET company=$1 WHERE email=$2', [slug, req.session.user.email]);
  req.session.user.company = slug;
  res.json({ ok: true, user: req.session.user });
});

module.exports = router;
