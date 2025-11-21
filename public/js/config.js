// public/js/config.js
document.addEventListener("DOMContentLoaded", () => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ============ HELPERS ============
  const showToast = (titulo, msg, tipo = 'info') => {
    const t = document.getElementById("toast");
    if (!t) return;
    const cssClass = tipo === 'success' ? 'toast-success' : (tipo === 'error' ? 'toast-error' : '');
    t.querySelector("strong").textContent = titulo;
    t.querySelector("div").textContent = msg;
    t.className = `toast show ${cssClass}`;
    setTimeout(() => t.classList.remove("show"), 4000);
  };

  // ============ 1. NAVEGAÇÃO POR ABAS ============
  const links = $$(".item-menu");
  const panes = $$(".config-pane");

  function ativarAba(targetId) {
    links.forEach(l => l.classList.remove("ativo"));
    panes.forEach(p => p.classList.remove("active"));
    const link = document.querySelector(`.item-menu[data-target="${targetId}"]`);
    const pane = document.getElementById(targetId);
    if (link) link.classList.add("ativo");
    if (pane) pane.classList.add("active");
  }

  links.forEach(link => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      ativarAba(link.dataset.target);
    });
  });

  // ============ 2. INTEGRAÇÃO MERCADO LIVRE (MULTI-CONTA) ============
  const initML = () => {
    const statusEl = document.getElementById('ml-status');
    const btnConnect = document.getElementById('btn-connect-ml');
    const btnSync = document.getElementById('btn-sync-ml');
    const btnShowStores = document.getElementById('btn-show-stores');
    
    // Modal
    const dlgStores = document.getElementById('dlg-stores');
    const listContainer = document.getElementById('stores-list-container');
    const btnCloseStores = document.getElementById('close-stores');

    // [NOVO] Botão de adicionar dentro do modal
    const btnAddInsideModal = dlgStores ? dlgStores.querySelector('a.btn--primary') : null;

    if (!statusEl) return;

    // --- Lógica para adicionar nova conta (Evitar loop de login) ---
    const handleAddAccount = (e) => {
      e.preventDefault(); // Pára o link
      const confirmMsg = 
        "⚠️ Importante:\n\n" +
        "Para adicionar uma conta DIFERENTE, você precisa estar deslogado do Mercado Livre neste navegador.\n\n" +
        "Se você já estiver logado, o sistema vai reconectar a mesma conta automaticamente.\n\n" +
        "Dica: Use uma Janela Anônima se preferir.\n\n" +
        "Clique em OK para continuar.";
      
      if(confirm(confirmMsg)) {
        window.location.href = '/api/auth/ml/login';
      }
    };

    if(btnAddInsideModal) {
      btnAddInsideModal.addEventListener('click', handleAddAccount);
    }

    // --- Carregar Lista no Modal ---
    const loadAndShowStores = async () => {
      if(dlgStores.showModal) dlgStores.showModal(); else dlgStores.removeAttribute('hidden');
      listContainer.innerHTML = '<div style="text-align:center;padding:1rem;color:#64748b;">Carregando...</div>';

      try {
        const r = await fetch('/api/auth/ml/list');
        const data = await r.json();
        const accounts = data.accounts || [];

        if (accounts.length === 0) {
          listContainer.innerHTML = '<div style="text-align:center; padding:2rem; color:#64748b;">Nenhuma loja conectada.</div>';
          return;
        }

        listContainer.innerHTML = accounts.map(acc => `
          <div style="display:flex; justify-content:space-between; align-items:center; background:#f8fafc; padding:0.75rem 1rem; border-radius:8px; border:1px solid #e2e8f0;">
            <div style="display:flex; align-items:center; gap:0.75rem;">
              <div style="width:32px; height:32px; background:#fff; border:1px solid #e2e8f0; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:12px;">🛍️</div>
              <div>
                <div style="font-weight:600; color:#334155; font-size:0.9rem;">${acc.nickname}</div>
                <div style="font-size:0.75rem; color:#94a3b8;">ID: ${acc.user_id}</div>
              </div>
            </div>
            <button class="btn-remove-account" data-id="${acc.user_id}" title="Desconectar" style="background:none; border:none; color:#ef4444; cursor:pointer; padding:4px;">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        `).join('');

        // Bind remover
        document.querySelectorAll('.btn-remove-account').forEach(btn => {
          btn.addEventListener('click', async (e) => {
            const id = e.currentTarget.dataset.id;
            if(!confirm("Desconectar esta loja? O sistema vai parar de baixar as vendas dela.")) return;
            try {
              const r = await fetch(`/api/auth/ml/disconnect/${id}`, { method: 'POST' });
              if (r.ok) { showToast("Loja desconectada.", "success"); loadAndShowStores(); checkGlobalStatus(); }
            } catch (err) { showToast("Erro ao desconectar", "error"); }
          });
        });

      } catch (error) {
        listContainer.innerHTML = `<div style="color:red;text-align:center;">Erro ao carregar lista.</div>`;
      }
    };

    // --- Status Global do Card ---
    const checkGlobalStatus = async () => {
      try {
        const r = await fetch('/api/auth/ml/list'); 
        const data = await r.json();
        const count = data.accounts ? data.accounts.length : 0;

        if (count > 0) {
          statusEl.textContent = `${count} loja(s) conectada(s)`;
          statusEl.className = "ml-pill ok"; 
          statusEl.style.color = "var(--secondary)";
          
          // [MUDANÇA] Botão principal vira atalho pro Modal
          btnConnect.textContent = "Gerenciar Lojas"; 
          btnConnect.removeAttribute('href'); // Remove o link direto
          btnConnect.style.cursor = 'pointer';
          btnConnect.onclick = (e) => { e.preventDefault(); loadAndShowStores(); }; // Abre modal

          btnConnect.classList.remove("btn--primary");
          btnConnect.classList.add("btn--ghost");

          btnSync.hidden = false;
          btnShowStores.hidden = true; // Esconde o duplicado, já que o principal faz isso agora
        } else {
          statusEl.textContent = "Desconectado";
          statusEl.className = "ml-pill off";
          statusEl.style.color = "";
          
          // Volta ao normal se estiver vazio
          btnConnect.textContent = "Conectar";
          btnConnect.href = "/api/auth/ml/login"; // Restaura link
          btnConnect.onclick = null; // Remove click handler do modal
          
          btnConnect.classList.add("btn--primary");
          btnConnect.classList.remove("btn--ghost");
          
          btnSync.hidden = true;
          btnShowStores.hidden = true;
        }
      } catch (e) {
        statusEl.textContent = "Erro de conexão";
      }
    };

    // Listeners
    if (btnShowStores) btnShowStores.addEventListener('click', loadAndShowStores);
    if (btnCloseStores) btnCloseStores.addEventListener('click', () => { if(dlgStores.close) dlgStores.close(); else dlgStores.setAttribute('hidden', ''); });
    
    if (btnSync) {
       btnSync.addEventListener('click', async () => {
        btnSync.disabled = true;
        btnSync.textContent = "...";
        try {
          const r = await fetch('/api/ml/returns/sync?days=30');
          if (r.ok) showToast("Sincronização iniciada!", "Processando...", "success");
        } catch(e) { showToast("Erro", "Falha ao sincronizar", "error"); }
        finally { setTimeout(() => { btnSync.disabled = false; btnSync.textContent = "Sincronizar Agora"; }, 2000); }
       });
    }

    // Check params retorno login
    const params = new URLSearchParams(window.location.search);
    if (params.get('status') === 'connected') {
      showToast('Sucesso', 'Loja conectada!', 'success');
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    checkGlobalStatus();
  };

  initML();

  // ============ 3. FORMULÁRIOS LOCAIS ============
  const formEmpresa = document.getElementById("form-empresa");
  if (formEmpresa) {
    const dadosSalvos = JSON.parse(localStorage.getItem("rf_config_empresa") || "{}");
    Object.keys(dadosSalvos).forEach(key => { if (formEmpresa.elements[key]) formEmpresa.elements[key].value = dadosSalvos[key]; });
    formEmpresa.addEventListener("submit", (e) => {
      e.preventDefault();
      localStorage.setItem("rf_config_empresa", JSON.stringify(Object.fromEntries(new FormData(formEmpresa))));
      showToast("Salvo", "Dados atualizados.", "success");
    });
  }

  const formRegras = document.getElementById("form-regras");
  if (formRegras) {
    const regrasSalvas = JSON.parse(localStorage.getItem("rf_config_regras") || "{}");
    ["rule_rejeitado_zero", "rule_motivo_cliente_zero", "rule_cd_somente_frete"].forEach(key => {
      if (formRegras.elements[key]) formRegras.elements[key].checked = regrasSalvas[key] !== false;
    });
    formRegras.addEventListener("submit", (e) => {
      e.preventDefault();
      const dados = {};
      ["rule_rejeitado_zero", "rule_motivo_cliente_zero", "rule_cd_somente_frete"].forEach(k => dados[k] = formRegras.elements[k].checked);
      localStorage.setItem("rf_config_regras", JSON.stringify(dados));
      showToast("Salvo", "Regras atualizadas.", "success");
    });
  }

  // ============ 4. USUÁRIOS MOCK ============
  const listaUsuarios = document.getElementById("usuarios-list");
  const formUser = document.getElementById("form-add-user");
  let users = JSON.parse(localStorage.getItem("rf_users") || "[]");

  function renderUsers() {
    if (!listaUsuarios) return;
    listaUsuarios.innerHTML = users.length ? users.map((u, i) => `
      <tr><td>${u.nome}</td><td>${u.email}</td><td><span class="badge">${u.papel}</span></td><td><button class="btn btn--ghost btn--sm" onclick="window.removeUser(${i})">Remover</button></td></tr>
    `).join("") : '<tr><td colspan="4" style="text-align:center;padding:20px;color:#999;">Nenhum usuário.</td></tr>';
  }

  window.removeUser = (i) => {
    if(confirm("Remover?")) { users.splice(i, 1); localStorage.setItem("rf_users", JSON.stringify(users)); renderUsers(); }
  };

  if (formUser) {
    formUser.addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(formUser);
      users.push({ nome: fd.get("nome"), email: fd.get("email"), papel: fd.get("papel") });
      localStorage.setItem("rf_users", JSON.stringify(users));
      renderUsers();
      formUser.reset();
      showToast("Sucesso", "Usuário adicionado.", "success");
    });
    renderUsers();
  }
});