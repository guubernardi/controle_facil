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

    document.addEventListener('rf:returns:reload', async () => {
      await this.carregar();
      this.renderizar();
    });

    await this.carregar();
    this.renderizar();

    this.startAutoSync();
  }

  // ===== Configuração da Interface =====
  configurarUI() {
    // 1. Busca (com debounce)
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
          document.getElementById("filtros")?.scrollIntoView({ behavior: "smooth" });
        }
      });
    }

    // 4. Botão Exportar
    document.getElementById("botao-exportar")?.addEventListener("click", () => this.exportar());

    // 5. Nova Devolução
    const btnNova = document.getElementById("btn-nova-devolucao");
    if (btnNova) {
      btnNova.addEventListener("click", () => {
        window.location.href = "devolucao-editar.html";
      });
    }

    // 6. Sincronizar
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
      this.items = Array.isArray(json) ? json : (json.items || []);

      // mais recentes primeiro, independente do backend
      this.items.sort((a, b) => {
        const da = new Date(
          a.created_at ||
          a.updated_at ||
          a.cd_recebido_em ||
          a.data_compra ||
          a.order_date ||
          0
        ).getTime();
        const db = new Date(
          b.created_at ||
          b.updated_at ||
          b.cd_recebido_em ||
          b.data_compra ||
          b.order_date ||
          0
        ).getTime();
        return db - da;
      });

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
      const grupo = this.identificarGrupo(d);
      if (counts[grupo] !== undefined) counts[grupo]++;
    });

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

  // ===== Claim / Mediação ML =====
  isEmMediacaoML(row) {
    if (!row || typeof row !== 'object') return false;

    const stage  = String(row.ml_claim_stage  || row.claim_stage  || row.ml_claim_stage_name || "").toLowerCase();
    const status = String(row.ml_claim_status || row.claim_status || "").toLowerCase();
    const type   = String(row.ml_claim_type   || row.claim_type   || "").toLowerCase();

    // campos de triagem (reviews de /v2/claims/$CLAIM_ID/returns), se o backend mandar
    const triageStage  = String(row.ml_triage_stage  || row.triage_stage  || "").toLowerCase();
    const triageStatus = String(row.ml_triage_status || row.triage_status || "").toLowerCase();

    // stage/status "dispute" ou "mediation"
    if (stage.includes("dispute") || stage.includes("mediation")) return true;
    if (status.includes("mediation") || status.includes("dispute")) return true;
    if (type === "meditations") return true;

    // triage pendente = tratamos como em mediação
    if (["seller_review_pending", "pending"].includes(triageStage)) return true;

    // triage com status explícito de falha também é um caso de conflito ativo
    if (triageStatus === "failed" && triageStage !== "closed") return true;

    return false;
  }

  identificarGrupo(statusOrRow) {
    let row = null;
    let s   = "";

    if (statusOrRow && typeof statusOrRow === "object") {
      row = statusOrRow;
      s   = String(row.status || "").toLowerCase();
    } else {
      s = String(statusOrRow || "").toLowerCase();
    }

    // prioridade: se a claim está em mediação/disputa no ML,
    // força a devolução pra aba "disputa"
    if (row && this.isEmMediacaoML(row)) {
      return "disputa";
    }

    for (const [grupo, set] of Object.entries(this.STATUS_GRUPOS)) {
      if (set.has(s)) return grupo;
    }
    return "pendente"; // Fallback
  }

  // ===== Helpers de data =====
  formatarDataBR(v) {
    if (!v) return "—";

    if (v instanceof Date) {
      return v.toLocaleDateString("pt-BR");
    }

    const s = String(v);

    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      return `${m[3]}/${m[2]}/${m[1]}`;
    }

    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString("pt-BR");
    }

    return s;
  }

  // devolução "nova" se caiu nas últimas 4h
  isNovaDevolucao(d) {
    const LIMITE_MS = 4 * 60 * 60 * 1000; // 4 horas
    const fonte =
      d.created_at ||
      d.updated_at ||
      d.cd_recebido_em ||
      d.data_compra ||
      d.order_date;

    if (!fonte) return false;

    const dt = new Date(fonte);
    if (Number.isNaN(dt.getTime())) return false;

    const diff = Date.now() - dt.getTime();
    return diff >= 0 && diff <= LIMITE_MS;
  }

  // ===== Helpers de valor =====
  /**
   * Converte string "dinheiro" em número (reais). Não formata nada.
   * - Aceita "R$ 69,34", "69,34", "69.34", "6.934" (milhar) etc.
   */
  toNumber(raw) {
    if (raw === null || raw === undefined || raw === "") return 0;
    if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;

    let s = String(raw).trim();

    // Caso especial: string com ponto e sem vírgula, ex: "6.934"
    // Isso costuma ser milhar (6934) mas, no nosso contexto,
    // frequentemente é "69,34" mal serializado. Guardamos o original pra heurística.
    const onlyDotsNoComma = (s.includes(".") && !s.includes(","));

    // remove símbolos (R$, espaços, etc.)
    s = s.replace(/[^\d.,-]/g, "");

    // se tem vírgula, tratamos a vírgula como decimal
    if (s.includes(",")) {
      const [intPart, decPartRaw = "0"] = s.split(",");
      const intClean = intPart.replace(/\./g, "");
      const decPart  = decPartRaw.padEnd(2, "0").slice(0, 2);
      const n = Number(intClean + "." + decPart);
      if (!Number.isFinite(n)) return 0;

      // ex: "6.934,00" vira 6934.00. Se isso ocorrer, corrija dividindo por 100.
      // Heurística: número inteiro grande com 0 centavos → centavos disfarçados.
      if (n >= 1000 && Math.abs(n - Math.round(n)) < 1e-6) {
        return Math.round((n / 100) * 100) / 100;
      }
      return n;
    }

    // Não tem vírgula. Remove pontos de milhar e tenta converter.
    const n = Number(s.replace(/\./g, ""));
    if (!Number.isFinite(n)) return 0;

    // Se a string original tinha apenas ponto (provável "69,34" mal serializado: "6.934")
    // ou se o número parece estar em centavos (>= 1000) → divide por 100.
    if (onlyDotsNoComma || n >= 1000) {
      return Math.round((n / 100) * 100) / 100;
    }
    return n;
  }

  /**
   * Normaliza possíveis valores em centavos (inteiros grandes) para reais.
   * Ex.: 6934 → 69.34. Mantém números já plausíveis.
   * Se receber também o "raw" original, decide melhor quando dividir por 100.
   */
  normalizeMoney(n, raw = null) {
    if (!Number.isFinite(n) || n <= 0) return 0;

    // Já parece plausível (até 999,99) ou tem casas decimais reais
    if (n < 1000 && Math.abs(n - Math.round(n * 100) / 100) > 1e-9) {
      return Math.round(n * 100) / 100;
    }

    const rawStr = raw == null ? "" : String(raw);
    const onlyDotsNoComma = rawStr.includes(".") && !rawStr.includes(",");

    // Heurística:
    // - números inteiros grandes (>= 1000) tendem a estar em centavos
    // - strings tipo "6.934" (só ponto) normalmente significam "69,34"
    if (Number.isInteger(n) && (n >= 1000 || onlyDotsNoComma)) {
      return Math.round((n / 100) * 100) / 100;
    }

    // Se tem decimais mas é absurdo (ex.: 23919.00), também divide
    if (n >= 1000) {
      return Math.round((n / 100) * 100) / 100;
    }

    return Math.round(n * 100) / 100;
  }

  // Pega o primeiro candidato válido e normaliza.
  pickMoney(candidatos) {
    for (const raw of candidatos) {
      let n;
      if (typeof raw === "number") n = raw;
      else n = this.toNumber(raw);

      if (n > 0) return this.normalizeMoney(n, raw);
    }
    return 0;
  }

  // ===== Helpers de valores (Produto / Frete) =====
  getValorProduto(d) {
    // tenta campos em reais, em centavos e “derivados” legados
    const candidatos = [
      d.valor_produto,           // preferido
      d.valor_produto_ml,
      d.valor_produto_cents,     // se existir, vem em centavos
      d.valor_item,
      d.item_price,
      d.ml_item_price,
      d.total_produto,
      d.total_produtos
    ];
    return this.pickMoney(candidatos);
  }

  getValorFrete(d) {
    const candidatos = [
      d.valor_frete,
      d.valor_frete_cents,       // se existir, em centavos
      d.frete,
      d.ml_valor_frete,
      d.ml_shipping_cost,
      d.shipping_cost,
      d.valor_envio
    ];
    return this.pickMoney(candidatos);
  }

  // ===== Renderização =====
  renderizar() {
    const container = document.getElementById("container-devolucoes");
    if (!container) return;

    const termo        = this.filtros.pesquisa.toLowerCase();
    const statusFiltro = this.filtros.status;

    const filtrados = this.items.filter(d => {
      const matchTexto = [
        d.id_venda,
        d.cliente_nome,
        d.sku,
        d.loja_nome,
        d.status,
        d.ml_return_status
      ].some(val => String(val || "").toLowerCase().includes(termo));

      if (!matchTexto) return false;

      if (statusFiltro === "todos") return true;
      return this.identificarGrupo(d) === statusFiltro;
    });

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
    
    const dataFonte =
      d.created_at ||
      d.updated_at ||
      d.cd_recebido_em ||
      d.data_compra ||
      d.order_date;

    const dataFmt  = this.formatarDataBR(dataFonte);
    const isNova   = this.isNovaDevolucao(d);

    const valorProduto = this.getValorProduto(d);
    const valorFrete   = this.getValorFrete(d);

    const valorFmt = valorProduto.toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL"
    });
    const freteFmt = valorFrete.toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL"
    });

    const fotoUrl  = d.foto_produto || "assets/img/box.jpg";
    
    // Status da devolução no ML (case-insensitive)
    const rawStatusML = String(d.ml_return_status || "").toLowerCase();
    const statusML    = this.traduzirStatusML(rawStatusML);
    const statusClass = this.getClassStatusML(rawStatusML);

    const sInterno     = String(d.status || "").toLowerCase();
    const podeReceber  = (rawStatusML === "delivered" && d.log_status !== "recebido_cd");
    const jaFinalizado = ["aprovado", "rejeitado", "concluida", "concluido", "finalizado"]
      .includes(sInterno);

    let btnAction = "";
    if (podeReceber && !jaFinalizado) {
      btnAction = `<button class="botao botao-sm botao-principal" data-open-receive data-id="${d.id}">📥 Receber</button>`;
    }

    el.innerHTML = `
      <div class="devolucao-header">
        <div style="display:flex; gap:8px; align-items:center;">
          <span class="badge-id" title="ID do Pedido">#${d.id_venda || d.id}</span>
          ${isNova ? '<span class="pill-nova">Nova devolução</span>' : ''}
        </div>
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
          ${this.getBadgeInterno(d)}
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
  traduzirStatusML(stRaw) {
    const st = String(stRaw || "").toLowerCase();

    const map = {
      // principais
      pending:         "Pendente",
      shipped:         "Em trânsito",
      delivered:       "Entregue no CD",
      cancelled:       "Cancelado",
      closed:          "Encerrado",
      expired:         "Expirado",
      label_generated: "Pronta para envio",
      dispute:         "Mediação",
      mediation:       "Mediação",

      // mapeando variações do /v2/claims/$CLAIM_ID/returns
      pending_cancel:     "Pendente",
      pending_expiration: "Pendente",
      pending_failure:    "Pendente",
      scheduled:          "Pendente",
      pending_delivered:  "Em trânsito",
      return_to_buyer:    "Em trânsito",
      failed:             "Cancelado",
      not_delivered:      "Não entregue",

      // shipment.status
      ready_to_ship: "Pronta para envio"
    };

    return map[st] || (st || "—");
  }

  getClassStatusML(stRaw) {
    const st = String(stRaw || "").toLowerCase();

    // entregues
    if (st === "delivered") return "badge-status-aprovado";

    // em trânsito / a caminho
    if (["shipped", "pending_delivered", "return_to_buyer"].includes(st)) {
      return "badge-status-neutro";
    }

    // pronta para envio / etiqueta gerada
    if (["label_generated", "ready_to_ship", "scheduled"].includes(st)) {
      return "badge-status-neutro";
    }

    // problemas / cancelado / falha
    if (["cancelled", "failed", "not_delivered", "expired"].includes(st)) {
      return "badge-status-rejeitado";
    }

    // default = pendente
    return "badge-status-pendente";
  }

  getBadgeInterno(row) {
    const s = String(row && row.status || "").toLowerCase();

    // Prioridade: se a claim está em mediação no ML, mostra badge próprio
    if (this.isEmMediacaoML(row)) {
      return '<span class="badge badge-status-rejeitado">Em mediação (ML)</span>';
    }

    if (["aprovado", "concluida", "concluido", "finalizado", "encerrado"].includes(s)) {
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
      this.getValorProduto(e) // exporta já normalizado
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
