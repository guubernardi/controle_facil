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
    const listContainer = document.getElementById('ml-accounts-list');
    const statusEl = document.getElementById('ml-status');
    const btnAdd = document.getElementById('btn-add-account');
    const btnSync = document.getElementById('btn-sync-ml');

    if (!listContainer) return;

    // --- Renderiza Lista ---
    const renderList = (accounts) => {
      if (!accounts || accounts.length === 0) {
        statusEl.textContent = "Nenhuma conta";
        statusEl.className = "ml-pill off";
        listContainer.innerHTML = '<li style="padding:10px; color:#94a3b8; font-style:italic;">Nenhuma conta conectada.</li>';
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
            <button onclick="window.disconnectAccount('${acc.user_id}')" title="Remover conta">Desconectar</button>
          </div>
        </li>
      `).join('');
    };

    // --- Carrega Dados ---
    const loadAccounts = async () => {
      try {
        const r = await fetch('/api/auth/ml/list');
        const data = await r.json();
        renderList(data.accounts);
      } catch (e) { console.error(e); }
    };

    // --- Função Global de Desconectar ---
    window.disconnectAccount = async (id) => {
      if (!confirm("Remover esta conta? As devoluções dela pararão de sincronizar.")) return;
      try {
        await fetch(`/api/auth/ml/disconnect/${id}`, { method: 'POST' });
        showToast("Conta removida", "", "success");
        loadAccounts();
      } catch (e) { showToast("Erro", "Falha ao remover", "error"); }
    };

    // --- Adicionar Nova Conta (COM ALERTA) ---
    if (btnAdd) {
      btnAdd.addEventListener('click', (e) => {
        e.preventDefault();
        const msg = "⚠️ ATENÇÃO: MULTI-CONTAS\n\n" +
                    "Se você já está logado no Mercado Livre, ele reconectará a MESMA conta.\n\n" +
                    "Para adicionar uma NOVA conta:\n" +
                    "1. Clique em Cancelar.\n" +
                    "2. Abra uma Janela Anônima.\n" +
                    "3. Logue no sistema e clique em Adicionar lá.\n\n" +
                    "Deseja continuar mesmo assim?";
        
        if (confirm(msg)) {
          window.location.href = '/api/auth/ml/login';
        }
      });
    }

    // --- Sincronizar ---
    if (btnSync) {
      btnSync.addEventListener('click', async () => {
        btnSync.disabled = true;
        btnSync.textContent = "...";
        await fetch('/api/ml/returns/sync?days=30');
        showToast("Sincronizando...", "Baixando vendas de todas as contas.", "success");
        setTimeout(() => { btnSync.disabled = false; btnSync.textContent = "Sincronizar Agora"; }, 3000);
      });
    }

    // Init e Feedback de Login
    loadAccounts();
    if (new URLSearchParams(location.search).get('status') === 'connected') {
      showToast("Sucesso", "Conta adicionada!", "success");
      history.replaceState({}, document.title, location.pathname);
    }
  };

  initML();

  // ============ 3. FORMULÁRIOS (Locais) ============
  
  // Empresa
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

  // Regras
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

  // ============ 4. USUÁRIOS (Mock) ============
  const listaUsuarios = document.getElementById("usuarios-list");
  const formUser = document.getElementById("form-add-user");
  let users = JSON.parse(localStorage.getItem("rf_users") || "[]");

  function renderUsers() {
    if (!listaUsuarios) return;
    listaUsuarios.innerHTML = users.length ? users.map((u, i) => `
      <tr>
        <td>${u.nome}</td>
        <td>${u.email}</td>
        <td><span class="badge">${u.papel}</span></td>
        <td><button class="btn btn--ghost btn--sm" onclick="window.removeUser(${i})">Remover</button></td>
      </tr>
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