require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const cookieParser = require("cookie-parser");
const fs = require("fs/promises");
const path = require("path");

const router = express.Router();

// ---- env / endpoints ----
const ML_AUTH_BASE = process.env.ML_AUTH_BASE || "https://auth.mercadolivre.com.br";
const ML_API_BASE  = process.env.ML_API_BASE  || "https://api.mercadolibre.com";
const CLIENT_ID     = process.env.ML_APP_ID;
const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const REDIRECT_URI  = process.env.ML_REDIRECT_URI;

// ---- storage simples (arquivo JSON) ----
const STORE = path.resolve(process.cwd(), "data/meli.json");

async function readStore() {
  try { return JSON.parse(await fs.readFile(STORE, "utf8")); }
  catch { return null; }
}
async function writeStore(data) {
  await fs.mkdir(path.dirname(STORE), { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(data, null, 2));
}

// ---- helpers ----
function buildAuthUrl(state) {
  const qs = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    state
  });
  return `${ML_AUTH_BASE}/authorization?${qs.toString()}`;
}

async function postToken(body) {
  const r = await fetch(`${ML_API_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString()
  });
  if (!r.ok) throw new Error(`Token endpoint falhou: ${r.status} ${await r.text()}`);
  return r.json();
}

async function exchangeCode(code) {
  return postToken({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    redirect_uri: REDIRECT_URI
  });
}

async function refreshToken(refresh_token) {
  return postToken({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token
  });
}

async function getMe(access_token) {
  const r = await fetch(`${ML_API_BASE}/users/me`, {
    headers: { Authorization: `Bearer ${access_token}` }
  });
  if (!r.ok) throw new Error(`users/me falhou: ${r.status} ${await r.text()}`);
  return r.json();
}

function expTs(expires_in) {
  // -60s de margem
  return Date.now() + Math.max(0, (expires_in ?? 0) - 60) * 1000;
}

// ---- middlewares locais ----
router.use(cookieParser());
router.use(express.json());

// === 1) iniciar OAuth ===
router.get("/integrations/mercadolivre/connect", (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
    return res
      .status(500)
      .send("Configure ML_APP_ID, ML_CLIENT_SECRET e ML_REDIRECT_URI no .env");
  }
  const state = crypto.randomBytes(16).toString("hex");
  res.cookie("meli_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 10 * 60 * 1000
  });
  res.redirect(buildAuthUrl(state));
});

// === 2) callback ===
router.get("/integrations/mercadolivre/callback", async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;
    if (error) throw new Error(`${error}: ${error_description || ""}`);

    const cookieState = req.cookies.meli_oauth_state;
    if (!state || !cookieState || state !== cookieState) {
      throw new Error("State inválido (proteção CSRF).");
    }
    res.clearCookie("meli_oauth_state");

    const token = await exchangeCode(code);
    const me = await getMe(token.access_token);

    const data = {
      user_id: me.id,
      nickname: me.nickname,
      site_id: me.site_id,
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: expTs(token.expires_in),
      scope: token.scope
    };
    await writeStore(data);

    // volta para a página de config (aba Integrações)
    res.redirect("/settings/config.html#integracoes");
  } catch (e) {
    console.error("[ML callback] erro:", e);
    res.status(500).send(`Erro ao conectar Mercado Livre: ${e.message}`);
  }
});

// === 3) status (para a UI mostrar conectado/desconectado) ===
router.get("/integrations/mercadolivre/status", async (_req, res) => {
  const data = await readStore();
  if (!data || !data.access_token) return res.json({ connected: false });

  // refresh transparente se expirou
  if ((data.expires_at ?? 0) < Date.now()) {
    try {
      const ref = await refreshToken(data.refresh_token);
      Object.assign(data, {
        access_token: ref.access_token,
        refresh_token: ref.refresh_token ?? data.refresh_token,
        expires_at: expTs(ref.expires_in)
      });
      await writeStore(data);
    } catch (e) {
      console.warn("[ML] refresh falhou:", e.message);
      return res.json({ connected: false, error: "refresh_failed" });
    }
  }

  res.json({
    connected: true,
    nickname: data.nickname,
    user_id: data.user_id,
    site_id: data.site_id,
    expires_at: data.expires_at
  });
});

// === 4) “desconectar” (apenas esquecemos os tokens) ===
router.post("/integrations/mercadolivre/disconnect", async (_req, res) => {
  await writeStore({});
  res.json({ ok: true });
});

module.exports = router;