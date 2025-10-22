// central.js

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TOAST_BOX = $("#toastContainer");
const POLL_MS = 50000;        // 50s
const LOADER_MIN_MS = 6000;   // tempo mínimo do overlay fullscreen (6s)

const seen = new Set();
let firstRun = true;
let pollingOn = true;
document.addEventListener("visibilitychange", () => {
  pollingOn = document.visibilityState === "visible";
});

// Helpers de URL
const openUrlForId = (id) => `index.html?return_id=${encodeURIComponent(id)}`;
const logsUrlForId  = (id) => `index.html?view=logs&return_id=${encodeURIComponent(id)}`;

// Ícones inline
function iconSvg(name) {
  if (name === "Mercado Livre") {
    return `<svg width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#ffea00"/><path d="M7 11c2-2 8-2 10 0" stroke="#0f172a" stroke-width="1.6" fill="none"/></svg>`;
  }
  if (name === "Shopee") {
    return `<svg width="24" height="24" viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="14" rx="2" fill="#ef4444"/><path d="M12 4c-1.5 0-2.5 1-2.8 2H7v2h10V6h-2.2C14.5 5 13.5 4 12 4Z" fill="#fff"/></svg>`;
  }
  if (name === "Magalu") {
    return `<svg width="24" height="24" viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="2" fill="#0ea5e9"/><rect x="5" y="8" width="14" height="2" fill="#22c55e"/><rect x="5" y="12" width="10" height="2" fill="#f59e0b"/></svg>`;
  }
  if (name === "info") {
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
  }
  return `<svg width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="#e5e7eb"/></svg>`;
}

// Toast
function showToast({ title, desc, href }) {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `
    <div class="dot">${iconSvg("info")}</div>
    <div class="text">
      <div class="title">${title}</div>
      <div class="desc">${href ? `<a href="${href}">${desc}</a>` : desc}</div>
    </div>
    <button class="close" aria-label="Fechar">&times;</button>
  `;
  el.querySelector(".close").onclick = () => el.remove();
  TOAST_BOX.appendChild(el);
  setTimeout(() => el.remove(), 5500);
}

// Normaliza nome da loja → marketplace
function lojaToMarketplace(lojaNome = "") {
  const s = lojaNome.toLowerCase();
  if (s.includes("shopee")) return "Shopee";
  if (s.includes("magalu") || s.includes("magazineluiza")) return "Magalu";
  if (s.includes("mercado") || s.includes("ml") || s.includes("meli")) return "Mercado Livre";
  return "Outros";
}

// Fetch com tratamento simples
async function api(url) {
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
  return j;
}

/* =========================
 *  Dados + Renderização
 * ========================= */

// --- Reclamacoes Abertas (dados) = pendente + aprovado ---
async function fetchReclamacoesAbertas() {
  const [pend, aprov] = await Promise.all([
    api("/api/returns?status=pendente&page=1&pageSize=500").catch(() => ({ items: [] })),
    api("/api/returns?status=aprovado&page=1&pageSize=500").catch(() => ({ items: [] })),
  ]);

  const rows = []
    .concat(Array.isArray(pend?.items) ? pend.items : Array.isArray(pend) ? pend : [])
    .concat(Array.isArray(aprov?.items) ? aprov.items : Array.isArray(aprov) ? aprov : []);

  const agg = {};
  for (const r of rows) {
    const mk = lojaToMarketplace(r.loja_nome || "");
    agg[mk] = (agg[mk] || 0) + 1;
  }
  return { rows, agg };
}

function renderReclamacoesAbertas(agg) {
  const cont  = $("#mk-cards");
  const ordem = ["Shopee", "Mercado Livre", "Magalu", "Outros"];
  cont.innerHTML = "";
  ordem.forEach((mk) => {
    const card = document.createElement("div");
    card.className = "mk";
    card.innerHTML = `
      <div class="logo">${iconSvg(mk)}</div>
      <div class="name">${mk}</div>
      <div class="badge">${agg[mk] || 0}</div>
    `;
    cont.appendChild(card);
  });
}

