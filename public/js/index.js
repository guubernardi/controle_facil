/*
 * Retorno Fácil — index.js (Feed Geral de Devoluções)
 * Atualizações:
 *  - Botão "Sincronizar ML" usa GET /api/ml/claims/import (últimos 14 dias).
 *  - Escuta SSE /events e mostra toast quando abrir/atualizar uma reclamação.
 */

/* eslint-disable no-console */
class DevolucoesFeed {
  constructor() {
    this.items = [];
    this.filtros = { pesquisa: '', status: 'todos' };

    this.STATUS_GRUPOS = {
      aprovado: new Set(['aprovado', 'autorizado', 'autorizada']),
      rejeitado: new Set(['rejeitado', 'rejeitada', 'negado', 'negada']),
      finalizado: new Set(['concluido','concluida','finalizado','finalizada','fechado','fechada','encerrado','encerrada']),
      pendente: new Set([
        'pendente','em_analise','em-analise','analise','em_inspecao','em-inspecao','inspecao',
        'aguardando_postagem','aguardando-logistica','aguardando_logistica','recebido_cd','aberto','novo',
        'em_envio','em-transito','em_transito','disputa_cliente','disputa_plataforma','em_disputa'
      ])
    };

    this.logsPage = 'logs.html';
    this.inicializar();
  }

  async inicializar() {
    this.configurarUI();
    await this.carregar();
    this.atualizarKpis();
    this.renderizar();
    this.syncTabsUI();
    this.escutarEventos(); // << NOVO: SSE
  }

  // ---------------- Infra ----------------
  async getJSON(url, opts) {
    const r = await fetch(url, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error || r.statusText || 'Falha na requisição');
    return j;
  }

  toggleSkeleton(show) {
    const sk = document.getElementById('loading-skeleton');
    if (sk) sk.style.display = show ? 'block' : 'none';
    const list = document.getElementById('container-devolucoes');
    if (list) list.style.display = show ? 'none' : 'flex';
  }

  // --------------- Carregamento ---------------
  async carregar() {
    this.toggleSkeleton(true);
    try {
      const q = new URLSearchParams({ page: '1', pageSize: '100', orderBy: 'created_at', orderDir: 'desc' });
      const data = await this.getJSON(`/api/returns/search?${q.toString()}`);
      const rows = Array.isArray(data?.items) ? data.items : [];

      this.items = rows.map((r) => ({
        id: Number(r.id),
        id_venda: r.id_venda ?? null,
        cliente_nome: r.cliente_nome ?? null,
        loja_nome: r.loja_nome ?? null,
        sku: r.sku ?? null,
        status: r.status ?? 'pendente',
        log_status: r.log_status ?? null,
        created_at: r.created_at,
        valor_produto: r.valor_produto == null ? null : Number(r.valor_produto),
        valor_frete: r.valor_frete == null ? null : Number(r.valor_frete)
      }));
    } catch (e) {
      console.warn('[index] Falha ao carregar devoluções:', e.message);
      this.items = [];
      this.toast('Aviso', 'Não foi possível carregar as devoluções agora.', 'erro');
    } finally {
      this.toggleSkeleton(false);
    }
  }

