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

  // ============ 2. INTEGRAÇÃO MERCADO LIVRE (MODAL) ============
  const initML = () => {
    // Elementos do Card Principal
    const statusEl = document.getElementById('ml-status');
    const btnConnect = document.getElementById('btn-connect-ml');
    const btnSync = document.getElementById('btn-sync-ml');
    const btnShowStores = document.getElementById('btn-show-stores');
    
    // Elementos do Modal
    const dlgStores = document.getElementById('dlg-stores');
    const listContainer = document.getElementById('stores-list-container');
    const btnCloseStores = document.getElementById('close-stores');

    if (!statusEl) return;

    // --- Lógica do Botão "Adicionar Nova Loja" (Dentro do Modal) ---
    const bindAddButton = () => {
      // Procura o botão de adicionar dentro do modal (é um <a>)
      const btnAdd = dlgStores.querySelector('a.btn--primary');
      if (btnAdd) {
        btnAdd.onclick = (e) => {
          e.preventDefault();
          const msg = "⚠️ ATENÇÃO: MÚLTIPLAS CONTAS\n\n" +
                      "O Mercado Livre memoriza seu login anterior.\n\n" +
                      "Para conectar uma conta DIFERENTE:\n" +
                      "1. Clique em Cancelar.\n" +
                      "2. Abra uma JANELA ANÔNIMA.\n" +
                      "3. Logue no sistema e adicione por lá.\n\n" +
                      "Se continuar aqui, você pode acabar reconectando a mesma conta.";
          
          if (confirm(msg)) {
            window.location.href = '/api/auth/ml/login';
          }
        };
      }
    };

    // --- Renderiza Lista no Modal ---
    const renderModalList = (accounts) => {
      if (!accounts || accounts.length === 0) {
        listContainer.innerHTML = '<div style="text-align:center; padding:2rem; color:#94a3b8;">Nenhuma loja conectada.</div>';
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
             Desconectar
          </button>
        </div>
      `).join('');

      // Bind Delete
      listContainer.querySelectorAll('.btn-remove-account').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          if(!confirm("Desconectar esta loja?")) return;
          try {
            await fetch(`/api/auth/ml/disconnect/${e.target.dataset.id}`, { method: 'POST' });
            showToast("Removido", "Loja desconectada.", "success");
            refreshData(); // Recarrega tudo
          } catch (err) { showToast("Erro", "Falha ao remover", "error"); }
        });
      });
    };

    // --- Atualiza Card Principal ---
    const updateMainCard = (accounts) => {
      if (accounts.length > 0) {
        // Conectado
        statusEl.textContent = `${accounts.length} loja(s) conectada(s)`;
        statusEl.className = "ml-pill ok"; // Requer CSS .ml-pill.ok
        statusEl.style.color = "var(--secondary)";
        
        btnConnect.hidden = true;      // Esconde botão "Conectar"
        btnShowStores.hidden = false;  // Mostra botão "Minhas Lojas"
        btnSync.hidden = false;        // Mostra botão "Sincronizar"
      } else {
        // Desconectado
        statusEl.textContent = "Desconectado";
        statusEl.className = "ml-pill off";
        statusEl.style.color = "";
        
        btnConnect.hidden = false;
        btnShowStores.hidden = true;
        btnSync.hidden = true;
      }
    };

    // --- Fluxo de Carga de Dados ---
    const refreshData = async () => {
      try {
        const r = await fetch('/api/auth/ml/list');
        const data = await r.json();
        const accounts = data.accounts || [];
        
        updateMainCard(accounts);
        renderModalList(accounts);
      } catch (e) { console.error(e); }
    };

    // --- Eventos ---
    // 1. Abrir Modal
    if (btnShowStores) {
      btnShowStores.addEventListener('click', () => {
        refreshData(); // Atualiza lista antes de abrir
        if(dlgStores.showModal) dlgStores.showModal(); else dlgStores.removeAttribute('hidden');
        bindAddButton(); // Garante que o botão de add tenha o evento
      });
    }

    // 2. Fechar Modal
    if (btnCloseStores) {
      btnCloseStores.addEventListener('click', () => {
        if(dlgStores.close) dlgStores.close(); else dlgStores.setAttribute('hidden', '');
      });
    }

    // 3. Sincronizar
    if (btnSync) {
      btnSync.addEventListener('click', async () => {
        btnSync.disabled = true;
        btnSync.textContent = "...";
        await fetch('/api/ml/returns/sync?days=30').catch(()=>{});
        showToast("Sincronizando", "Buscando dados...", "success");
        setTimeout(() => { btnSync.disabled = false; btnSync.textContent = "Sincronizar Agora"; }, 3000);
      });
    }

    // Init
    refreshData();
    
    // Feedback Login
    if (new URLSearchParams(location.search).get('status') === 'connected') {
      showToast("Sucesso", "Loja conectada!", "success");
      history.replaceState({}, document.title, location.pathname);
    }
  };

  initML();

  // ============ 3. FORMULÁRIOS LOCAIS (Empresa/Regras/Usuários) ============
  // (Mantido igual ao anterior para não quebrar as outras abas)
  const formEmpresa = document.getElementById("form-empresa");
  if (formEmpresa) {
    const dados = JSON.parse(localStorage.getItem("rf_config_empresa") || "{}");
    Object.keys(dados).forEach(k => { if(formEmpresa.elements[k]) formEmpresa.elements[k].value = dados[k]; });
    formEmpresa.addEventListener("submit", (e) => {
      e.preventDefault();
      localStorage.setItem("rf_config_empresa", JSON.stringify(Object.fromEntries(new FormData(formEmpresa))));
      showToast("Salvo", "Dados da empresa atualizados.", "success");
    });
  }

  const formRegras = document.getElementById("form-regras");
  if (formRegras) {
    const regras = JSON.parse(localStorage.getItem("rf_config_regras") || "{}");
    ["rule_rejeitado_zero", "rule_motivo_cliente_zero", "rule_cd_somente_frete"].forEach(k => {
      if (formRegras.elements[k]) formRegras.elements[k].checked = regras[k] !== false;
    });
    formRegras.addEventListener("submit", (e) => {
      e.preventDefault();
      const d = {};
      ["rule_rejeitado_zero", "rule_motivo_cliente_zero", "rule_cd_somente_frete"].forEach(k => d[k] = formRegras.elements[k].checked);
      localStorage.setItem("rf_config_regras", JSON.stringify(d));
      showToast("Salvo", "Regras atualizadas.", "success");
    });
  }

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