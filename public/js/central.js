// public/js/central.js
'use strict';

class LogisticsPanel {
  constructor() {
    // Estado local
    this.todayItems = [];
    this.delayedItems = [];
    this.receivedToday = [];
    
    this.refreshInterval = 60 * 1000; // 1 min
    this.scannerInput = document.getElementById('scanner-input');
    
    this.init();
  }

  init() {
    this.bindEvents();
    this.loadKanbanData();
    
    // Refresh automático silencioso
    setInterval(() => this.loadKanbanData(), this.refreshInterval);
    
    // Foco automático no scanner ao carregar
    if (this.scannerInput) this.scannerInput.focus();
  }

  bindEvents() {
    // 1. Scanner (Input Principal)
    if (this.scannerInput) {
      this.scannerInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const term = this.scannerInput.value.trim();
          if (term) this.handleScan(term);
          this.scannerInput.value = ''; // Limpa para o próximo
        }
      });
    }

    // 2. Botão Buscar Manual
    document.getElementById('btn-buscar-manual')?.addEventListener('click', () => {
      const term = this.scannerInput.value.trim();
      if (term) this.handleScan(term);
      this.scannerInput.value = '';
    });

    // 3. Modal Scanner (Ações)
    document.getElementById('scan-btn-ok')?.addEventListener('click', () => this.processReception(true));
    document.getElementById('scan-btn-fail')?.addEventListener('click', () => this.processReception(false));
    
    // Fechar modal
    const dlg = document.getElementById('dlg-scan-result');
    dlg?.addEventListener('close', () => {
      if(this.scannerInput) this.scannerInput.focus(); // Volta o foco pro scanner
    });
    document.getElementById('scan-close')?.addEventListener('click', () => dlg.close());
  }

  // ===== CARGA DE DADOS =====

  async loadKanbanData() {
    try {
      // Busca paralela para popular as colunas
      // Nota: Ajuste as queries conforme sua API real
      const [todayRes, delayedRes, doneRes] = await Promise.all([
        // Coluna 1: Chegando Hoje (shipped + previsão hoje ou sem data futura)
        fetch('/api/returns?status=em_transporte&limit=50').then(r => r.json()),
        
        // Coluna 2: Atrasados (shipped + data passada) ou Problema (disputa)
        fetch('/api/returns?status=disputa&limit=20').then(r => r.json()), // Simplificado
        
        // Coluna 3: Recebidos Hoje
        fetch('/api/returns?status=concluida&limit=20').then(r => r.json())
      ]);

      this.todayItems = todayRes.items || [];
      this.delayedItems = delayedRes.items || [];
      this.receivedToday = doneRes.items || [];

      this.renderKanban();
      this.updateStats();

    } catch (e) {
      console.error('Erro ao carregar Kanban:', e);
    }
  }

  renderKanban() {
    this.renderColumn('list-today', this.todayItems, 'tag-blue');
    this.renderColumn('list-delayed', this.delayedItems, 'tag-red');
    this.renderColumn('list-done', this.receivedToday, 'tag-green');
  }

  renderColumn(containerId, items, tagClass) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (items.length === 0) {
      container.innerHTML = `<div class="empty-state-mini">Vazio</div>`;
      return;
    }

    container.innerHTML = items.map(item => `
      <div class="card-mini ${tagClass}" onclick="window.LogisticsApp.openItem('${item.id}')">
        <div class="mini-header">
          <span class="mini-id">#${item.id_venda || item.id}</span>
          <span class="mini-time">${this.formatTime(item.updated_at)}</span>
        </div>
        <div class="mini-title" title="${item.sku}">
          ${item.sku || 'Produto sem SKU'}
        </div>
        <div class="mini-sub">
          ${item.cliente_nome ? item.cliente_nome.split(' ')[0] : 'Cliente'} • ${item.loja_nome || 'ML'}
        </div>
      </div>
    `).join('');
  }

  // ===== LÓGICA DO SCANNER =====

  async handleScan(term) {
    // Abre modal de loading
    const dlg = document.getElementById('dlg-scan-result');
    const body = document.getElementById('scan-body');
    const footer = document.getElementById('scan-footer');
    
    if(dlg.showModal) dlg.showModal(); else dlg.removeAttribute('hidden');
    
    body.innerHTML = '<div class="scan-loading">Buscando pacote...</div>';
    footer.hidden = true;

    try {
      // Busca inteligente (tenta ID interno, ID Venda ou Rastreio)
      // Sua API precisa suportar busca por q=termo
      const res = await fetch(`/api/returns?search=${encodeURIComponent(term)}&limit=1`);
      const json = await res.json();
      const item = json.items && json.items[0];

      if (!item) {
        body.innerHTML = `
          <div style="text-align:center; color:var(--log-red); padding:1rem;">
            <h3>❌ Não encontrado</h3>
            <p>O código <strong>${term}</strong> não retornou nenhuma devolução.</p>
            <p style="font-size:0.9rem; margin-top:1rem">Tente sincronizar o ML ou verifique o código.</p>
          </div>
        `;
        return;
      }

      // Salva item atual no contexto para ação
      this.currentItem = item;

      // Renderiza resultado do scan
      body.innerHTML = `
        <div class="scan-result-ok">
           <h4>Pacote Identificado!</h4>
           <span class="scan-sku">${item.sku || 'SEM SKU'}</span>
           <p>${item.cliente_nome || 'Cliente Desconhecido'}</p>
           <div style="background:#f1f5f9; padding:0.5rem; border-radius:0.5rem; margin-top:1rem; font-size:0.9rem;">
             <strong>Motivo:</strong> ${item.ml_return_status || item.status}
           </div>
        </div>
      `;
      footer.hidden = false;
      
      // Foca no botão de confirmar
      setTimeout(() => document.getElementById('scan-btn-ok').focus(), 100);

    } catch (e) {
      body.innerHTML = `<div style="color:red; text-align:center">Erro de conexão: ${e.message}</div>`;
    }
  }

  async processReception(isOk) {
    if (!this.currentItem) return;
    
    const dlg = document.getElementById('dlg-scan-result');
    const item = this.currentItem;
    
    // Fecha modal visualmente (otimismo)
    dlg.close();

    try {
      // 1. Registra recebimento
      const now = new Date().toISOString();
      await fetch(`/api/returns/${item.id}/cd/receive`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          responsavel: 'Scanner', 
          when: now, 
          updated_by: 'scanner-app' 
        })
      });

      // 2. Atualiza status (Conclui ou Disputa)
      const patch = isOk 
        ? { status: 'concluida', log_status: 'aprovado_cd' }
        : { status: 'disputa', log_status: 'reprovado_cd' };

      await fetch(`/api/returns/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      });

      this.showToast('Sucesso', `Pacote ${item.id_venda} processado!`, 'success');
      
      // Recarrega listas
      this.loadKanbanData();

    } catch (e) {
      this.showToast('Erro', 'Falha ao salvar recebimento', 'error');
      console.error(e);
    }
  }

  // ===== UTILS =====
  
  updateStats() {
    document.getElementById('count-today').textContent = this.todayItems.length;
    document.getElementById('count-delayed').textContent = this.delayedItems.length;
  }

  formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  showToast(title, msg, type) {
    const t = document.getElementById('toast');
    if(!t) return;
    t.innerHTML = `<div class="toast-content"><strong>${title}</strong><div>${msg}</div></div>`;
    t.className = `toast show toast-${type}`; // Exige CSS toast-success/error
    setTimeout(() => t.classList.remove('show'), 3000);
  }

  // Helper global para onclick no HTML
  openItem(id) {
    window.location.href = `devolucao-editar.html?id=${id}`;
  }
}

// Inicialização
window.addEventListener('DOMContentLoaded', () => {
  window.LogisticsApp = new LogisticsPanel();
});