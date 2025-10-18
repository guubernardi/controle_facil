// Central de Monitoramento
// -------------------------------------------------------------
// - Cards por marketplace (reclamações pendentes)
// - Lista "Devoluções a caminho"
// - Toast quando surgir uma NOVA reclamação (evita spam no 1º load)
// - Polling leve + pausa quando a aba estiver oculta
// -------------------------------------------------------------

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TOAST_BOX = $("#toastContainer");
const POLL_MS = 30000; // 30s

// IDs já vistos para não repetir toast
const seen = new Set();

// Evitar toasts no primeiro carregamento
let firstRun = true;

// Pausa o polling quando a aba não está visível
let pollingOn = true;
document.addEventListener("visibilitychange", () => {
  pollingOn = document.visibilityState === "visible";
});

// Helpers de URL (sempre relativizando para a raiz atual)
const openUrlForId = (id) => `index.html?return_id=${encodeURIComponent(id)}`;
const logsUrlForId = (id) => `index.html?view=logs&return_id=${encodeURIComponent(id)}`;

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

// Reclamações pendentes (cards por marketplace)
async function carregarReclamacoesAbertas() {
  const res  = await api("/api/returns?status=pendente&page=1&pageSize=500");
  const rows = Array.isArray(res?.items) ? res.items : (Array.isArray(res) ? res : []);

  // Agrupa por marketplace
  const agg = {};
  for (const r of rows) {
    const mk = lojaToMarketplace(r.loja_nome || "");
    agg[mk] = (agg[mk] || 0) + 1;
  }

  // Render
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

  // Toasts para IDs novos (após 1º load)
  rows.forEach((r) => {
    const id = String(r.id);
    if (firstRun) {
      seen.add(id); // semear para não “spammar” no 1º load
      return;
    }
    if (!seen.has(id)) {
      seen.add(id);
      showToast({
        title: "Nova reclamação aberta",
        desc: "Clique para abrir",
        href: openUrlForId(id) // abre index.html e o modal
      });
    }
  });
}

// “Devoluções a caminho” (recebido_cd → em_inspecao → pendente)
async function carregarACaminho() {
  let res  = await api("/api/returns?status=recebido_cd&page=1&pageSize=20").catch(() => null);
  let rows = Array.isArray(res?.items) ? res.items : [];

  if (!rows.length) {
    res  = await api("/api/returns?status=em_inspecao&page=1&pageSize=20").catch(() => null);
    rows = Array.isArray(res?.items) ? res.items : [];
  }
  if (!rows.length) {
    res  = await api("/api/returns?status=pendente&page=1&pageSize=20").catch(() => null);
    rows = Array.isArray(res?.items) ? res.items : [];
  }

  const ul = $("#a-caminho");
  ul.innerHTML = "";

  rows.slice(0, 6).forEach((r) => {
    const li     = document.createElement("li");
    const pedido = r.id_venda || r.id || "—";
    const quando = r.updated_at || r.created_at || null;
    const dt     = quando ? new Date(quando).toLocaleDateString("pt-BR") : "—";

    const stRaw = String(r.status || "").replaceAll("_", " ");
    const statusTxt = stRaw ? stRaw.charAt(0).toUpperCase() + stRaw.slice(1) : "—";

    li.className = "item";
    // onde monta o "abrir"
    li.innerHTML = `
      <span class="pill">${(r.status || "").replaceAll("_", " ")}</span>
      <span class="id">pacote ${pedido}</span>
      <span class="muted">• ${dt}</span>
      <a href="devolucao-editar.html?id=${encodeURIComponent(r.id)}">abrir</a>
    `;
    ul.appendChild(li);
  });
}

// Boot: carrega dados e inicia o polling
async function boot() {
  await Promise.all([carregarReclamacoesAbertas(), carregarACaminho()]);
  firstRun = false; // a partir daqui, novos IDs disparam toast

  // Loop de polling leve
  while (true) {
    await sleep(POLL_MS);
    if (!pollingOn) continue; // pausa quando a aba não está visível
    try {
      await carregarReclamacoesAbertas();
      await carregarACaminho();
    } catch (e) {
      console.warn("poll fail", e.message);
    }
  }
}
boot();
