// Sistema de Devoluções - Feed Geral (index.html)
class DevolucoesFeed {
  constructor() {
    // estado
    this.items = [];
    this.filtros = { pesquisa: "", status: "todos" };
    this.RANGE_DIAS = 30;

    // paginação
    this.pageSize = 15;
    this.page = 1;

    // grupos de status internos
    this.STATUS_GRUPOS = {
      aprovado: new Set(["aprovado", "autorizado", "autorizada"]),
      rejeitado: new Set(["rejeitado", "rejeitada", "negado", "negada"]),
      finalizado: new Set([
        "concluido", "concluida",
        "finalizado", "finalizada",
        "fechado", "fechada",
        "encerrado", "encerrada",
      ]),
      pendente: new Set(["pendente", "em_analise", "em-analise", "aberto"]),
    };

    this.inicializar();
  }

  async inicializar() {
    this.configurarUI();
    await this.carregar();
    this.renderizar();
  }

  // ========= Utils =========
  safeJson(res) {
    if (!res.ok) throw new Error("HTTP " + res.status);
    if (res.status === 204) return {};
    return res.json();
  }

  coerceReturnsPayload(j) {
    if (Array.isArray(j)) return j;
    if (!j || typeof j !== "object") return [];
    return j.items || j.data || j.returns || j.list || [];
  }

