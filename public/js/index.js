class SistemaDevolucoes {
  constructor() {
    this.devolucoes = [];
    this.filtros = { pesquisa: '', status: 'todos' };
    this.lojaDetectada = { loja_id: null, loja_nome: null };
    this.dp = { open: false, activeIndex: -1, data: [], el: null };
    this.accountPadrao = 'Conta de Teste';
    this.inicializar();
  }

  // debounce simples
  debounce(fn, ms = 250) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  async inicializar() {
    this.configurarEventListeners();
    this.prepararAnimacoesIniciais();
    await this.carregarDevolucoesDoServidor();
    this.atualizarEstatisticas();
    this.renderizarDevolucoes();
  }

  // ----------- Backend helpers -----------
  async getJSON(url, opts) {
    const r = await fetch(url, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error || r.statusText || 'Falha na requisição');
    return j;
  }

  async carregarDevolucoesDoServidor() {
    try {
      const res = await this.getJSON('/api/returns?page=1&pageSize=100');
      const rows = Array.isArray(res?.items) ? res.items : (Array.isArray(res) ? res : []);
      this.devolucoes = rows.map((row) => ({
        id: String(row.id),
        numeroPedido: String(row.id_venda ?? ''),
        cliente: '—',
        produto: row.sku || '—',
        motivo: row.reclamacao || row.tipo_reclamacao || '—',
        status: row.status || 'pendente',
        dataAbertura: row.data_compra
          ? String(row.data_compra).slice(0, 10)
          : new Date(row.created_at).toISOString().slice(0, 10),
        valorProduto: row.valor_produto != null ? Number(row.valor_produto) : 0,
        valorFrete: row.valor_frete != null ? Number(row.valor_frete) : 0,
        lojaNome: row.loja_nome || null,
        lojaId: row.loja_id || null,
        sku: row.sku || null,
      }));
    } catch (e) {
      console.warn('Falha ao carregar devoluções:', e.message);
      this.mostrarToast('Aviso', 'Não foi possível carregar as devoluções do servidor.', 'erro');
    }
  }

  async descobrirLojaPorNumeroPedido(numeroPedido) {
    try {
      const data = await this.getJSON(
        `/api/sales/${encodeURIComponent(numeroPedido)}?account=${encodeURIComponent(this.accountPadrao)}`
      );
      this.lojaDetectada = {
        loja_id: data.lojaId ?? null,
        loja_nome: data.lojaNome || null,
      };
      if (data.lojaNome) {
        const inputNumero = document.getElementById('numero-pedido');
        if (inputNumero && !inputNumero.value && data.numeroPedido) {
          inputNumero.value = data.numeroPedido;
        }
        this.mostrarToast('Loja encontrada', `Usaremos: ${data.lojaNome}`, 'sucesso');
      } else {
        this.mostrarToast('Sem nome de loja', 'Não veio nome; salvaremos sem loja.', 'erro');
      }
    } catch (e) {
      this.lojaDetectada = { loja_id: null, loja_nome: null };
      console.log('Não foi possível descobrir loja para', numeroPedido, e.message);
    }
  }

  async salvarDevolucaoNoServidor(payload) {
    const j = await this.getJSON('/api/returns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return j;
  }

  // ----------- UI / Eventos -----------
  configurarEventListeners() {
    // abrir modal
    document.addEventListener('click', (e) => {
      const btn = e.target.closest && e.target.closest('#botao-nova-devolucao');
      if (btn) {
        e.preventDefault();
        this.abrirModal();
      }
    });

    const modal = document.getElementById('modal-nova-devolucao');
    const botaoFechar = document.getElementById('botao-fechar-modal');
    const botaoCancelar = document.getElementById('botao-cancelar');
    const form = document.getElementById('form-nova-devolucao');

    if (botaoFechar) botaoFechar.addEventListener('click', () => this.fecharModal());
    if (botaoCancelar) botaoCancelar.addEventListener('click', () => this.fecharModal());

    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal || e.target.classList.contains('modal-overlay')) this.fecharModal();
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.fecharModal();
        this.fecharDropdown();
      }
    });

    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        await this.criarNovaDevolucao();
      });

      // número do pedido
      const inputNumero = document.getElementById('numero-pedido');
      if (inputNumero) {
        const go = () => {
          const v = inputNumero.value.trim();
          if (v) this.descobrirLojaPorNumeroPedido(v);
        };
        inputNumero.addEventListener('change', go);
        inputNumero.addEventListener('blur', go);
      }

      // número da nota
      const inputNota = document.getElementById('numero-nota');
      if (inputNota) {
        const go = () => {
          const v = inputNota.value.trim();
          if (v) this.buscarPorNotaFiscal(v);
        };
        inputNota.addEventListener('change', go);
        inputNota.addEventListener('blur', go);
      }

      // chave NFe
      const inputChave = document.getElementById('chave-nota');
      if (inputChave) {
        inputChave.addEventListener('blur', () => {
          const v = inputChave.value.trim();
          if (v && v.replace(/\D/g, '').length >= 44) this.buscarPorChaveNFe(v);
        });
      }

      // ---------- Autocomplete Produto ----------
      const inpProduto = document.getElementById('nome-produto');
      if (inpProduto) {
        // pega o dropdown já criado no HTML
        this.dp.el = document.getElementById('lista-produtos');
        // garante posição relativa no wrapper
        const campo = inpProduto.closest('.campo-form') || inpProduto.parentElement;
        campo.style.position = 'relative';

        const buscar = this.debounce(async () => {
          const q = inpProduto.value.trim();
          if (q.length < 2) {
            this.fecharDropdown();
            return;
          }
          try {
            const itens = await this.buscarProdutosRemoto(q);
            this.renderizarSugestoesProdutos(itens);
          } catch {
            this.fecharDropdown();
          }
        }, 300);

        inpProduto.addEventListener('input', buscar);
        inpProduto.addEventListener('focus', buscar);

        // navegação teclado
        inpProduto.addEventListener('keydown', (e) => {
          if (!this.dp.open) return;
          const max = this.dp.data.length - 1;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            this.setAtivo(Math.min(max, this.dp.activeIndex + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            this.setAtivo(Math.max(0, this.dp.activeIndex - 1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (this.dp.activeIndex >= 0) this.selecionarSugestao(this.dp.activeIndex);
          } else if (e.key === 'Escape') {
            this.fecharDropdown();
          }
        });

        // clique fora
        document.addEventListener('click', (ev) => {
          if (!this.dp.open) return;
          if (!this.dp.el.contains(ev.target) && ev.target !== inpProduto) {
            this.fecharDropdown();
          }
        });

        // captura antes do blur
        this.dp.el.addEventListener('mousedown', (ev) => {
          const li = ev.target.closest('li[data-idx]');
          if (!li) return;
          ev.preventDefault();
          this.selecionarSugestao(parseInt(li.dataset.idx, 10));
        });
      }
      // ---------- fim autocomplete ----------
    }

    const campoPesquisa = document.getElementById('campo-pesquisa');
    if (campoPesquisa) {
      campoPesquisa.addEventListener('input', (e) => {
        this.filtros.pesquisa = e.target.value;
        this.filtrarERenderizar();
      });
    }

    const filtroStatus = document.getElementById('filtro-status');
    if (filtroStatus) {
      filtroStatus.addEventListener('change', (e) => {
        this.filtros.status = e.target.value;
        this.filtrarERenderizar();
      });
    }

    const botaoExportar = document.getElementById('botao-exportar');
    if (botaoExportar) {
      botaoExportar.addEventListener('click', () => this.exportarDados());
    }

    // abrir detalhes
    const lista = document.getElementById('container-devolucoes');
    if (lista) {
      lista.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-ver');
        if (btn) {
          const id = btn.getAttribute('data-id');
          this.abrirModalDetalhes(id);
        }
      });
    }

    // modal detalhes
    const md = document.getElementById('modal-detalhes');
    if (md) {
      document.getElementById('md-fechar')?.addEventListener('click', () => this.fecharModalDetalhes());
      document.getElementById('md-cancelar')?.addEventListener('click', () => this.setModoEdicao(false));
      document.getElementById('md-editar')?.addEventListener('click', () => this.setModoEdicao(true));
      document.getElementById('md-form')?.addEventListener('submit', (e) => this.salvarEdicaoDetalhes(e));
      document.getElementById('md-excluir')?.addEventListener('click', () => this.excluirDevolucaoAtual());
      md.addEventListener('click', (e) => {
        if (e.target === md || e.target.classList.contains('modal-overlay')) this.fecharModalDetalhes();
      });
    }
  }

  // ------- Modal Detalhes/Edição -------
  abrirModalDetalhes(id) {
    const it = this.devolucoes.find((d) => String(d.id) === String(id));
    if (!it) return this.mostrarToast('Erro', 'Registro não encontrado.', 'erro');

    document.getElementById('md-id').value = it.id;
    document.getElementById('md-titulo').textContent = `Devolução #${it.id}`;
    document.getElementById('md-numero').value = it.numeroPedido || '';
    document.getElementById('md-loja').value = it.lojaNome || '';
    document.getElementById('md-status').value = it.status || 'pendente';
    document.getElementById('md-valor-prod').value = it.valorProduto ?? 0;
    document.getElementById('md-valor-frete').value = it.valorFrete ?? 0;
    document.getElementById('md-reclamacao').value = it.motivo || '';

    this.setModoEdicao(false);
    const md = document.getElementById('modal-detalhes');
    md.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }

  fecharModalDetalhes() {
    const md = document.getElementById('modal-detalhes');
    md.style.display = 'none';
    document.body.style.overflow = '';
  }

  setModoEdicao(edit) {
    const dis = !edit;
    ['md-status', 'md-valor-prod', 'md-valor-frete', 'md-reclamacao', 'md-loja'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = dis;
    });
    document.getElementById('md-editar').style.display = edit ? 'none' : '';
    document.getElementById('md-salvar').style.display = edit ? '' : 'none';
    document.getElementById('md-cancelar').style.display = edit ? '' : 'none';
  }

  async salvarEdicaoDetalhes(e) {
    e.preventDefault();
    const id = document.getElementById('md-id').value;
    const body = {
      status: document.getElementById('md-status').value,
      valor_produto: parseFloat(document.getElementById('md-valor-prod').value || '0') || 0,
      valor_frete: parseFloat(document.getElementById('md-valor-frete').value || '0') || 0,
      reclamacao: document.getElementById('md-reclamacao').value || null,
      loja_nome: document.getElementById('md-loja').value || null,
      updated_by: 'front-index',
    };

    try {
      const r = await this.getJSON(`/api/returns/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const i = this.devolucoes.findIndex((d) => String(d.id) === String(id));
      if (i >= 0) {
        this.devolucoes[i].status = r.status || this.devolucoes[i].status;
        this.devolucoes[i].valorProduto = Number(r.valor_produto ?? this.devolucoes[i].valorProduto);
        this.devolucoes[i].valorFrete = Number(r.valor_frete ?? this.devolucoes[i].valorFrete);
        this.devolucoes[i].motivo = r.reclamacao ?? this.devolucoes[i].motivo;
        this.devolucoes[i].lojaNome = r.loja_nome ?? this.devolucoes[i].lojaNome;
      }

      this.setModoEdicao(false);
      this.renderizarDevolucoes();
      this.atualizarEstatisticas();
      this.mostrarToast('Salvo', 'Alterações aplicadas.', 'sucesso');
    } catch (err) {
      this.mostrarToast('Erro', err.message || 'Falha ao salvar.', 'erro');
    }
  }

  async excluirDevolucaoAtual() {
    const id = document.getElementById('md-id').value;
    if (!confirm('Excluir este registro?')) return;

    try {
      await fetch(`/api/returns/${id}`, { method: 'DELETE' });
      this.devolucoes = this.devolucoes.filter((d) => String(d.id) !== String(id));
      this.fecharModalDetalhes();
      this.renderizarDevolucoes();
      this.atualizarEstatisticas();
      this.mostrarToast('Excluído', `Devolução #${id} removida.`, 'sucesso');
    } catch (err) {
      this.mostrarToast('Erro', 'Não foi possível excluir.', 'erro');
    }
  }

  prepararAnimacoesIniciais() {
    const cards = document.querySelectorAll('.card-estatistica');
    cards.forEach((card) => {
      card.style.opacity = '0';
      card.style.transform = 'translateY(20px)';
      card.style.transition = 'opacity 0.5s ease-out, transform 0.5s ease-out';
    });
    const cardFiltros = document.querySelector('.card-filtros');
    if (cardFiltros) {
      cardFiltros.style.opacity = '0';
      cardFiltros.style.transform = 'translateY(20px)';
      cardFiltros.style.transition = 'opacity 0.4s ease-out, transform 0.4s ease-out';
    }
    setTimeout(() => {
      cards.forEach((card, index) => {
        setTimeout(() => {
          card.style.opacity = '1';
          card.style.transform = 'translateY(0)';
        }, index * 100);
      });
      if (cardFiltros) {
        setTimeout(() => {
          cardFiltros.style.opacity = '1';
          cardFiltros.style.transform = 'translateY(0)';
        }, 400);
      }
    }, 0);
  }

  atualizarEstatisticas() {
    const total = this.devolucoes.length;
    const pendentes = this.devolucoes.filter((d) => d.status === 'pendente').length;
    const aprovadas = this.devolucoes.filter((d) => d.status === 'aprovado').length;
    const rejeitadas = this.devolucoes.filter((d) => d.status === 'rejeitado').length;

    this.animarNumero('total-devolucoes', total);
    this.animarNumero('pendentes-count', pendentes);
    this.animarNumero('aprovadas-count', aprovadas);
    this.animarNumero('rejeitadas-count', rejeitadas);
  }

  animarNumero(elementId, valorFinal) {
    const elemento = document.getElementById(elementId);
    if (!elemento) return;
    const duracao = 800;
    const inicio = performance.now();
    const tick = (t) => {
      const p = Math.min(1, (t - inicio) / duracao);
      const val = Math.round(valorFinal * p);
      elemento.textContent = String(val);
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  filtrarERenderizar() {
    const q = (this.filtros.pesquisa || '').toLowerCase().trim();
    const st = this.filtros.status;

    const devolucoesFiltradas = this.devolucoes.filter((d) => {
      const textoMatch =
        (d.cliente || '').toLowerCase().includes(q) ||
        (d.numeroPedido || '').toLowerCase().includes(q) ||
        (d.produto || '').toLowerCase().includes(q) ||
        (d.lojaNome || '').toLowerCase().includes(q);

      const statusMatch = st === 'todos' || d.status === st;
      return textoMatch && statusMatch;
    });

    this.renderizarDevolucoes(devolucoesFiltradas);
  }

  renderizarDevolucoes(devolucoesFiltradas = null) {
    const container = document.getElementById('container-devolucoes');
    const mensagemVazia = document.getElementById('mensagem-vazia');
    const descricaoVazia = document.getElementById('descricao-vazia');
    if (!container) return;

    const lista = devolucoesFiltradas || this.devolucoes;

    if (lista.length === 0) {
      container.style.display = 'none';
      if (mensagemVazia) {
        mensagemVazia.style.display = 'flex';
        if (descricaoVazia) {
          descricaoVazia.textContent =
            this.filtros.pesquisa || this.filtros.status !== 'todos'
              ? 'Tente ajustar os filtros de pesquisa'
              : 'Nenhuma devolução foi registrada ainda';
        }
      }
      return;
    }

    container.style.display = 'flex';
    if (mensagemVazia) mensagemVazia.style.display = 'none';
    container.innerHTML = '';

    lista.forEach((dev, idx) => container.appendChild(this.criarCardDevolucao(dev, idx)));
  }

  criarCardDevolucao(d, index) {
    const card = document.createElement('div');
    card.className = 'card-devolucao slide-up';
    card.style.animationDelay = `${index * 0.1}s`;

    const dataFormatada = d.dataAbertura ? new Date(d.dataAbertura).toLocaleDateString('pt-BR') : '—';
    const valor = typeof d.valorProduto === 'number' ? d.valorProduto : 0;
    const valorFmt = `R$ ${valor.toFixed(2).replace('.', ',')}`;

    card.innerHTML = `
      <div class="devolucao-header">
        <div class="devolucao-titulo-area">
          <h3 class="devolucao-titulo">
            <svg class="icone" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 1a2.5 2.5 0 0 1 2.5 2.5V4h-5v-.5A2.5 2.5 0 0 1 8 1zm3.5 3v-.5a3.5 3.5 0 1 0-7 0V4H1v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V4h-3.5z"/>
            </svg>
            Pedido ${d.numeroPedido}
          </h3>
          <p class="devolucao-subtitulo">Aberto em ${dataFormatada}${d.lojaNome ? ` • ${d.lojaNome}` : ''}</p>
        </div>
        <div class="devolucao-acoes">
          ${this.criarBadgeStatus(d.status)}
          <button class="botao botao-outline btn-ver" data-id="${d.id}" style="padding: 0.5rem;" title="Ver detalhes">
            <svg class="icone" viewBox="0 0 16 16" fill="currentColor">
              <path d="M16 8s-3-5.5-8-5.5S0 8 0 8s3 5.5 8 5.5S16 8 16 8zM1.173 8a13.133 13.133 0 0 1 1.66-2.043C4.12 4.668 5.88 3.5 8 3.5c2.12 0 3.879 1.168 5.168 2.457A13.133 13.133 0 0 1 14.828 8c-.058.087-.122.183-.195.288-.335.48-.83 1.12-1.465 1.755C11.879 11.332 10.119 12.5 8 12.5c-2.12 0-3.879-1.168-5.168-2.457A13.134 13.134 0 0 1 1.172 8z"/>
              <path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM4.5 8a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0z"/>
            </svg>
          </button>
        </div>
      </div>

      <div class="devolucao-conteudo">
        <div>
          <div class="campo-info">
            <svg class="icone" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm2-3a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm4 8c0 1-1 1-1 1H3s-1 0-1-1 1-4 6-4 6 3 6 4z"/>
            </svg>
            <span class="campo-label">Cliente:</span>
            <span class="campo-valor">${d.cliente || '—'}</span>
          </div>

          <div class="campo-info">
            <svg class="icone" viewBox="0 0 16 16" fill="currentColor">
              <path d="M0 1.5A.5.5 0 0 1 .5 1H2a.5.5 0 0 1 .485.379L2.89 3H14.5a.5.5 0 0 1 .491.592l-1.5 8A.5.5 0 0 1 13 12H4a.5.5 0 0 1-.491-.408L2.01 3.607 1.61 2H.5a.5.5 0 0 1-.5-.5z"/>
            </svg>
            <span class="campo-label">Produto:</span>
            <span class="campo-valor">${(d.produto || '—') + (d.sku ? ' • ' + d.sku : '')}</span>
          </div>
        </div>

        <div>
          <div class="campo-info">
            <span class="campo-label">Valor:</span>
            <span class="campo-valor valor-destaque">${valorFmt}</span>
          </div>

          <div>
            <span class="campo-label">Motivo:</span>
            <p class="motivo-texto">${d.motivo || '—'}</p>
          </div>
        </div>
      </div>
    `;
    return card;
  }

  criarBadgeStatus(status) {
    const map = {
      pendente: '<div class="badge badge-pendente">Pendente</div>',
      aprovado: '<div class="badge badge-aprovado">Aprovado</div>',
      rejeitado: '<div class="badge badge-rejeitado">Rejeitado</div>',
    };
    return map[status] || `<div class="badge">${status || '—'}</div>`;
  }

  abrirModal() {
    const modal = document.getElementById('modal-nova-devolucao');
    if (!modal) return;
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    setTimeout(() => document.getElementById('numero-pedido')?.focus(), 100);
  }

  fecharModal() {
    const modal = document.getElementById('modal-nova-devolucao');
    const form = document.getElementById('form-nova-devolucao');
    if (modal) modal.style.display = 'none';
    document.body.style.overflow = '';
    form?.reset();
    this.lojaDetectada = { loja_id: null, loja_nome: null };
    this.fecharDropdown();
  }

  async criarNovaDevolucao() {
    const numeroPedido = document.getElementById('numero-pedido')?.value.trim();
    const cliente = document.getElementById('nome-cliente')?.value.trim();
    const produto = document.getElementById('nome-produto')?.value.trim();
    const sku = document.getElementById('sku-produto')?.value.trim() || null;
    const valorProduto = parseFloat(document.getElementById('valor-produto')?.value) || 0;
    const motivo = document.getElementById('motivo-devolucao')?.value.trim() || null;
    const numeroNota = document.getElementById('numero-nota')?.value.trim();

    if (!numeroPedido && !numeroNota) {
      this.mostrarToast('Erro', 'Informe o Número do Pedido ou o Número da Nota.', 'erro');
      return;
    }
    if (!cliente || !produto) {
      this.mostrarToast('Erro', 'Preencha Cliente e Produto.', 'erro');
      return;
    }

    const payload = {
      data_compra: null,
      id_venda: numeroPedido || null,
      loja_id: this.lojaDetectada.loja_id,
      loja_nome: this.lojaDetectada.loja_nome,
      sku: sku || null,
      tipo_reclamacao: null,
      status: 'pendente',
      valor_produto: valorProduto || null,
      valor_frete: null,
      reclamacao: motivo,
      nfe_numero: numeroNota || null,
      nfe_chave: document.getElementById('chave-nota')?.value.trim() || null,
      created_by: 'front-web',
    };

    try {
      const r = await this.salvarDevolucaoNoServidor(payload);
      this.devolucoes.unshift({
        id: String(r.id),
        numeroPedido: numeroPedido || '(sem nº)',
        cliente,
        produto,
        sku,
        motivo,
        valorProduto,
        status: 'pendente',
        dataAbertura: new Date().toISOString().slice(0, 10),
        lojaNome: this.lojaDetectada.loja_nome || null,
        lojaId: this.lojaDetectada.loja_id || null,
      });
      this.fecharModal();
      this.atualizarEstatisticas();
      this.renderizarDevolucoes();
      this.mostrarToast('Sucesso!', `Devolução #${r.id} criada.`, 'sucesso');
    } catch (e) {
      console.error(e);
      this.mostrarToast('Erro', e.message || 'Falha ao salvar devolução.', 'erro');
    }
  }

  // ------- Busca por NFe -------
  async buscarPorNotaFiscal(numeroNota) {
    try {
      const r = await fetch(`/api/invoice/${encodeURIComponent(numeroNota)}`);
      if (r.ok) {
        const data = await r.json();
        if (data.lojaNome) {
          this.lojaDetectada.loja_nome = data.lojaNome;
          this.mostrarToast('Loja encontrada', `Loja: ${data.lojaNome}`, 'sucesso');
        }
        if (data.valor_total != null) {
          document.getElementById('valor-produto').value = Number(data.valor_total).toFixed(2);
        }
        if (data.cliente) document.getElementById('nome-cliente').value = data.cliente;
        if (data.chave) document.getElementById('chave-nota').value = data.chave;
      }

      try {
        const sale = await this.getJSON(
          `/api/sales/by-invoice/${encodeURIComponent(numeroNota)}?account=${encodeURIComponent(this.accountPadrao)}`
        );
        const inputNumero = document.getElementById('numero-pedido');
        if (inputNumero && sale?.numeroPedido) inputNumero.value = sale.numeroPedido;
        if (sale?.lojaNome) {
          this.lojaDetectada.loja_nome = sale.lojaNome;
          this.mostrarToast('Pedido encontrado', `#${sale.numeroPedido} • ${sale.lojaNome}`, 'sucesso');
        }
      } catch {}
    } catch (e) {
      console.log('Nota fiscal não encontrada via API:', e.message || e);
    }
  }

  async buscarPorChaveNFe(chave) {
    try {
      const r = await fetch(`/api/invoice/chave/${encodeURIComponent(chave)}`);
      if (r.ok) {
        const data = await r.json();
        if (data.lojaNome) {
          this.lojaDetectada.loja_nome = data.lojaNome;
          this.mostrarToast('Loja encontrada', `Loja: ${data.lojaNome}`, 'sucesso');
        }
        if (data.valor_total != null) {
          document.getElementById('valor-produto').value = Number(data.valor_total).toFixed(2);
        }
        if (data.cliente) document.getElementById('nome-cliente').value = data.cliente;
      }

      try {
        const sale = await this.getJSON(
          `/api/sales/by-chave/${encodeURIComponent(chave)}?account=${encodeURIComponent(this.accountPadrao)}`
        );
        const inputNumero = document.getElementById('numero-pedido');
        if (inputNumero && sale?.numeroPedido) inputNumero.value = sale.numeroPedido;
        if (sale?.lojaNome) {
          this.lojaDetectada.loja_nome = sale.lojaNome;
          this.mostrarToast('Pedido encontrado', `#${sale.numeroPedido} • ${sale.lojaNome}`, 'sucesso');
        }
      } catch {}
    } catch (e) {
      console.log('Chave NFe não encontrada via API:', e.message || e);
    }
  }

  // --------- AUTOCOMPLETE DE PRODUTOS ---------
  async buscarProdutosRemoto(q) {
    try {
      const url1 = `/api/bling/products?q=${encodeURIComponent(q)}&limit=10&account=${encodeURIComponent(this.accountPadrao)}`;
      const r1 = await fetch(url1);
      if (r1.ok) return await r1.json();
    } catch {}
    try {
      const url2 = `/api/products/search?q=${encodeURIComponent(q)}&limit=10&account=${encodeURIComponent(this.accountPadrao)}`;
      const r2 = await fetch(url2);
      if (r2.ok) return await r2.json();
    } catch {}
    return [];
  }

  abrirDropdown() {
    if (!this.dp.el) return;
    this.dp.el.style.display = 'block';
    this.dp.open = true;
  }

  fecharDropdown() {
    if (!this.dp.el) return;
    this.dp.el.style.display = 'none';
    this.dp.open = false;
    this.dp.activeIndex = -1;
    const ul = this.dp.el.querySelector('ul');
    if (ul) ul.innerHTML = '';
  }

  setAtivo(i) {
    this.dp.activeIndex = i;
    const ul = this.dp.el.querySelector('ul');
    if (!ul) return;
    [...ul.children].forEach((li, idx) => {
      li.classList.toggle('active', idx === i);
      if (idx === i) li.scrollIntoView({ block: 'nearest' });
    });
  }

  renderizarSugestoesProdutos(lista) {
    if (!this.dp.el) return;
    const ul = this.dp.el.querySelector('ul');
    if (!ul) return;

    // normaliza (aceita string ou objeto)
    this.dp.data = (Array.isArray(lista) ? lista : []).map(x =>
      (x && typeof x === 'object') ? x : { nome: String(x), sku: '', preco: null }
    );

    ul.innerHTML = '';

    if (!this.dp.data.length) {
      ul.innerHTML = `<li><div class="dp-empty">Nenhum produto encontrado</div></li>`;
      this.abrirDropdown();
      return;
    }

    this.dp.data.forEach((p, idx) => {
      const li = document.createElement('li');
      li.setAttribute('data-idx', String(idx));
      li.innerHTML = `
        <div class="dp-left">
          <div class="dp-title">${this.escapeHTML(p.nome || p.title || '(sem nome)')}</div>
          <div class="dp-meta">
            ${p.sku ? `<span class="dp-badge">SKU: ${this.escapeHTML(p.sku)}</span>` : ''}
            ${p.gtin ? `<span class="dp-badge">GTIN: ${this.escapeHTML(p.gtin)}</span>` : ''}
          </div>
        </div>
        <div class="dp-right">
          ${p.estoque != null ? `<div>Estoque: ${Number(p.estoque)}</div>` : '<div>&nbsp;</div>'}
          ${p.preco != null ? `<div class="dp-price">R$ ${Number(p.preco).toFixed(2).replace('.', ',')}</div>` : ''}
        </div>
      `;
      ul.appendChild(li);
    });

    this.setAtivo(0);
    this.abrirDropdown();
  }

  selecionarSugestao(idx) {
    const p = this.dp.data[idx];
    if (!p) return;
    const nomeInput = document.getElementById('nome-produto');
    const skuInput  = document.getElementById('sku-produto');
    const valorInput= document.getElementById('valor-produto');

    if (nomeInput)  nomeInput.value  = p.nome || p.title || '';
    if (skuInput)   skuInput.value   = p.sku  || '';
    if (valorInput && p.preco != null) valorInput.value = Number(p.preco).toFixed(2);

    this.fecharDropdown();
  }

  escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }
  // --------- FIM AUTOCOMPLETE ---------

  // ------- utilitários / UI -------
  mostrarToast(titulo, descricao, tipo = 'sucesso') {
    const toast = document.getElementById('toast');
    const toastTitulo = document.getElementById('toast-titulo');
    const toastDescricao = document.getElementById('toast-descricao');
    if (!toast || !toastTitulo || !toastDescricao) return;

    toastTitulo.textContent = titulo;
    toastDescricao.textContent = descricao;

    const wrap = toast.querySelector('.toast-icone');
    const svg = wrap?.querySelector('svg');
    if (wrap && svg) {
      if (tipo === 'erro') {
        wrap.style.background = 'var(--destructive)';
        svg.innerHTML =
          '<path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>';
      } else {
        wrap.style.background = 'var(--secondary)';
        svg.innerHTML =
          '<path d="M10.97 4.97a.235.235 0 0 0-.02.022L7.477 9.417 5.384 7.323a.75.75 0 0 0-1.06 1.061L6.97 11.03a.75.75 0 0 0 1.079-.02l3.992-4.99a.75.75 0 0 0-1.071-1.05z"/>';
      }
    }

    toast.style.display = 'block';
    setTimeout(() => { toast.style.display = 'none'; }, 4000);
  }

  exportarDados() {
    const dados = this.devolucoes.map((d) => ({
      'Número do Pedido': d.numeroPedido,
      Cliente: d.cliente,
      Produto: d.produto,
      Status: d.status,
      'Data de Abertura': d.dataAbertura,
      Valor: d.valorProduto,
      Motivo: d.motivo,
      Loja: d.lojaNome || '',
    }));
    const csv = this.toCSV(dados);
    this.downloadCSV(csv, 'devolucoes.csv');
    this.mostrarToast('Exportado!', 'Dados exportados com sucesso.', 'sucesso');
  }

  toCSV(rows) {
    if (!rows.length) return '';
    const headers = Object.keys(rows[0]);
    const esc = (v) => {
      if (v == null) return '';
      const s = String(v);
      return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n');
  }

  downloadCSV(text, name) {
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.sistemaDevolucoes = new SistemaDevolucoes();
});