// Toasts para novas reclamações (somente as pendentes)
function handleNewReclamacoes(rows) {
  rows.forEach((r) => {
    const id = String(r.id);
    if (firstRun) { seen.add(id); return; }
    if (!seen.has(id)) {
      seen.add(id);
      showToast({
        title: "Nova reclamação aberta",
        desc: "Clique para abrir",
        href: openUrlForId(id)
      });
    }
  });
}

// --- “Devoluções a caminho” (dados) = status aprovado ---
async function fetchACaminho(limit = 6) {
  const res  = await api("/api/returns?status=aprovado&page=1&pageSize=50").catch(() => null);
  const rows = Array.isArray(res?.items) ? res.items : (Array.isArray(res) ? res : []);
  // ordena por atualizado mais recente; prioriza ML
  rows.sort((a, b) =>
    ((b.loja_nome||'').includes('Mercado') - (a.loja_nome||'').includes('Mercado')) ||
    new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0)
  );
  return rows.slice(0, limit);
}

function renderACaminho(rows) {
  const ul = $("#a-caminho");
  ul.innerHTML = "";
  rows.forEach((r) => {
    const li     = document.createElement("li");
    const pedido = r.id_venda || r.id || "—";
    const quando = r.updated_at || r.created_at || null;
    const dt     = quando ? new Date(quando).toLocaleDateString("pt-BR") : "—";
    li.className = "item";
    li.innerHTML = `
      <span class="pill">${String(r.status || "").replaceAll("_", " ")}</span>
      <span class="id">pacote ${pedido}</span>
      <span class="muted">• ${dt}</span>
      <a href="devolucao-editar.html?id=${encodeURIComponent(r.id)}">abrir</a>
    `;
    ul.appendChild(li);
  });
}

/* ========= Kickstart de import se vazio ========= */

async function kickstartImportIfEmpty() {
  try {
    const res = await api("/api/returns?page=1&pageSize=1").catch(() => null);
    const hasAny = Array.isArray(res?.items) ? res.items.length > 0 : Array.isArray(res) ? res.length > 0 : false;
    if (hasAny) return false;

    // dispara import só de returns (60 dias) e silencioso
    await api("/api/ml/claims/import?source=returns&days=60&silent=1").catch(() => null);
    // dá um respiro rápido pro backend gravar
    await sleep(1500);
    return true;
  } catch {
    return false;
  }
}

/* =========================
 *  Boot + Polling
 * ========================= */

async function boot() {
  const hasLoader = !!window.PageLoader;
  if (hasLoader) window.PageLoader.hold(LOADER_MIN_MS);

  try {
    // Se o BD está vazio, puxamos do ML
    const kicked = await kickstartImportIfEmpty();
    if (kicked) console.info("[central] Import de returns disparado (kickstart).");

    const [abertas, caminho] = await Promise.all([
      fetchReclamacoesAbertas(),
      fetchACaminho(),
      hasLoader ? Promise.resolve() : sleep(LOADER_MIN_MS)
    ]);

    renderReclamacoesAbertas(abertas.agg);
    handleNewReclamacoes(abertas.rows);
    renderACaminho(caminho);
  } catch (e) {
    console.warn("initial load fail:", e?.message || e);
  } finally {
    if (hasLoader) window.PageLoader.done();
  }

  firstRun = false;

  // Polling
  while (true) {
    await sleep(POLL_MS);
    if (!pollingOn) continue;
    try {
      const [ab, cam] = await Promise.all([fetchReclamacoesAbertas(), fetchACaminho()]);
      renderReclamacoesAbertas(ab.agg);
      handleNewReclamacoes(ab.rows);
      renderACaminho(cam);
    } catch (e) {
      console.warn("poll fail", e.message);
    }
  }
}

boot();
