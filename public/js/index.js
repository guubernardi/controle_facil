// /public/js/index.js
class DevolucoesFeed {
  constructor() {
    this.items   = [];
    this.filtros = { pesquisa: "", status: "todos" };
    this.RANGE_DIAS = 30;
    this.pageSize   = 15;
    this.page       = 1;

    // Cache e Controle
    this.NEW_KEY_PREFIX = "rf:firstSeen:";
    this.SYNC_MS        = 5 * 60 * 1000; // 5 minutos
    this.syncInProgress = false;

    // Dados do Seller (Headers / meta, se vc quiser usar depois)
    this.sellerId   = document.querySelector('meta[name="ml-seller-id"]')?.content?.trim() || '';
    this.sellerNick = document.querySelector('meta[name="ml-seller-nick"]')?.content?.trim() || '';

    // Grupos de Status (para as abas)
    this.STATUS_GRUPOS = {
      pendente:   new Set(["pendente", "aberto", "revisar"]),
      em_analise: new Set(["em_analise", "em-analise", "conferencia", "chegou"]),
      disputa:    new Set(["disputa", "mediacao", "reclamacao"]),
      finalizado: new Set(["concluido", "concluida", "finalizado", "encerrado", "aprovado", "rejeitado"])
    };

    this.inicializar();
  }

  async inicializar() {
    this.configurarUI();
    this.exposeGlobalReload();

    // Permite que outras telas/JS forcem o reload da lista
    document.addEventListener('rf:returns:reload', async () => {
      await this.carregar();
      this.renderizar();
    });

    // Carregamento inicial
    await this.carregar();
    this.renderizar();

    // Auto-sync silencioso (de tempos em tempos)
    this.startAutoSync();
  }

