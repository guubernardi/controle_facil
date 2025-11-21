document.addEventListener("DOMContentLoaded", () => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const showToast = (titulo, msg, tipo = 'info') => {
    const t = document.getElementById("toast");
    if (!t) return;
    const css = tipo === 'success' ? 'toast-success' : (tipo === 'error' ? 'toast-error' : '');
    t.innerHTML = `<div class="toast-content"><strong>${titulo}</strong><div>${msg}</div></div>`;
    t.className = `toast show ${css}`;
    setTimeout(() => t.classList.remove("show"), 4000);
  };

  // ============ NAVEGAÇÃO ABAS ============
  $$(".item-menu").forEach(link => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      $$(".item-menu").forEach(l => l.classList.remove("ativo"));
      $$(".config-pane").forEach(p => p.classList.remove("active"));
      link.classList.add("ativo");
      const target = document.getElementById(link.dataset.target);
      if (target) target.classList.add("active");
    });
  });

  // ============ INTEGRAÇÃO ML ============
  const initML = () => {
    const statusEl = $("#ml-status");
    const btnAction = $("#btn-ml-action");
    const btnSync = $("#btn-sync-ml");
    const listContainer = $("#ml-accounts-list");
    const dlgHelp = $("#dlg-ml-help"); // Novo Modal

    if (!statusEl) return;

    // Fecha modal
    $("#close-help")?.addEventListener('click', () => dlgHelp.close());

    // --- Renderiza Lista ---
    const renderAccounts = (accounts) => {
      if (!accounts || accounts.length === 0) {
        statusEl.textContent = "Desconectado";
        statusEl.className = "ml-pill off";
        listContainer.innerHTML = '<li style="padding:10px;color:#94a3b8;font-style:italic;">Nenhuma conta.</li>';
        
        btnAction.textContent = "Conectar Conta";
        btnAction.classList.add("btn--primary");
        btnAction.classList.remove("btn--ghost");
        btnSync.hidden = true;
        return;
      }

      statusEl.textContent = `${accounts.length} conta(s)`;
      statusEl.className = "ml-pill ok";
      
      btnAction.textContent = "+ Adicionar Outra";
      btnAction.classList.remove("btn--primary");
      btnAction.classList.add("btn--ghost");
      btnSync.hidden = false;

      listContainer.innerHTML = accounts.map(acc => `
        <div class="ml-account-item">
          <div class="ml-acc-info">
            <div class="ml-acc-avatar">${acc.nickname.charAt(0).toUpperCase()}</div>
            <div>
              <div style="font-weight:600; color:#334155;">${acc.nickname}</div>
              <div style="font-size:0.75rem; color:#64748b;">ID: ${acc.user_id}</div>
            </div>
          </div>
          <div class="ml-acc-actions">
            <button onclick="window.disconnectML('${acc.user_id}')" title="Remover">Desconectar</button>
          </div>
        </div>
      `).join('');
    };

    const loadAccounts = async () => {
      try {
        const r = await fetch('/api/auth/ml/list');
        const data = await r.json();
        renderAccounts(data.accounts);
      } catch (e) { console.error(e); }
    };

    // --- Lógica do Botão ---
    btnAction.addEventListener('click', (e) => {
      e.preventDefault();
      
      // Se já tem conta, mostra o modal de ajuda
      const hasAccounts = !statusEl.classList.contains('off');
      if (hasAccounts) {
        dlgHelp.showModal ? dlgHelp.showModal() : dlgHelp.removeAttribute('hidden');
      } else {
        // Se é a primeira, vai direto
        window.location.href = '/api/auth/ml/login';
      }
    });

    btnSync.addEventListener('click', async () => {
      btnSync.disabled = true;
      btnSync.textContent = "...";
      await fetch('/api/ml/returns/sync?days=30').catch(()=>{});
      showToast("Sincronizando", "Buscando dados...", "success");
      setTimeout(() => { btnSync.disabled = false; btnSync.textContent = "Sincronizar"; }, 3000);
    });

    window.disconnectML = async (id) => {
      if (!confirm("Remover esta conta?")) return;
      try {
        await fetch(`/api/auth/ml/disconnect/${id}`, { method: 'POST' });
        showToast("Removido", "Conta desconectada.", "success");
        loadAccounts();
      } catch (e) { showToast("Erro", "Falha ao remover.", "error"); }
    };

    if (new URLSearchParams(location.search).get('status') === 'connected') {
      showToast("Sucesso", "Conta conectada!", "success");
      history.replaceState({}, document.title, location.pathname);
    }

    loadAccounts();
  };

  initML();
});