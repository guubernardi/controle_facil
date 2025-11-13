// server/routes/uploads.js
'use strict';
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const now = new Date();
    const dir = path.join(__dirname, '..', '..', 'public', 'uploads',
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, '0'));
    ensureDir(dir);
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const id = (crypto.randomUUID && typeof crypto.randomUUID === 'function') ? crypto.randomUUID() : require('crypto').randomBytes(16).toString('hex');
    const ext = path.extname(file.originalname || '').toLowerCase();
    cb(null, `${id}${ext || '.jpg'}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 10 }, // 10MB, máx 10
  fileFilter: (_req, file, cb) => {
    if (String(file.mimetype || '').startsWith('image/')) return cb(null, true);
    cb(new Error('Apenas imagens são permitidas.'));
  }
});

router.post('/', upload.array('files', 10), (req, res) => {
  const files = (req.files || []).map(f => {
    // url pública
    const rel = f.path.split(path.sep).slice(-3).join('/'); // uploads/YY/MM/filename
    const url = `/uploads/${rel.split('/uploads/').pop?.() || rel}`;
    return {
      url,
      original_filename: f.originalname,
      mimetype: f.mimetype,
      size: f.size,
      filename: path.basename(f.filename)
    };
  });
  res.json({ files });
});

module.exports = router;
