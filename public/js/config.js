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
  const initML = () => {
    const statusEl = document.getElementById('ml-status');
    const btnConnect = document.getElementById('btn-connect-ml');
    const btnSync = document.getElementById('btn-sync-ml');

    if (!statusEl) return; // Se não estiver na tela, ignora

    // A. Verifica retorno do Login (Query Params)
    const params = new URLSearchParams(window.location.search);
    if (params.get('status') === 'connected') {
      showToast('Conectado!', 'Integração realizada com sucesso.', 'success');
      window.history.replaceState({}, document.title, window.location.pathname); // Limpa URL
    }
    if (params.get('error')) {
      showToast('Erro', 'Falha na conexão: ' + params.get('error'), 'error');
    }

    // B. Verifica Status na API
    fetch('/api/auth/ml/status')
      .then(r => r.json())
      .then(data => {
        if (data.connected) {
          statusEl.textContent = `🟢 Conectado: ${data.nickname}`;
          statusEl.style.color = 'var(--secondary)'; // Verde do seu tema
          
          // Transforma botão de conectar em "Trocar Conta"
          btnConnect.textContent = 'Trocar Conta';
          btnConnect.classList.remove('btn--primary');
          btnConnect.classList.add('btn--ghost');
          
          btnSync.hidden = false;
        } else {
          statusEl.textContent = '🔴 Desconectado';
          statusEl.style.color = 'var(--destructive)'; // Vermelho
          btnSync.hidden = true;
        }
      })
      .catch(err => {
        console.error(err);
        statusEl.textContent = 'Erro ao verificar';
      });

    // C. Botão Sincronizar
    if (btnSync) {
      btnSync.addEventListener('click', () => {
        btnSync.textContent = 'Sincronizando...';
        btnSync.disabled = true;
        
        fetch('/api/ml/returns/sync?days=30')
          .then(r => r.json())
          .then(res => {
            if(res.ok) showToast('Sucesso', `Sincronização iniciada!`, 'success');
            else throw new Error(res.error || 'Erro desconhecido');
          })
          .catch(err => showToast('Erro', err.message, 'error'))
          .finally(() => {
            btnSync.textContent = 'Sincronizar Agora';
            btnSync.disabled = false;
          });
      });
    }
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