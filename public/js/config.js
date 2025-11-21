document.addEventListener("DOMContentLoaded", () => {
  const $ = (sel) => document.querySelector(sel);
  
  // Toast Helper
  const showToast = (titulo, msg, type) => {
    const t = document.getElementById("toast");
    t.querySelector("strong").innerText = titulo;
    t.querySelector("div").innerText = msg;
    t.className = `toast show toast-${type}`;
    setTimeout(() => t.classList.remove("show"), 4000);
  };

  // ============ MERCADO LIVRE MULTI-CONTAS ============
  const initML = () => {
    const listContainer = document.getElementById('ml-accounts-list');
    const statusEl = document.getElementById('ml-status');
    const btnAdd = document.getElementById('btn-add-account');
    const btnSync = document.getElementById('btn-sync-ml');

    if (!listContainer) return;

    // 1. Renderiza a lista igual sua foto
    const renderList = (accounts) => {
      if (!accounts || accounts.length === 0) {
        statusEl.textContent = "Nenhuma conta";
        statusEl.className = "ml-pill off";
        listContainer.innerHTML = '<li style="padding:10px; color:#94a3b8;">Nenhuma conta conectada.</li>';
        return;
      }

      statusEl.textContent = `${accounts.length} conta(s) ativa(s)`;
      statusEl.className = "ml-pill ok";
      statusEl.style.color = "var(--secondary)";
      btnSync.hidden = false;

      listContainer.innerHTML = accounts.map(acc => `
        <li class="ml-account-item">
          <div class="ml-acc-info">
            <div class="ml-acc-avatar">${acc.nickname.charAt(0).toUpperCase()}</div>
            <div>
              <div style="font-weight:600; color:#334155;">${acc.nickname}</div>
              <div style="font-size:0.75rem; color:#64748b;">ID: ${acc.user_id}</div>
            </div>
          </div>
          <div class="ml-acc-actions">
            <button onclick="disconnectAccount('${acc.user_id}')" title="Remover conta">Desconectar</button>
          </div>
        </li>
      `).join('');
    };

    // 2. Carrega dados
    const loadAccounts = async () => {
      try {
        const r = await fetch('/api/auth/ml/list');
        const data = await r.json();
        renderList(data.accounts);
      } catch (e) { console.error(e); }
    };

    // 3. Função Global de Desconectar (para o HTML acessar)
    window.disconnectAccount = async (id) => {
      if (!confirm("Remover esta conta? As devoluções dela pararão de sincronizar.")) return;
      try {
        await fetch(`/api/auth/ml/disconnect/${id}`, { method: 'POST' });
        showToast("Conta removida", "", "success");
        loadAccounts();
      } catch (e) { showToast("Erro", "Falha ao remover", "error"); }
    };

    // 4. Adicionar Nova Conta (COM ALERTA)
    btnAdd.addEventListener('click', (e) => {
      e.preventDefault();
      
      // O segredo: Avisar o usuário antes de ir
      const msg = "⚠️ ATENÇÃO: MULTI-CONTAS\n\n" +
                  "Se você já está logado no Mercado Livre com uma conta, ele vai reconectar a MESMA conta automaticamente.\n\n" +
                  "Para adicionar uma conta NOVA:\n" +
                  "1. Clique em Cancelar.\n" +
                  "2. Abra uma Janela Anônima.\n" +
                  "3. Logue neste sistema e clique em Adicionar Conta lá.\n\n" +
                  "Deseja continuar mesmo assim?";
      
      if (confirm(msg)) {
        window.location.href = '/api/auth/ml/login';
      }
    });

    // 5. Sincronizar
    btnSync.addEventListener('click', async () => {
      btnSync.disabled = true;
      btnSync.textContent = "...";
      await fetch('/api/ml/returns/sync?days=30');
      showToast("Sincronizando...", "O sistema está baixando as vendas de todas as contas.", "success");
      setTimeout(() => { btnSync.disabled = false; btnSync.textContent = "Sincronizar Agora"; }, 3000);
    });

    // Init
    loadAccounts();
    
    // Feedback de retorno do login
    if (new URLSearchParams(location.search).get('status') === 'connected') {
      showToast("Sucesso", "Conta adicionada!", "success");
      history.replaceState({}, document.title, location.pathname);
    }
  };

  initML();
  
  // Navegação de Abas simples
  const tabs = document.querySelectorAll('.item-menu');
  tabs.forEach(t => {
    t.addEventListener('click', e => {
      e.preventDefault();
      document.querySelectorAll('.item-menu, .config-pane').forEach(el => el.classList.remove('active', 'ativo'));
      t.classList.add('ativo');
      document.getElementById(t.dataset.target).classList.add('active');
    });
  });
});