  formatBRL(n) {
    return Number(n || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  dataBr(iso) {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
    } catch {
      return "—";
    }
  }

  esc(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  getDateMs(d) {
    // tenta vários campos possíveis
    const cands = [
      d.created_at, d.createdAt, d.created,
      d.dt, d.data, d.inserted_at, d.updated_at,
    ].filter(Boolean);
    for (const x of cands) {
      const t = Date.parse(x);
      if (!Number.isNaN(t)) return t;
    }
    // fallback: usa id numérico decrescente se parecer número
    const idn = Number(d.id);
    return Number.isFinite(idn) ? idn : 0;
  }

  // ========= Carregamento =========
  getMockData() {
    return [
      {
        id: "4",
        id_venda: "DEV-2024-004",
        cliente_nome: "Ana Oliveira",
        loja_nome: "Loja Matriz",
        sku: "PROD-004",
        status: "em_analise",
        log_status: "em_preparacao",
        created_at: "2024-01-15T16:45:00Z",
        valor_produto: 599.9,
        valor_frete: 25.0,
      },
      {
        id: "3",
        id_venda: "DEV-2024-003",
        cliente_nome: "Pedro Costa",
        loja_nome: "Loja Online",
        sku: "PROD-003",
        status: "rejeitado",
        log_status: "fechado",
        created_at: "2024-01-14T09:15:00Z",
        valor_produto: 89.9,
        valor_frete: 8.0,
      },
      {
        id: "2",
        id_venda: "DEV-2024-002",
        cliente_nome: "Maria Santos",
        loja_nome: "Loja Shopping",
        sku: "PROD-002",
        status: "aprovado",
        log_status: "pronto_envio",
        created_at: "2024-01-13T14:30:00Z",
        valor_produto: 149.9,
        valor_frete: 12.0,
      },
      {
        id: "1",
        id_venda: "DEV-2024-001",
        cliente_nome: "João Silva",
        loja_nome: "Loja Centro",
        sku: "PROD-001",
        status: "pendente",
        log_status: "em_transporte",
        created_at: "2024-01-12T10:00:00Z",
        valor_produto: 299.9,
        valor_frete: 15.0,
      },
    ];
  }

  async carregar() {
    this.toggleSkeleton(true);
    try {
      const url = `/api/returns?limit=200&range_days=${this.RANGE_DIAS}`;
      const j = await fetch(url, { headers: { Accept: "application/json" } })
        .then((r) => this.safeJson(r))
        .catch(() => null);
      const list = this.coerceReturnsPayload(j);
      this.items = Array.isArray(list) && list.length ? list : this.getMockData();
    } catch (e) {
      console.warn("[index] Falha ao carregar devoluções. Usando mock.", e?.message);
      this.items = this.getMockData();
      this.toast("Aviso", "Não foi possível carregar da API. Exibindo dados de exemplo.", "erro");
    } finally {
      this.toggleSkeleton(false);
    }
  }

  toggleSkeleton(show) {
    const sk = document.getElementById("loading-skeleton");
    const listWrap = document.getElementById("lista-devolucoes");
    const list = document.getElementById("container-devolucoes");
    const vazio = document.getElementById("mensagem-vazia");
    if (sk) sk.hidden = !show;
    if (listWrap) listWrap.setAttribute("aria-busy", show ? "true" : "false");
    if (list) {
      if (show) list.innerHTML = "";
      list.style.display = show ? "none" : "grid";
    }
    if (vazio && !show) vazio.hidden = true;
  }

  // ========= UI =========
  configurarUI() {
    const campo = document.getElementById("campo-pesquisa");
    campo?.addEventListener("input", (e) => {
      this.filtros.pesquisa = String(e.target.value || "").trim();
      this.page = 1; // reset página ao filtrar
      this.renderizar();
    });

    const selectFallback = document.getElementById("filtro-status");
    selectFallback?.addEventListener("change", (e) => {
      const novo = (e.target.value || "todos").toLowerCase();
      this.filtros.status = novo;
      this.page = 1; // reset página ao filtrar
      this.renderizar();
    });

    // Export
    document.getElementById("botao-exportar")?.addEventListener("click", () => this.exportar());

    // Nova Devolução
    document.getElementById("btn-nova-devolucao")?.addEventListener("click", () => {
      this.toast("Info", "Funcionalidade em desenvolvimento", "info");
    });

    // Abrir detalhe
    document.getElementById("container-devolucoes")?.addEventListener("click", (e) => {
      const card = e.target.closest?.("[data-return-id]");
      if (!card) return;
      const id = card.getAttribute("data-return-id");
      if (e.target.closest?.('[data-action="open"]') || e.target.closest?.(".botao-detalhes")) {
        this.abrirDetalhes(id);
      }
    });

    // Paginação (delegação)
    document.getElementById("paginacao")?.addEventListener("click", (e) => {
      const a = e.target.closest("button[data-page]");
      if (!a) return;
      const p = Number(a.getAttribute("data-page"));
      if (!Number.isFinite(p)) return;
      if (p === this.page) return;
      this.page = p;
      this.renderizar();
    });
  }

  // ========= Render =========
  renderizar() {
    const container = document.getElementById("container-devolucoes");
    const vazio = document.getElementById("mensagem-vazia");
    const descVazio = document.getElementById("descricao-vazia");
    const countEl = document.getElementById("lista-count");
    const pag = document.getElementById("paginacao");
    if (!container) return;

    const q = (this.filtros.pesquisa || "").toLowerCase();
    const st = (this.filtros.status || "todos").toLowerCase();

    // filtrar
    const filtrados = (this.items || []).filter((d) => {
      const textoMatch = [d.cliente_nome, d.id_venda, d.sku, d.loja_nome, d.status, d.log_status]
        .map((x) => String(x || "").toLowerCase())
        .some((s) => s.includes(q));
      const statusMatch = st === "todos" || this.grupoStatus(d.status) === st;
      return textoMatch && statusMatch;
    });

    // ordenar por data desc (mais recente primeiro)
    filtrados.sort((a, b) => this.getDateMs(b) - this.getDateMs(a));

    // contagem
    if (countEl) countEl.textContent = String(filtrados.length);

    // vazio
    if (!filtrados.length) {
      container.style.display = "none";
      if (vazio) {
        vazio.hidden = false;
        if (descVazio)
          descVazio.textContent = q || (st !== "todos" ? "Tente ajustar os filtros" : "Ajuste os filtros de pesquisa");
      }
      if (pag) pag.innerHTML = "";
      return;
    }

    // paginação
    const total = filtrados.length;
    const totalPages = Math.max(1, Math.ceil(total / this.pageSize));
    if (this.page > totalPages) this.page = totalPages;
    const start = (this.page - 1) * this.pageSize;
    const end = start + this.pageSize;
    const pageItems = filtrados.slice(start, end);

    // render cards
    container.style.display = "grid";
    if (vazio) vazio.hidden = true;
    container.innerHTML = "";
    pageItems.forEach((d, i) => {
      const card = this.card(d, i);
      card.setAttribute("role", "listitem");
      container.appendChild(card);
    });

    // render paginação
    this.renderPaginacao(totalPages);
  }

  renderPaginacao(totalPages) {
    const nav = document.getElementById("paginacao");
    if (!nav) return;

    if (totalPages <= 1) {
      nav.innerHTML = "";
      return;
    }

    const cur = this.page;
    const btn = (p, label = p, disabled = false, active = false) => `
      <button
        class="page-btn${active ? " is-active" : ""}"
        data-page="${p}"
        ${disabled ? "disabled aria-disabled='true'" : ""}
        aria-label="Página ${p}"
      >${label}</button>`;

    // range compacto
    const windowSize = 5;
    let start = Math.max(1, cur - Math.floor(windowSize / 2));
    let end = start + windowSize - 1;
    if (end > totalPages) {
      end = totalPages;
      start = Math.max(1, end - windowSize + 1);
    }

    let html = "";
    html += btn(Math.max(1, cur - 1), "‹", cur === 1, false);
    if (start > 1) {
      html += btn(1, "1", false, cur === 1);
      if (start > 2) html += `<span class="page-ellipsis" aria-hidden="true">…</span>`;
    }
    for (let p = start; p <= end; p++) {
      html += btn(p, String(p), false, p === cur);
    }
    if (end < totalPages) {
      if (end < totalPages - 1) html += `<span class="page-ellipsis" aria-hidden="true">…</span>`;
      html += btn(totalPages, String(totalPages), false, cur === totalPages);
    }
    html += btn(Math.min(totalPages, cur + 1), "›", cur === totalPages, false);

    nav.innerHTML = html;
  }

  // ========= Card =========
  card(d, index = 0) {
    const el = document.createElement("div");
    el.className = "card-devolucao slide-up";
    el.style.animationDelay = `${index * 0.08}s`;
    el.setAttribute("data-return-id", String(d.id));

    const data = this.dataBr(d.created_at);
    const valorProduto = Number(d.valor_produto || 0);
    const valorFrete = Number(d.valor_frete || 0);

    el.innerHTML = `
      <div class="devolucao-header">
        <div class="devolucao-titulo-area">
          <h3 class="devolucao-titulo">
            <svg class="icone" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M8 1a2.5 2.5 0 0 1 2.5 2.5V4h-5v-.5A2.5 2.5 0 0 1 8 1zm3.5 3v-.5a3.5 3.5 0 1 0-7 0V4H1v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V4h-3.5z"/>
            </svg>
            #${this.esc(d.id_venda || "-")}
          </h3>
          <p class="devolucao-subtitulo">${this.esc(d.cliente_nome || "—")}</p>
        </div>
        <div class="devolucao-acoes">
          ${this.badgeFluxo(d)}
          ${this.badgeStatus(d)}
        </div>
      </div>

      <div class="devolucao-conteudo">
        <div class="campo-info">
          <svg class="icone" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M0 1.5A.5.5 0 0 1 .5 1H2a.5.5 0 0 1 .485.379L2.89 3H14.5a.5.5 0 0 1 .491.592l-1.5 8A.5.5 0 0 1 13 12H4a.5.5 0 0 1-.491-.408L2.01 3.607 1.61 2H.5a.5.5 0 0 1-.5-.5z"/>
          </svg>
          <span class="campo-label">Loja</span>
          <span class="campo-valor">${this.esc(d.loja_nome || "—")}</span>
        </div>

        <div class="campo-info">
          <svg class="icone" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M3.5 0a.5.5 0 0 1 .5.5V1h8V.5a.5.5 0 0 1 1 0V1h1a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2h1V.5a.5.5 0 0 1 .5-.5z"/>
          </svg>
          <span class="campo-label">Data</span>
          <span class="campo-valor">${data}</span>
        </div>

        <div class="campo-info">
          <svg class="icone" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 1a2.5 2.5 0 0 1 2.5 2.5V4h-5v-.5A2.5 2.5 0 0 1 8 1zm3.5 3v-.5a3.5 3.5 0 1 0-7 0V4H1v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V4h-3.5z"/>
          </svg>
          <span class="campo-label">Produto</span>
          <span class="campo-valor valor-destaque">${this.formatBRL(valorProduto)}</span>
        </div>

        <div class="campo-info">
          <svg class="icone" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M0 3.5A1.5 1.5 0 0 1 1.5 2h9A1.5 1.5 0 0 1 12 3.5V5h1.02a1.5 1.5 0 0 1 1.17.563l1.481 1.85a1.5 1.5 0 0 1 .329.938V10.5a1.5 1.5 0 0 1-1.5 1.5H14a2 2 0 1 1-4 0H5a2 2 0 1 1-3.998-.085A1.5 1.5 0 0 1 0 10.5v-7z"/>
          </svg>
          <span class="campo-label">Frete</span>
          <span class="campo-valor valor-destaque">${this.formatBRL(valorFrete)}</span>
        </div>
      </div>

      <div class="devolucao-footer">
        <a href="../devolucao-editar.html?id=${encodeURIComponent(d.id)}" class="link-sem-estilo" target="_blank" rel="noopener">
          <button class="botao botao-outline botao-detalhes" data-action="open">
            <svg class="icone" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M16 8s-3-5.5-8-5.5S0 8 0 8s3 5.5 8 5.5S16 8 16 8zM1.173 8a13.133 13.133 0 0 1 1.66-2.043C4.12 4.668 5.88 3.5 8 3.5c2.12 0 3.879 1.168 5.168 2.457A13.133 13.133 0 0 1 14.828 8c-.58.87-3.828 5-6.828 5S2.58 8.87 1.173 8z"/>
              <path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/>
            </svg>
            Ver Detalhes
          </button>
        </a>
      </div>
    `;
    return el;
  }

  // ========= Badges =========
  badgeStatus(d) {
    const grp = this.grupoStatus(d.status);
    const map = {
      pendente: '<div class="badge badge-pendente" title="Status interno">Pendente</div>',
      aprovado: '<div class="badge badge-aprovado" title="Status interno">Aprovado</div>',
      rejeitado: '<div class="badge badge-rejeitado" title="Status interno">Rejeitado</div>',
      em_analise: '<div class="badge badge-info" title="Status interno">Em Análise</div>',
      finalizado: '<div class="badge badge-aprovado" title="Status interno">Finalizado</div>',
    };
    return map[grp] || `<div class="badge" title="Status interno">${this.esc(d.status || "—")}</div>`;
  }

  badgeFluxo(d) {
    // tenta ler de vários campos: log_status (preferido), claim_status, shipping_status
    const s =
      String(d.log_status ?? d.claim_status ?? d.shipping_status ?? "").toLowerCase().trim();

    const flow = this.normalizeFlow(s);
    const labels = {
      disputa: "Em Disputa",
      mediacao: "Mediação",
      em_preparacao: "Em Preparação",
      pronto_envio: "Pronto p/ Envio",
      em_transporte: "Em Transporte",
      recebido_cd: "Recebido no CD",
      fechado: "Fechado",
      pendente: "Fluxo Pendente",
    };

    const css = {
      disputa: "badge-info",
      mediacao: "badge-info",
      em_preparacao: "badge-pendente",
      pronto_envio: "badge-aprovado",
      em_transporte: "badge-info",
      recebido_cd: "badge-aprovado",
      fechado: "badge-rejeitado",
      pendente: "badge",
    };

    const key = flow || "pendente";
    const txt = labels[key] || "Fluxo";
    const klass = css[key] || "badge";

    return `<div class="badge ${klass}" title="Fluxo da devolução">${txt}</div>`;
  }

  normalizeFlow(s) {
    const t = s.replace(/\s+/g, "_");
    if (!t) return "pendente";

    // disputa / mediação
    if (/(disputa|dispute)/.test(t)) return "disputa";
    if (/(media[cç]ao|mediation)/.test(t)) return "mediacao";

    // fluxo logístico
    if (/(prepar|prep)/.test(t)) return "em_preparacao";
    if (/(pronto|label|etiq|ready)/.test(t)) return "pronto_envio";
    if (/(transit|transporte|enviado|shipped)/.test(t)) return "em_transporte";
    if (/(delivered|entreg|arrived|recebid)/.test(t)) return "recebido_cd";

    // encerrado
    if (/(fechad|closed)/.test(t)) return "fechado";

    return "pendente";
  }

  grupoStatus(st) {
    const s = String(st || "").toLowerCase();
    for (const [grupo, set] of Object.entries(this.STATUS_GRUPOS)) {
      if (set.has(s)) return grupo;
    }
    if (s === "em_analise" || s === "em-analise") return "em_analise";
    return "pendente";
  }

  // ========= Ações =========
  abrirDetalhes(id) {
    const modal = document.getElementById("modal-detalhe");
    if (modal && modal.showModal) {
      modal.showModal();
    } else {
      this.toast("Info", `Abrindo detalhes da devolução #${id}`, "info");
      // location.href = `devolucao-editar.html?id=${encodeURIComponent(id)}`;
    }
  }

  exportar() {
    const cols = ["id", "id_venda", "cliente_nome", "loja_nome", "sku", "status", "log_status", "valor_produto", "valor_frete", "created_at"];
    const linhas = [cols.join(",")].concat(
      this.items.map((d) => cols.map((c) => `"${String(d[c] ?? "").replace(/"/g, '""')}"`).join(",")),
    );
    const blob = new Blob([linhas.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "devolucoes.csv";
    a.click();
    URL.revokeObjectURL(url);
    this.toast("Sucesso", "Relatório exportado.", "sucesso");
  }

  toast(titulo, descricao, tipo = "info") {
    const toast = document.getElementById("toast");
    const tituloEl = document.getElementById("toast-titulo");
    const descEl = document.getElementById("toast-descricao");
    if (!toast || !tituloEl || !descEl) return;
    tituloEl.textContent = titulo;
    descEl.textContent = descricao;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 3000);
  }
}

// Boot
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => new DevolucoesFeed());
} else {
  new DevolucoesFeed();
}
