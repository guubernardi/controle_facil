// public/js/config.js
document.addEventListener("DOMContentLoaded", () => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ============ TOAST HELPER ============
  const toast = (msg, type = "info") => {
    const t = document.getElementById("toast");
    if (!t) return;
    t.querySelector("strong").textContent = type === 'success' ? 'Sucesso' : 'Atenção';
    t.querySelector("div").textContent = msg;
    t.className = `toast show toast-${type}`; // requer CSS toast-success/error
    setTimeout(() => t.classList.remove("show"), 3000);
  };

  // ============ ROTEAMENTO DE ABAS ============
  const panes = $$(".config-pane");
  const links = $$(".item-menu");

  function showTab(id) {
    panes.forEach(p => p.classList.remove("active"));
    links.forEach(l => l.classList.remove("ativo"));
    
    const target = document.getElementById(id);
    const link = document.querySelector(`[data-target="${id}"]`);
    
    if (target) target.classList.add("active");
    if (link) link.classList.add("ativo");
  }

  links.forEach(l => {
    l.addEventListener("click", (e) => {
      e.preventDefault();
      showTab(l.dataset.target);
    });
  });

  // ============ INTEGRAÇÃO MERCADO LIVRE ============
  async function initML() {
    const statusEl = $("#ml-status");
    const btnConnect = $("#btn-connect-ml");
    const btnSync = $("#btn-sync-ml");
    const card = $("#ml-card");

    if (!statusEl) return;

    // 1. Checa status no Backend
    try {
      const res = await fetch('/api/auth/ml/status'); // Rota corrigida
      const data = await res.json();

      if (data.connected) {
        statusEl.textContent = `Conectado: ${data.nickname}`;
        statusEl.className = "ml-pill ok"; // CSS verde
        
        btnConnect.textContent = "Trocar Conta";
        btnConnect.classList.remove("btn--primary");
        btnConnect.classList.add("btn--ghost");
        
        btnSync.hidden = false;
        
        // Auto-sync se voltar do login
        if (new URLSearchParams(location.search).get('status') === 'connected') {
          toast("Integração realizada com sucesso!", "success");
          window.history.replaceState({}, document.title, location.pathname);
        }
      } else {
        statusEl.textContent = "Desconectado";
        statusEl.className = "ml-pill off"; // CSS cinza
        btnSync.hidden = true;
      }
    } catch (e) {
      console.warn("Erro ao checar ML:", e);
      statusEl.textContent = "Erro de conexão";
    }

    // 2. Botão de Sincronização Manual
    if (btnSync) {
      btnSync.addEventListener("click", async () => {
        btnSync.disabled = true;
        btnSync.textContent = "Sincronizando...";
        
        try {
          const r = await fetch('/api/ml/returns/sync?days=30');
          const res = await r.json();
          
          if (res.ok) {
            toast(`Sincronização iniciada! ${res.total || 0} registros processados.`, "success");
          } else {
            throw new Error(res.error || "Erro desconhecido");
          }
        } catch (e) {
          toast("Falha na sincronização: " + e.message, "error");
        } finally {
          btnSync.disabled = false;
          btnSync.textContent = "Sincronizar Agora";
        }
      });
    }
  }

  // ============ SALVAMENTO GENÉRICO (Ctrl+S) ============
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      toast("Salvando configurações...", "info");
      // Aqui você pode adicionar a lógica de salvar os formulários de Empresa/Regras
    }
  });

  // Inicializa
  initML();
});