// public/js/config.js
document.addEventListener("DOMContentLoaded", () => {
  // ============ HELPERS ============
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // Toast function (Usa o elemento já existente no seu HTML)
  const showToast = (titulo, msg, tipo = 'info') => {
    const t = document.getElementById("toast");
    if (!t) return;
    
    // Mapeia tipos para classes CSS (ajuste conforme seu CSS)
    const cssClass = tipo === 'success' ? 'toast-success' : (tipo === 'error' ? 'toast-error' : '');
    
    t.querySelector("strong").textContent = titulo;
    t.querySelector("div").textContent = msg;
    t.className = `toast show ${cssClass}`; // Mantém classe base 'toast'
    
    setTimeout(() => t.classList.remove("show"), 4000);
  };

  // ============ 1. NAVEGAÇÃO POR ABAS ============
  const links = $$(".item-menu");
  const panes = $$(".config-pane");

  function ativarAba(targetId) {
    // Remove ativo de tudo
    links.forEach(l => l.classList.remove("ativo"));
    panes.forEach(p => p.classList.remove("active"));

    // Ativa o alvo
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

  // ============ 2. INTEGRAÇÃO MERCADO LIVRE ============
  // ============ INTEGRAÇÃO MERCADO LIVRE (MULTI-CONTA) ============
  const initML = () => {
    const statusEl = document.getElementById('ml-status');
    const btnConnect = document.getElementById('btn-connect-ml');
    const listContainer = document.getElementById('ml-accounts-list');

    if (!statusEl) return;

    // Função para renderizar a lista
    const renderAccounts = (accounts) => {
      if (!accounts || accounts.length === 0) {
        statusEl.textContent = "Desconectado";
        statusEl.className = "ml-pill off";
        listContainer.innerHTML = '<li style="font-size:0.9rem;color:#94a3b8;font-style:italic;">Nenhuma conta conectada.</li>';
        btnConnect.textContent = "Conectar Conta";
        return;
      }

      // Status Geral
      statusEl.textContent = `${accounts.length} conta(s) ativa(s)`;
      statusEl.className = "ml-pill ok";
      btnConnect.textContent = "Adicionar Outra Conta";

      // Renderiza lista
      listContainer.innerHTML = accounts.map(acc => `
        <li style="display:flex; justify-content:space-between; align-items:center; background:#f8fafc; padding:0.5rem 1rem; border-radius:6px; border:1px solid #e2e8f0;">
          <div style="display:flex; align-items:center; gap:0.5rem;">
            <div style="width:8px; height:8px; background:#22c55e; border-radius:50%;"></div>
            <span style="font-weight:600; color:#334155;">${acc.nickname}</span>
            <span style="font-size:0.75rem; color:#94a3b8;">(ID: ${acc.user_id})</span>
          </div>
          <button class="btn-remove-account" data-id="${acc.user_id}" style="background:none; border:none; color:#ef4444; cursor:pointer; font-size:0.85rem; font-weight:600; padding:4px 8px;">
            Desconectar
          </button>
        </li>
      `).join('');

      // Bind dos botões de remover
      document.querySelectorAll('.btn-remove-account').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const id = e.target.dataset.id;
          if(!confirm("Remover esta conta? O sistema vai parar de baixar as vendas dela.")) return;
          
          try {
            const r = await fetch(`/api/auth/ml/disconnect/${id}`, { method: 'POST' });
            if (r.ok) {
              showToast("Conta removida.", "success");
              loadAccounts(); // Recarrega a lista
            } else {
              throw new Error('Erro ao remover');
            }
          } catch (err) {
            showToast("Erro ao desconectar", "error");
          }
        });
      });
    };

    // Carregar Contas
    const loadAccounts = () => {
      fetch('/api/auth/ml/list')
        .then(r => r.json())
        .then(data => renderAccounts(data.accounts))
        .catch(err => console.error(err));
    };

    // Verifica retorno do login
    const params = new URLSearchParams(window.location.search);
    if (params.get('status') === 'connected') {
      showToast('Conta adicionada com sucesso!', 'success');
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    // Inicializa
    loadAccounts();
  };

  initML();

  // ============ 3. FORMULÁRIOS (Simulação LocalStorage) ============
  // Como ainda não criamos rotas no backend para salvar Configs de Empresa/Regras,
  // vamos salvar no navegador para não perder os dados ao recarregar.

  // --- Empresa ---
  const formEmpresa = document.getElementById("form-empresa");
  if (formEmpresa) {
    // Carregar
    const dadosSalvos = JSON.parse(localStorage.getItem("rf_config_empresa") || "{}");
    Object.keys(dadosSalvos).forEach(key => {
      if (formEmpresa.elements[key]) formEmpresa.elements[key].value = dadosSalvos[key];
    });

    // Salvar
    formEmpresa.addEventListener("submit", (e) => {
      e.preventDefault();
      const dados = Object.fromEntries(new FormData(formEmpresa));
      localStorage.setItem("rf_config_empresa", JSON.stringify(dados));
      showToast("Salvo", "Dados da empresa atualizados.", "success");
    });
  }

  // --- Regras ---
  const formRegras = document.getElementById("form-regras");
  if (formRegras) {
    // Carregar
    const regrasSalvas = JSON.parse(localStorage.getItem("rf_config_regras") || "{}");
    // Checkboxes precisam de tratamento especial
    ["rule_rejeitado_zero", "rule_motivo_cliente_zero", "rule_cd_somente_frete"].forEach(key => {
      if (formRegras.elements[key]) {
        formRegras.elements[key].checked = regrasSalvas[key] !== false; // Default true
      }
    });

    // Salvar
    formRegras.addEventListener("submit", (e) => {
      e.preventDefault();
      const dados = {};
      ["rule_rejeitado_zero", "rule_motivo_cliente_zero", "rule_cd_somente_frete"].forEach(key => {
         dados[key] = formRegras.elements[key].checked;
      });
      localStorage.setItem("rf_config_regras", JSON.stringify(dados));
      showToast("Salvo", "Regras de custo atualizadas.", "success");
    });
  }

  // ============ 4. USUÁRIOS (Mock Simples) ============
  const listaUsuarios = document.getElementById("usuarios-list");
  const formUser = document.getElementById("form-add-user");
  
  let users = JSON.parse(localStorage.getItem("rf_users") || "[]");

  function renderUsers() {
    if (!listaUsuarios) return;
    listaUsuarios.innerHTML = users.map((u, i) => `
      <tr>
        <td>${u.nome}</td>
        <td>${u.email}</td>
        <td><span class="badge">${u.papel}</span></td>
        <td><button class="btn btn--ghost btn--sm" onclick="removeUser(${i})">Remover</button></td>
      </tr>
    `).join("");
    
    if (users.length === 0) {
      listaUsuarios.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px; color:#999;">Nenhum usuário adicional.</td></tr>';
    }
  }

  // Expor função globalmente para o onclick funcionar no HTML gerado
  window.removeUser = (index) => {
    if(confirm("Remover este usuário?")) {
      users.splice(index, 1);
      localStorage.setItem("rf_users", JSON.stringify(users));
      renderUsers();
    }
  };

  if (formUser) {
    formUser.addEventListener("submit", (e) => {
      e.preventDefault();
      const formData = new FormData(formUser);
      users.push({
        nome: formData.get("nome"),
        email: formData.get("email"),
        papel: formData.get("papel")
      });
      localStorage.setItem("rf_users", JSON.stringify(users));
      renderUsers();
      formUser.reset();
      showToast("Sucesso", "Usuário adicionado.", "success");
    });
    renderUsers();
  }

});