  // --------------- UI / Eventos ---------------
  configurarUI() {
    const campo = document.getElementById('campo-pesquisa');
    if (campo) {
      campo.addEventListener('input', (e) => {
        this.filtros.pesquisa = String(e.target.value || '').trim();
        this.renderizar();
      });
    }

    const tabs = document.querySelector('.tabs-filtro');
    const selectFallback = document.getElementById('filtro-status');

    if (tabs) {
      tabs.addEventListener('click', (e) => {
        const tab = e.target.closest?.('.tab-filtro[role="tab"]');
        if (!tab) return;
        const novo = (tab.dataset.status || 'todos').toLowerCase();
        this.filtros.status = novo;
        this.syncTabsUI(novo);
        if (selectFallback) selectFallback.value = novo;
        this.renderizar();
      });

      tabs.addEventListener('keydown', (e) => {
        const current = e.target.closest?.('.tab-filtro[role="tab"]');
        if (!current) return;
        const all = Array.from(tabs.querySelectorAll('.tab-filtro[role="tab"]'));
        const idx = all.indexOf(current);
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const next = e.key === 'ArrowRight' ? (idx + 1) % all.length : (idx - 1 + all.length) % all.length;
          all[next]?.focus();
        }
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          current.click();
        }
      });
    }

    if (selectFallback) {
      selectFallback.addEventListener('change', (e) => {
        const novo = (e.target.value || 'todos').toLowerCase();
        this.filtros.status = novo;
        this.syncTabsUI(novo);
        this.renderizar();
      });
    }

    // Exportar CSV
    const btnExport = document.getElementById('btn-exportar') || document.getElementById('botao-exportar');
    if (btnExport) btnExport.addEventListener('click', () => this.exportar());

    // Sync ML — GET /api/ml/claims/import (últimos 14 dias)
    const btnSync = document.getElementById('btn-sync-ml');
    if (btnSync) {
      btnSync.addEventListener('click', async () => {
        const original = btnSync.textContent;
        btnSync.disabled = true; btnSync.textContent = 'Sincronizando…';
        try {
          const today = new Date();
          const to   = today.toISOString().slice(0,10);
          const from = new Date(today.getTime() - 14*24*60*60*1000).toISOString().slice(0,10);
          const url  = `/api/ml/claims/import?from=${from}&to=${to}&dry=0`;

          await this.getJSON(url, { method: 'GET' });
          this.toast('OK', 'Sincronização concluída. Atualizando lista…', 'sucesso');
          await this.carregar(); this.atualizarKpis(); this.renderizar();
        } catch (err) {
          this.toast('Erro', err?.message || 'Não foi possível sincronizar com o Mercado Livre.', 'erro');
        } finally {
          btnSync.disabled = false; btnSync.textContent = original;
        }
      });
    }

    // Clique no card -> logs
    const container = document.getElementById('container-devolucoes');
    if (container) {
      container.addEventListener('click', (e) => {
        const card = e.target.closest?.('[data-return-id]');
        if (!card) return;
        const id = card.getAttribute('data-return-id');
        if (!id) return;
        const url = new URL(this.logsPage, window.location.origin);
        url.searchParams.set('return_id', id);
        window.location.href = url.toString();
      });
    }
  }

  // --------------- SSE (tempo real) ---------------
  escutarEventos() {
    try {
      if (!('EventSource' in window)) return;
      const es = new EventSource('/events');

      es.addEventListener('ml_claim_opened', async (e) => {
        const data = JSON.parse(e.data || '{}');
        const pedido = data.order_id || '-';
        const quem = data.buyer ? ` — ${data.buyer}` : '';
        this.toast('Nova reclamação', `Pedido ${pedido}${quem}`, 'erro');
        await this.carregar();
        this.atualizarKpis();
        this.renderizar();
      });

      es.onerror = () => {
        // deixa o EventSource reconectar sozinho; só loga
        console.debug('SSE desconectado, tentando reconectar…');
      };
    } catch (e) {
      console.warn('SSE indisponível:', e?.message);
    }
  }

  // --------------- Render ---------------
  renderizar() {
    const container = document.getElementById('container-devolucoes');
    const vazio = document.getElementById('mensagem-vazia');
    const descVazio = document.getElementById('descricao-vazia');
    if (!container) return;

    const q = this.filtros.pesquisa.toLowerCase();
    const st = (this.filtros.status || 'todos').toLowerCase();

    const filtrados = (this.items || []).filter((d) => {
      const textoMatch = [d.cliente_nome, d.id_venda, d.sku, d.loja_nome, d.status, d.log_status]
        .map((x) => String(x || '').toLowerCase())
        .some((s) => s.includes(q));
      const statusMatch = st === 'todos' || this.grupoStatus(d.status) === st;
      return textoMatch && statusMatch;
    });

    if (!filtrados.length) {
      container.style.display = 'none';
      if (vazio) {
        vazio.style.display = 'flex';
        if (descVazio) descVazio.textContent = q || (st !== 'todos' ? 'Tente ajustar os filtros' : 'Sincronize com a plataforma ou ajuste os filtros.');
      }
      return;
    }

    container.style.display = 'flex';
    if (vazio) vazio.style.display = 'none';
    container.innerHTML = '';
    filtrados.forEach((d, idx) => container.appendChild(this.card(d, idx)));
  }

  card(d, index = 0) {
    const el = document.createElement('div');
    el.className = 'card-devolucao slide-up';
    el.style.animationDelay = `${index * 0.08}s`;
    el.setAttribute('data-return-id', String(d.id));

    const data = this.dataBr(d.created_at);
    const valor = Number(d.valor_produto || 0);

    el.innerHTML = `
      <div class="devolucao-header">
        <div class="devolucao-titulo-area">
          <h3 class="devolucao-titulo">
            <svg class="icone" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M8 1a2.5 2.5 0 0 1 2.5 2.5V4h-5v-.5A2.5 2.5 0 0 1 8 1zm3.5 3v-.5a3.5 3.5 0 1 0-7 0V4H1v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V4h-3.5z"/>
            </svg>
            Pedido ${this.esc(d.id_venda || '-')}
          </h3>
          <p class="devolucao-subtitulo">Aberto em ${data}${d.loja_nome ? ` • ${this.esc(d.loja_nome)}` : ''}</p>
        </div>
        <div class="devolucao-acoes">
          ${this.badgeStatus(d)}
          <button class="botao botao-outline" style="padding:0.5rem" title="Abrir log">
            <svg class="icone" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M16 8s-3-5.5-8-5.5S0 8 0 8s3 5.5 8 5.5S16 8 16 8zM1.173 8a13.133 13.133 0 0 1 1.66-2.043C4.12 4.668 5.88 3.5 8 3.5c2.12 0 3.879 1.168 5.168 2.457A13.133 13.133 0 0 1 14.828 8c-.58.87-3.828 5-6.828 5S2.58 8.87 1.173 8z"/><path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/></svg>
          </button>
        </div>
      </div>

      <div class="devolucao-conteudo">
        <div>
          <div class="campo-info">
            <svg class="icone" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm2-3a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm4 8c0 1-1 1-1 1H3s-1 0-1-1 1-4 6-4 6 3 6 4z"/></svg>
            <span class="campo-label">Cliente:</span>
            <span class="campo-valor">${this.esc(d.cliente_nome || '—')}</span>
          </div>

          <div class="campo-info">
            <svg class="icone" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M0 1.5A.5.5 0 0 1 .5 1H2a.5.5 0 0 1 .485.379L2.89 3H14.5a.5.5 0 0 1 .491.592l-1.5 8A.5.5 0 0 1 13 12H4a.5.5 0 0 1-.491-.408L2.01 3.607 1.61 2H.5a.5.5 0 0 1-.5-.5z"/></svg>
            <span class="campo-label">SKU:</span>
            <span class="campo-valor">${this.esc(d.sku || '—')}</span>
          </div>
        </div>

        <div>
          <div class="campo-info">
            <span class="campo-label">Valor do produto:</span>
            <span class="campo-valor valor-destaque">R$ ${valor.toFixed(2).replace('.', ',')}</span>
          </div>
          ${this.blocoLogistica(d)}
        </div>
      </div>
    `;
    return el;
  }

  blocoLogistica(d) {
    const s = String(d.status || '').toLowerCase();
    const l = String(d.log_status || '').toLowerCase();

    let etapa = '—';
    if (/(disputa|claim)/.test(s) || /(disputa)/.test(l)) {
      etapa = l.includes('plataforma') || s.includes('plataforma') ? 'Em disputa (plataforma)' : 'Em disputa (cliente)';
    } else if (/em_envio|em[-_ ]?transito|postado|coletado/.test(l)) {
      etapa = 'Em envio';
    } else if (/recebido_cd|inspecao|inspeção/.test(l)) {
      etapa = l.includes('recebido') ? 'Recebido no CD' : 'Em inspeção';
    } else if (this.STATUS_GRUPOS.aprovado.has(s)) {
      etapa = 'Autorizada — aguardando postagem';
    } else if (this.STATUS_GRUPOS.rejeitado.has(s)) {
      etapa = 'Rejeitada';
    }

    let eta = '';
    if (/em_envio|em[-_ ]?transito|postado|coletado/.test(l)) {
      const d0 = new Date(d.created_at);
      eta = new Date(d0.getTime() + 7 * 24 * 3600 * 1000).toLocaleDateString('pt-BR');
    }

    return `
      <div>
        <span class="campo-label">Etapa logística:</span>
        <p class="motivo-texto">${this.esc(etapa)}${eta ? ` • Chegada estimada: ${eta}` : ''}</p>
      </div>
    `;
  }

  badgeStatus(d) {
    const grp = this.grupoStatus(d.status);
    const s = String(d.status || '').toLowerCase();
    const l = String(d.log_status || '').toLowerCase();

    const especiais = {
      recebido_cd: '<div class="badge badge-info">Recebido no CD</div>',
      'recebido no cd': '<div class="badge badge-info">Recebido no CD</div>',
      em_inspecao: '<div class="badge badge-info">Em inspeção</div>',
      'em inspeção': '<div class="badge badge-info">Em inspeção</div>',
    };

    if (/(disputa|claim)/.test(s) || /(disputa)/.test(l)) return '<div class="badge badge-info">Em disputa</div>';
    if (/em_envio|em[-_ ]?transito|postado|coletado/.test(l)) return '<div class="badge badge-info">Em envio</div>';

    const map = {
      pendente : '<div class="badge badge-pendente">Pendente</div>',
      aprovado : '<div class="badge badge-aprovado">Aprovado</div>',
      rejeitado: '<div class="badge badge-rejeitado">Rejeitado</div>',
      finalizado: '<div class="badge badge">Finalizado</div>'
    };

    return especiais[l] || especiais[s] || map[grp] || `<div class="badge">${this.esc(d.status || '—')}</div>`;
  }

  // --------------- KPIs / helpers ---------------
  atualizarKpis() {
    const total = this.items.length;
    const pend = this.items.filter((d) => this.grupoStatus(d.status) === 'pendente').length;
    const aprov = this.items.filter((d) => this.grupoStatus(d.status) === 'aprovado').length;
    const rej = this.items.filter((d) => this.grupoStatus(d.status) === 'rejeitado').length;

    this.animarNumero('total-devolucoes', total);
    this.animarNumero('pendentes-count', pend);
    this.animarNumero('aprovadas-count', aprov);
    this.animarNumero('rejeitadas-count', rej);

    this.setTxt('badge-todos', total);
    this.setTxt('badge-pendente', pend);
    this.setTxt('badge-aprovado', aprov);
    this.setTxt('badge-rejeitado', rej);
  }

  grupoStatus(status) {
    const s = String(status || '').toLowerCase();
    if (this.STATUS_GRUPOS.aprovado.has(s)) return 'aprovado';
    if (this.STATUS_GRUPOS.rejeitado.has(s)) return 'rejeitado';
    if (this.STATUS_GRUPOS.finalizado.has(s)) return 'finalizado';
    if (this.STATUS_GRUPOS.pendente.has(s)) return 'pendente';
    return 'pendente';
  }

  exportar() {
    const rows = this.items.map((d) => ({
      ID: d.id,
      'Número do Pedido': d.id_venda || '',
      Cliente: d.cliente_nome || '',
      Loja: d.loja_nome || '',
      SKU: d.sku || '',
      Status: d.status || '',
      'Etapa (log_status)': d.log_status || '',
      'Criado em': d.created_at,
      'Valor produto': d.valor_produto ?? '',
      'Valor frete': d.valor_frete ?? ''
    }));
    const csv = this.toCSV(rows);
    this.downloadCSV(csv, 'devolucoes.csv');
    this.toast('Exportado', 'Arquivo CSV gerado.', 'sucesso');
  }

  // --------------- Util ---------------
  dataBr(s) { try { return new Date(s).toLocaleDateString('pt-BR'); } catch { return '—'; } }
  setTxt(id, val) { const el = document.getElementById(id); if (el) el.textContent = String(val); }
  esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c])); }

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
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  animarNumero(elementId, valorFinal) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const dur = 600; const t0 = performance.now();
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      el.textContent = String(Math.round(valorFinal * p));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  syncTabsUI(statusAtual = (this.filtros.status || 'todos').toLowerCase()) {
    const tabs = document.querySelectorAll('.tab-filtro[role="tab"]');
    tabs.forEach((tab) => {
      const st = (tab.dataset.status || '').toLowerCase();
      const ativo = st === statusAtual;
      tab.classList.toggle('active', ativo);
      tab.setAttribute('aria-selected', ativo ? 'true' : 'false');
      tab.setAttribute('tabindex', ativo ? '0' : '-1');
    });
    const temAtivo = Array.from(tabs).some((t) => t.getAttribute('aria-selected') === 'true');
    if (!temAtivo) {
      const all = document.querySelector('.tab-filtro[data-status="todos"]');
      if (all) { all.classList.add('active'); all.setAttribute('aria-selected', 'true'); all.setAttribute('tabindex', '0'); }
    }
    this.atualizarKpis();
  }

  toast(titulo, descricao, tipo = 'sucesso') {
    const toast = document.getElementById('toast');
    const t = document.getElementById('toast-titulo');
    const d = document.getElementById('toast-descricao');
    if (!toast || !t || !d) return;

    t.textContent = titulo; d.textContent = descricao;
    const wrap = toast.querySelector('.toast-icone');
    const svg = wrap?.querySelector('svg');
    if (wrap && svg) {
      if (tipo === 'erro') {
        wrap.style.background = 'var(--destructive)';
        svg.innerHTML = '<path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 1 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>';
      } else {
        wrap.style.background = 'var(--secondary)';
        svg.innerHTML = '<path d="M10.97 4.97a.235.235 0 0 0-.02.022L7.477 9.417 5.384 7.323a.75.75 0 0 0-1.06 1.061L6.97 11.03a.75.75 0 0 0 1.079-.02l3.992-4.99a.75.75 0 0 0-1.071-1.05z"/>';
      }
    }
    toast.style.display = 'block';
    setTimeout(() => { toast.style.display = 'none'; }, 3800);
  }
}

// Bootstrap
document.addEventListener('DOMContentLoaded', () => {
  window.devolucoesFeed = new DevolucoesFeed();
});
