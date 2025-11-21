// /public/js/index.js
class DevolucoesFeed {
  constructor() {
    this.items = [];
    this.filtros = { pesquisa: "", status: "todos" };
    this.RANGE_DIAS = 30;
    this.pageSize = 15;
    this.page = 1;

    // Cache e Controle
    this.NEW_KEY_PREFIX = "rf:firstSeen:";
    this.SYNC_MS = 5 * 60 * 1000;
    
    // Dados do Seller (Headers)
    this.sellerId   = document.querySelector('meta[name="ml-seller-id"]')?.content?.trim() || '';
    this.sellerNick = document.querySelector('meta[name="ml-seller-nick"]')?.content?.trim() || '';

    // Grupos de Status
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
    
    // Carregamento inicial
    await this.carregar();
    this.renderizar();
    
    // Auto-sync silencioso
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

    // 2. Abas de Filtro (Novo!)
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
    document.getElementById("paginacao")?.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-page]");
      if (btn && !btn.disabled) {
        this.page = Number(btn.dataset.page);
        this.renderizar();
        // Scroll suave pro topo da lista
        document.getElementById("filtros")?.scrollIntoView({ behavior: 'smooth' });
      }
    });

    // 4. Botão Exportar
    document.getElementById("botao-exportar")?.addEventListener("click", () => this.exportar());
  }

  // ===== Dados e API =====
  async carregar() {
    this.toggleSkeleton(true);
    try {
      // Busca dados da API local
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
    // Conta quantos itens existem em cada status para mostrar nas abas
    const counts = { todos: 0, pendente: 0, em_analise: 0, disputa: 0, finalizado: 0 };
    
    this.items.forEach(d => {
      counts.todos++;
      const grupo = this.identificarGrupo(d.status);
      if (counts[grupo] !== undefined) counts[grupo]++;
    });

    // Atualiza o DOM
    Object.keys(counts).forEach(key => {
      const el = document.getElementById(`count-${key.replace('em_', '')}`); // ajusta em_analise -> analise se precisar
      if (el) el.textContent = counts[key] > 0 ? counts[key] : ''; // esconde se 0
    });
    
    // Ajuste manual pro ID específico do HTML (count-analise)
    const elAnalise = document.getElementById('count-analise');
    if(elAnalise) elAnalise.textContent = counts.em_analise || '';
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

    const termo = this.filtros.pesquisa.toLowerCase();
    const statusFiltro = this.filtros.status;

    // Filtragem Cliente-Side
    const filtrados = this.items.filter(d => {
      // Filtro de Texto
      const matchTexto = [
        d.id_venda, d.cliente_nome, d.sku, d.loja_nome, d.status, d.ml_return_status
      ].some(val => String(val || "").toLowerCase().includes(termo));

      if (!matchTexto) return false;

      // Filtro de Status (Abas)
      if (statusFiltro === "todos") return true;
      return this.identificarGrupo(d.status) === statusFiltro;
    });

    // Paginação Cliente-Side
    const total = filtrados.length;
    const totalPages = Math.ceil(total / this.pageSize) || 1;
    if (this.page > totalPages) this.page = totalPages;
    
    const inicio = (this.page - 1) * this.pageSize;
    const fim = inicio + this.pageSize;
    const pageItems = filtrados.slice(inicio, fim);

    // Renderiza HTML
    container.innerHTML = "";
    
    if (pageItems.length === 0) {
      document.getElementById("mensagem-vazia").hidden = false;
      document.getElementById("paginacao").innerHTML = "";
      return;
    }
    
    document.getElementById("mensagem-vazia").hidden = true;

    pageItems.forEach(d => {
      container.appendChild(this.criarCard(d));
    });

    this.renderizarPaginacao(totalPages);
  }

  // ===== Criação do Novo Card (Design Atualizado) =====
  criarCard(d) {
    const el = document.createElement("div");
    el.className = "card-devolucao";
    
    // Dados formatados
    const dataFmt = d.created_at ? new Date(d.created_at).toLocaleDateString('pt-BR') : '—';
    const valorFmt = Number(d.valor_produto || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const freteFmt = Number(d.valor_frete || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const fotoUrl = d.foto_produto || 'assets/img/box.png'; // Placeholder se não tiver foto
    
    // Lógica de Status
    const statusML = this.traduzirStatusML(d.ml_return_status);
    const statusClass = this.getClassStatusML(d.ml_return_status);
    
    // Botão de Ação Principal (Lógica)
    const podeReceber = d.log_status === 'recebido_cd' || d.ml_return_status === 'delivered';
    const jaFinalizado = ['aprovado', 'rejeitado', 'concluida'].includes(String(d.status).toLowerCase());
    
    let btnAction = '';
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
          <div class="produto-titulo" title="${d.sku || 'Produto sem nome'}">
            ${d.sku || 'Produto não identificado'}
          </div>
          
          <div class="motivo-linha text-muted">
            ${d.loja_nome || 'Loja não inf.'}
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
      pending: 'Pendente', shipped: 'Em Trânsito', delivered: 'Entregue no CD',
      cancelled: 'Cancelado', closed: 'Encerrado', expired: 'Expirado'
    };
    return map[st] || st || '—';
  }

  getClassStatusML(st) {
    if (st === 'delivered') return 'badge-status-aprovado';
    if (st === 'shipped') return 'badge-status-neutro';
    if (st === 'cancelled') return 'badge-status-rejeitado';
    return 'badge-status-pendente';
  }

  getBadgeInterno(st) {
    const s = String(st || "").toLowerCase();
    if (['aprovado', 'concluida'].includes(s)) return '<span class="badge badge-status-aprovado">Concluído</span>';
    if (['rejeitado', 'disputa'].includes(s)) return '<span class="badge badge-status-rejeitado">Disputa</span>';
    return ''; // Se for pendente, não polui o card, mostra só o do ML
  }

  renderizarPaginacao(total) {
    const nav = document.getElementById("paginacao");
    if (!nav) return;
    if (total <= 1) { nav.innerHTML = ""; return; }
    
    let html = "";
    // Lógica simples: anterior, atual, próxima
    if (this.page > 1) html += `<button class="page-btn" data-page="${this.page - 1}">‹</button>`;
    html += `<span style="font-size:0.9rem; padding:0 1rem;">Pág <b>${this.page}</b> de ${total}</span>`;
    if (this.page < total) html += `<button class="page-btn" data-page="${this.page + 1}">›</button>`;
    
    nav.innerHTML = html;
  }

  toggleSkeleton(show) {
    const skel = document.getElementById("loading-skeleton");
    const list = document.getElementById("lista-devolucoes");
    if (skel) skel.hidden = !show;
    if (list) list.style.display = show ? "none" : "block";
  }

  toast(titulo, msg, tipo) {
    const t = document.getElementById("toast");
    if (!t) return;
    t.querySelector("strong").innerText = titulo;
    t.querySelector("div").innerText = msg;
    t.className = `toast show ${tipo}`;
    setTimeout(() => t.classList.remove("show"), 3000);
  }

  // Helpers globais
  exposeGlobalReload() {
    window.rfReloadReturnsList = () => this.carregar();
  }
  
  startAutoSync() {
    setInterval(() => this.carregar(), this.SYNC_MS);
  }
  
  exportar() {
    if(!this.items.length) return this.toast("Atenção", "Nada para exportar", "warning");
    const csvContent = "data:text/csv;charset=utf-8," + 
      ["ID,Pedido,Cliente,Status,Valor"].join(",") + "\n" +
      this.items.map(e => `${e.id},${e.id_venda},${e.cliente_nome},${e.status},${e.valor_produto}`).join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "devolucoes.csv");
    document.body.appendChild(link);
    link.click();
  }
}

// Inicialização
document.addEventListener("DOMContentLoaded", () => {
  window.FeedDevolucoes = new DevolucoesFeed();
});