  // ===== Configuração da Interface =====
  configurarUI() {
    // 1. Busca (com debounce para não travar)
    const inputBusca = document.getElementById("campo-pesquisa");
    if (inputBusca) {
      let timeout;
      inputBusca.addEventListener("input", (e) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          this.filtros.pesquisa = (e.target.value || "").trim();
          this.page = 1;
          this.renderizar();
        }, 300);
      });
    }

    // 2. Abas de Filtro
    const listaAbas = document.getElementById("lista-abas-status");
    if (listaAbas) {
      listaAbas.addEventListener("click", (e) => {
        const btn = e.target.closest(".aba");
        if (!btn) return;
        
        // Remove ativo dos outros
        listaAbas.querySelectorAll(".aba").forEach(b => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        
        this.filtros.status = btn.dataset.status || "todos";
        this.page = 1;
        this.renderizar();
      });
    }

    // 3. Paginação
    const paginacao = document.getElementById("paginacao");
    if (paginacao) {
      paginacao.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-page]");
        if (btn && !btn.disabled) {
          this.page = Number(btn.dataset.page);
          this.renderizar();
          // Scroll suave pro topo da lista
          document.getElementById("filtros")?.scrollIntoView({ behavior: "smooth" });
        }
      });
    }

    // 4. Botão Exportar
    document.getElementById("botao-exportar")?.addEventListener("click", () => this.exportar());

    // 5. Botão Nova Devolução → vai pra tela de edição/criação
    const btnNova = document.getElementById("btn-nova-devolucao");
    if (btnNova) {
      btnNova.addEventListener("click", () => {
        window.location.href = "devolucao-editar.html";
      });
    }

    // 6. Botão Sincronizar devoluções
    const btnSync = document.getElementById("botao-sync");
    if (btnSync) {
      btnSync.addEventListener("click", () => this.sincronizar());
    }
  }

  // ===== Dados e API =====
  async carregar() {
    this.toggleSkeleton(true);
    try {
      const url = `/api/returns?limit=300&range_days=${this.RANGE_DIAS}`;
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error("Erro ao buscar dados");

      const json = await res.json();
      // Normaliza a resposta (pode vir num objeto .items ou direto array)
      this.items = Array.isArray(json) ? json : (json.items || []);

      this.atualizarContadores();
    } catch (e) {
      console.error("Falha no carregamento:", e);
      this.toast("Erro", "Não foi possível carregar as devoluções.", "error");
    } finally {
      this.toggleSkeleton(false);
    }
  }

  atualizarContadores() {
    const counts = { todos: 0, pendente: 0, em_analise: 0, disputa: 0, finalizado: 0 };
    
    this.items.forEach(d => {
      counts.todos++;
      const grupo = this.identificarGrupo(d.status);
      if (counts[grupo] !== undefined) counts[grupo]++;
    });

    // IDs no HTML:
    // count-todos, count-pendente, count-analise, count-disputa, count-finalizado
    const mapaIds = {
      todos:      "count-todos",
      pendente:   "count-pendente",
      em_analise: "count-analise",
      disputa:    "count-disputa",
      finalizado: "count-finalizado"
    };

    Object.entries(mapaIds).forEach(([grupo, id]) => {
      const el = document.getElementById(id);
      if (el) el.textContent = counts[grupo] > 0 ? counts[grupo] : "";
    });
  }

  identificarGrupo(status) {
    const s = String(status || "").toLowerCase();
    for (const [grupo, set] of Object.entries(this.STATUS_GRUPOS)) {
      if (set.has(s)) return grupo;
    }
    return "pendente"; // Fallback
  }

  // ===== Renderização =====
  renderizar() {
    const container = document.getElementById("container-devolucoes");
    if (!container) return;

    const termo        = this.filtros.pesquisa.toLowerCase();
    const statusFiltro = this.filtros.status;

    // Filtragem client-side
    const filtrados = this.items.filter(d => {
      // Filtro de texto
      const matchTexto = [
        d.id_venda,
        d.cliente_nome,
        d.sku,
        d.loja_nome,
        d.status,
        d.ml_return_status
      ].some(val => String(val || "").toLowerCase().includes(termo));

      if (!matchTexto) return false;

      // Filtro de Status (abas)
      if (statusFiltro === "todos") return true;
      return this.identificarGrupo(d.status) === statusFiltro;
    });

    // Paginação client-side
    const total      = filtrados.length;
    const totalPages = Math.ceil(total / this.pageSize) || 1;
    if (this.page > totalPages) this.page = totalPages;
    
    const inicio    = (this.page - 1) * this.pageSize;
    const fim       = inicio + this.pageSize;
    const pageItems = filtrados.slice(inicio, fim);

    container.innerHTML = "";

    if (pageItems.length === 0) {
      const msgVazia = document.getElementById("mensagem-vazia");
      if (msgVazia) msgVazia.hidden = false;
      const pag = document.getElementById("paginacao");
      if (pag) pag.innerHTML = "";
      return;
    }

    const msgVazia = document.getElementById("mensagem-vazia");
    if (msgVazia) msgVazia.hidden = true;

    pageItems.forEach(d => {
      container.appendChild(this.criarCard(d));
    });

    this.renderizarPaginacao(totalPages);
  }

  // ===== Criação do Card =====
  criarCard(d) {
    const el = document.createElement("div");
    el.className = "card-devolucao";
    
    // Dados formatados
    const dataFmt  = d.created_at ? new Date(d.created_at).toLocaleDateString("pt-BR") : "—";
    const valorFmt = Number(d.valor_produto || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
    const freteFmt = Number(d.valor_frete   || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
    const fotoUrl  = d.foto_produto || "assets/img/box.png"; // Placeholder
    
    // Status
    const statusML   = this.traduzirStatusML(d.ml_return_status);
    const statusClass = this.getClassStatusML(d.ml_return_status);

    const sInterno    = String(d.status || "").toLowerCase();
    const podeReceber = (d.log_status === "recebido_cd" || d.ml_return_status === "delivered");
    const jaFinalizado = ["aprovado", "rejeitado", "concluida", "concluido", "finalizado"]
      .includes(sInterno);

    let btnAction = "";
    if (podeReceber && !jaFinalizado) {
      btnAction = `<button class="botao botao-sm botao-principal" data-open-receive data-id="${d.id}">📥 Receber</button>`;
    }

    el.innerHTML = `
      <div class="devolucao-header">
        <span class="badge-id" title="ID do Pedido">#${d.id_venda || d.id}</span>
        <span class="data-br">${dataFmt}</span>
      </div>

      <div class="devolucao-body">
        <div class="prod-thumb">
          <img src="${fotoUrl}" alt="Produto" loading="lazy" onerror="this.src='assets/img/box.png'">
        </div>

        <div class="info-texto">
          <div class="produto-titulo" title="${d.sku || "Produto sem nome"}">
            ${d.sku || "Produto não identificado"}
          </div>
          
          <div class="motivo-linha text-muted">
            ${d.loja_nome || "Loja não inf."}
          </div>

          <div class="valores-grid">
            <span>Prod: <b>${valorFmt}</b></span>
            <span>Frete: <b>${freteFmt}</b></span>
          </div>
        </div>
      </div>

      <div class="devolucao-footer">
        <div style="display:flex; gap:8px; align-items:center;">
          <span class="badge ${statusClass}">${statusML}</span>
          ${this.getBadgeInterno(d.status)}
        </div>
        
        <div class="devolucao-cta">
          ${btnAction}
          <a href="devolucao-editar.html?id=${d.id}" class="botao botao-sm botao-outline">Ver</a>
        </div>
      </div>
    `;

    return el;
  }

  // ===== Helpers Visuais =====
  traduzirStatusML(st) {
    const map = {
      pending:   "Pendente",
      shipped:   "Em trânsito",
      delivered: "Entregue no CD",
      cancelled: "Cancelado",
      closed:    "Encerrado",
      expired:   "Expirado"
    };
    return map[st] || st || "—";
  }

  getClassStatusML(st) {
    if (st === "delivered") return "badge-status-aprovado";
    if (st === "shipped")   return "badge-status-neutro";
    if (st === "cancelled") return "badge-status-rejeitado";
    return "badge-status-pendente";
  }

  getBadgeInterno(st) {
    const s = String(st || "").toLowerCase();
    if (["aprovado", "concluida", "concluido", "finalizado"].includes(s)) {
      return '<span class="badge badge-status-aprovado">Concluído</span>';
    }
    if (["rejeitado", "disputa", "mediacao", "reclamacao"].includes(s)) {
      return '<span class="badge badge-status-rejeitado">Disputa</span>';
    }
    return "";
  }

  renderizarPaginacao(total) {
    const nav = document.getElementById("paginacao");
    if (!nav) return;
    if (total <= 1) { nav.innerHTML = ""; return; }
    
    let html = "";
    if (this.page > 1) {
      html += `<button class="page-btn" data-page="${this.page - 1}">‹</button>`;
    }
    html += `<span style="font-size:0.9rem; padding:0 1rem;">Pág <b>${this.page}</b> de ${total}</span>`;
    if (this.page < total) {
      html += `<button class="page-btn" data-page="${this.page + 1}">›</button>`;
    }
    nav.innerHTML = html;
  }

  toggleSkeleton(show) {
    const skel = document.getElementById("loading-skeleton");
    const list = document.getElementById("lista-devolucoes");
    if (skel) skel.hidden = !show;
    if (list) list.style.display = show ? "none" : "block";
  }

  toast(titulo, msg, tipo = "info") {
    const t = document.getElementById("toast");
    if (!t) return;
    const titleEl = document.getElementById("toast-titulo") || t.querySelector("strong");
    const descEl  = document.getElementById("toast-descricao") || t.querySelector(".toast-content div");
    if (titleEl) titleEl.textContent = titulo;
    if (descEl)  descEl.textContent  = msg;
    t.className = `toast show ${tipo}`;
    setTimeout(() => t.classList.remove("show"), 3000);
  }

  // ===== Helpers globais / Sync =====
  exposeGlobalReload() {
    window.rfReloadReturnsList = async () => {
      await this.carregar();
      this.renderizar();
    };
  }
  
  startAutoSync() {
    setInterval(async () => {
      await this.carregar();
      this.renderizar();
    }, this.SYNC_MS);
  }

  async sincronizar() {
    if (this.syncInProgress) return;
    this.syncInProgress = true;

    const btn = document.getElementById("botao-sync");
    if (btn) {
      btn.disabled = true;
      btn.dataset.labelOriginal = btn.textContent;
      btn.textContent = "Sincronizando...";
    }

    try {
      const url = `/api/returns/sync?days=${this.RANGE_DIAS}&silent=1`;
      const res = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" }
      });

      if (!res.ok) throw new Error("Falha ao iniciar sincronização");

      // Depois que o backend rodar o import, recarrega a lista
      await this.carregar();
      this.renderizar();
      this.toast("Sincronização", "Devoluções atualizadas com sucesso.", "success");
    } catch (e) {
      console.error("Erro na sincronização", e);
      this.toast("Erro", "Não foi possível sincronizar as devoluções.", "error");
    } finally {
      this.syncInProgress = false;
      if (btn) {
        btn.disabled   = false;
        btn.textContent = btn.dataset.labelOriginal || "Sincronizar";
      }
    }
  }
  
  exportar() {
    if (!this.items.length) {
      return this.toast("Atenção", "Nada para exportar.", "warning");
    }
    const header = ["ID", "Pedido", "Cliente", "Status", "Valor"];
    const linhas = this.items.map(e => [
      e.id,
      e.id_venda,
      (e.cliente_nome || "").replace(/,/g, " "),
      e.status,
      e.valor_produto
    ].join(","));

    const csvContent = "data:text/csv;charset=utf-8," +
      header.join(",") + "\n" +
      linhas.join("\n");

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "devolucoes.csv");
    document.body.appendChild(link);
    link.click();
    link.remove();
  }
}

// Inicialização
document.addEventListener("DOMContentLoaded", () => {
  window.FeedDevolucoes = new DevolucoesFeed();
});
