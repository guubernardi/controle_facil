// settings/config.js – roteador de abas + CRUD simples (com fallback localStorage)
document.addEventListener("DOMContentLoaded", () => {
  // ============ helpers ============
  const $  = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

  // injeta CSS mínimo p/ toast + confirm + modal [hidden]
  const ensureUiStyles = () => {
    if (document.getElementById("rf-ui-styles")) return;
    const s = document.createElement("style");
    s.id = "rf-ui-styles";
    s.textContent = `
      @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
      @keyframes fadeOut { from { opacity: 1; } to { opacity: 0; } }
      @keyframes slideUp { from { opacity: 0; transform: translateY(20px) scale(0.95); } to { opacity: 1; transform: translateY(0) scale(1); } }
      .toast-notification{position:fixed;right:20px;bottom:20px;z-index:9999;opacity:0;transform:translateY(20px) scale(0.95);transition:all .3s cubic-bezier(0.34, 1.56, 0.64, 1);color:#fff;border-radius:12px;padding:14px 18px;display:flex;gap:10px;align-items:center;backdrop-filter:blur(10px);font-weight:500;box-shadow:0 8px 24px rgba(0,0,0,0.2);}
      .toast-notification.show{opacity:1;transform:translateY(0) scale(1);}
      .toast-icon{display:flex;align-items:center;justify-content:center;width:24px;height:24px;}
      .toast-icon svg{filter:drop-shadow(0 2px 4px rgba(0,0,0,0.2));}
      .confirm-overlay{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.5);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:16px;}
      .confirm-dialog{background:#fff;border:1px solid var(--border,#e5e7eb);border-radius:16px;box-shadow:0 24px 48px rgba(0,0,0,.25);min-width:320px;max-width:92vw;padding:24px;display:flex;flex-direction:column;gap:16px;}
      .confirm-icon{display:flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:12px;background:linear-gradient(135deg,#fef3c7,#fde68a);margin:0 auto;}
      .confirm-message{font-size:15px;line-height:1.6;color:#374151;text-align:center;}
      .confirm-actions{display:flex;gap:10px;justify-content:center;margin-top:8px;}
      .btn--danger{background:linear-gradient(135deg,#ef4444,#dc2626);color:#fff;border-color:#dc2626;box-shadow:0 2px 8px rgba(239,68,68,0.3);}
      .btn--danger:hover{background:linear-gradient(135deg,#dc2626,#b91c1c);box-shadow:0 4px 16px rgba(239,68,68,0.4);}
      .spinner{display:inline-block;vertical-align:middle;margin-right:8px;}
      #ml-stores-modal [hidden]{display:none !important;}
    `;
    document.head.appendChild(s);
  };
  ensureUiStyles();

  const toast = (msg, type = "info") => {
    const existing = document.querySelector(".toast-notification");
    if (existing) existing.remove();
    const icons = { 
      success: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>', 
      error: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>', 
      warning: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>', 
      info: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>' 
    };
    const colors = {
      success: 'background: linear-gradient(135deg, #10b981 0%, #059669 100%); box-shadow: 0 8px 24px rgba(16, 185, 129, 0.4);',
      error: 'background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); box-shadow: 0 8px 24px rgba(239, 68, 68, 0.4);',
      warning: 'background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); box-shadow: 0 8px 24px rgba(245, 158, 11, 0.4);',
      info: 'background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); box-shadow: 0 8px 24px rgba(59, 130, 246, 0.4);'
    };
    const t = document.createElement("div");
    t.className = `toast-notification toast-${type}`;
    t.style = colors[type] || colors.info;
    t.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span class="toast-message">${msg}</span>`;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add("show"));
    setTimeout(() => {
      t.classList.remove("show");
      setTimeout(() => t.remove(), 300);
    }, 3000);
  };

  const esc = (s = "") =>
    String(s).replace(/[&<>"']/g, (m) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m]));

  const showLoading = (btn) => {
    if (!btn) return;
    btn.disabled = true;
    btn.dataset.originalText = btn.textContent;
    const spinner = '<svg class="spinner" width="18" height="18" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></path></svg>';
    btn.innerHTML = spinner + ' Carregando...';
    btn.style.opacity = '0.8';
  };
  const hideLoading = (btn) => {
    if (!btn) return;
    btn.disabled = false;
    btn.textContent = btn.dataset.originalText || btn.textContent;
    btn.style.opacity = '1';
  };

  const confirm = (msg) =>
    new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "confirm-overlay";
      overlay.style = 'animation: fadeIn 0.2s ease;';
      overlay.innerHTML = `
        <div class="confirm-dialog" style="animation: slideUp 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);">
          <div class="confirm-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
          </div>
          <p class="confirm-message">${msg}</p>
          <div class="confirm-actions">
            <button class="btn btn--ghost confirm-cancel">Cancelar</button>
            <button class="btn btn--danger confirm-ok">Confirmar</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const cleanup = (result) => { 
        overlay.style.animation = 'fadeOut 0.2s ease';
        setTimeout(() => overlay.remove(), 200);
        resolve(result); 
      };
      overlay.querySelector(".confirm-cancel").onclick = () => cleanup(false);
      overlay.querySelector(".confirm-ok").onclick     = () => cleanup(true);
      overlay.addEventListener("click", (e) => { if (e.target === overlay) cleanup(false); });
    });

  // -------- mini storage (API -> localStorage fallback) ----------
  const api = {
    async get(path) {
      try {
        const r = await fetch(`/api/settings${path}`);
        if (!r.ok) throw 0;
        if (r.status === 204) return null;
        const ct = r.headers.get("content-type") || "";
        return ct.includes("application/json") ? await r.json() : null;
      } catch {
        return JSON.parse(localStorage.getItem(`settings:${path}`) || "null");
      }
    },
    async put(path, payload) {
      try {
        const r = await fetch(`/api/settings${path}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!r.ok) throw 0;
        if (r.status === 204) return payload;
        const ct = r.headers.get("content-type") || "";
        return ct.includes("application/json") ? await r.json() : payload;
      } catch {
        localStorage.setItem(`settings:${path}`, JSON.stringify(payload));
        return payload;
      }
    },
  };

  // -------- roteamento/hash (#empresa, #usuarios, #regras, #integracoes) --------
  const panes = $$(".config-pane");
  const menu  = $$(".item-menu");

  function showPane(id) {
    panes.forEach((p) => p.classList.toggle("active", p.id === id));
    menu.forEach((m) => m.classList.toggle("ativo", m.dataset.target === id));
    localStorage.setItem("settings:lastTab", id);
  }
  function applyHash() {
    const wanted = (location.hash || "#empresa").replace("#", "");
    const exists = panes.some((p) => p.id === wanted);
    showPane(exists ? wanted : "empresa");
  }
  window.addEventListener("hashchange", applyHash);

  menu.forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const id = e.currentTarget.dataset.target;
      if (!id) return;
      if (location.hash !== `#${id}`) location.hash = `#${id}`;
      else applyHash();
      e.currentTarget.blur();
    })
  );

  if (!location.hash) {
    const last = localStorage.getItem("settings:lastTab") || "empresa";
    location.hash = `#${last}`;
  }
  applyHash();

  // ================== EMPRESA ==================
  const formEmpresa = $("#form-empresa");
  const btnEmpresaReload = $("#empresa-recarregar");

  async function loadEmpresa() {
    showLoading(btnEmpresaReload);
    try {
      const d = (await api.get("/company")) || {};
      ["razao_social","nome_fantasia","cnpj","email","telefone","endereco"].forEach((k) => {
        if (formEmpresa?.[k]) formEmpresa[k].value = d[k] || "";
      });
      toast("Dados da empresa carregados", "success");
    } catch {
      toast("Erro ao carregar dados da empresa", "error");
    } finally { hideLoading(btnEmpresaReload); }
  }

  formEmpresa?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = formEmpresa.querySelector('button[type="submit"]');
    showLoading(submitBtn);
    try {
      const payload = Object.fromEntries(new FormData(formEmpresa).entries());
      await api.put("/company", payload);
      toast("Dados da empresa salvos com sucesso!", "success");
    } catch {
      toast("Erro ao salvar dados da empresa", "error");
    } finally { hideLoading(submitBtn); }
  });
  btnEmpresaReload?.addEventListener("click", loadEmpresa);

  // ================== USUÁRIOS ==================
  const tbodyUsers     = $("#usuarios-list");
  const formAddUser    = $("#form-add-user");
  const btnUsersSave   = $("#usuarios-salvar");
  const btnUsersReload = $("#usuarios-recarregar");
  let users = [];

  function renderUsers() {
    if (!tbodyUsers) return;
    tbodyUsers.innerHTML = users.map((u, i) => `
      <tr class="user-row">
        <td>${esc(u.nome)}</td>
        <td>${esc(u.email)}</td>
        <td>
          <select data-i="${i}" class="edit-role">
            <option value="admin"    ${u.papel === "admin" ? "selected" : ""}>Admin</option>
            <option value="gestor"   ${u.papel === "gestor" ? "selected" : ""}>Gestor</option>
            <option value="operador" ${u.papel === "operador" ? "selected" : ""}>Operador</option>
          </select>
        </td>
        <td><button class="btn btn--ghost remove" data-i="${i}">Remover</button></td>
      </tr>
    `).join("");
  }

  async function loadUsers() {
    showLoading(btnUsersReload);
    try {
      users = (await api.get("/users")) || [];
      renderUsers();
      toast("Lista de usuários atualizada", "success");
    } catch {
      toast("Erro ao carregar usuários", "error");
    } finally { hideLoading(btnUsersReload); }
  }

  formAddUser?.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(formAddUser);
    const nome  = (f.get("nome")  || "").toString().trim();
    const email = (f.get("email") || "").toString().trim().toLowerCase();
    const papel = (f.get("papel") || "operador").toString();
    if (!nome) return toast("Informe o nome do usuário", "warning");
    if (!/^\S+@\S+\.\S+$/.test(email)) return toast("E-mail inválido", "warning");
    if (users.some((u) => (u.email || "").toLowerCase() === email)) return toast("Este e-mail já está cadastrado", "warning");
    users.push({ nome, email, papel }); formAddUser.reset(); renderUsers(); toast(`Usuário ${nome} adicionado!`, "success");
  });

  tbodyUsers?.addEventListener("change", (e) => {
    if (e.target.classList.contains("edit-role")) {
      const i = +e.target.dataset.i;
      if (users[i]) { users[i].papel = e.target.value; toast("Papel alterado (lembre-se de salvar)", "info"); }
    }
  });
  tbodyUsers?.addEventListener("click", async (e) => {
    if (e.target.classList.contains("remove")) {
      const i = +e.target.dataset.i;
      const user = users[i];
      if (await confirm(`Tem certeza que deseja remover o usuário <strong>${esc(user?.nome || "")}</strong>?`)) {
        users.splice(i, 1); renderUsers(); toast("Usuário removido (lembre-se de salvar)", "success");
      }
    }
  });
  btnUsersSave ?.addEventListener("click", async () => {
    showLoading(btnUsersSave);
    try { await api.put("/users", users); toast("Lista de usuários salva!", "success"); }
    catch { toast("Erro ao salvar usuários", "error"); }
    finally { hideLoading(btnUsersSave); }
  });
  btnUsersReload?.addEventListener("click", loadUsers);

  // ================== REGRAS ==================
  const formRegras = $("#form-regras");
  const btnRegrasReload = $("#regras-recarregar");

  async function loadRegras() {
    showLoading(btnRegrasReload);
    try {
      const d = (await api.get("/rules")) || {};
      const data = {
        rule_rejeitado_zero:      d.rule_rejeitado_zero      ?? true,
        rule_motivo_cliente_zero: d.rule_motivo_cliente_zero ?? true,
        rule_cd_somente_frete:    d.rule_cd_somente_frete    ?? true,
        label_aprovada:           d.label_aprovada           ?? "Aprovada",
        label_rejeitada:          d.label_rejeitada          ?? "Rejeitada",
        label_recebido_cd:        d.label_recebido_cd        ?? "Recebido no CD",
        label_em_inspecao:        d.label_em_inspecao        ?? "Em inspeção",
      };
      Object.entries(data).forEach(([k, v]) => {
        if (!formRegras?.[k]) return;
        if (formRegras[k].type === "checkbox") formRegras[k].checked = !!v;
        else formRegras[k].value = v;
      });
      toast("Regras carregadas", "success");
    } catch {
      toast("Erro ao carregar regras", "error");
    } finally { hideLoading(btnRegrasReload); }
  }

  formRegras?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = formRegras.querySelector('button[type="submit"]');
    showLoading(submitBtn);
    try {
      const fd = new FormData(formRegras);
      const payload = Object.fromEntries(fd.entries());
      ["rule_rejeitado_zero","rule_motivo_cliente_zero","rule_cd_somente_frete"].forEach(
        (k) => (payload[k] = !!formRegras[k].checked)
      );
      await api.put("/rules", payload);
      toast("Regras salvas com sucesso!", "success");
    } catch {
      toast("Erro ao salvar regras", "error");
    } finally { hideLoading(submitBtn); }
  });

  btnRegrasReload?.addEventListener("click", loadRegras);
  $$('input[type="checkbox"]', formRegras).forEach((c) =>
    c.addEventListener("change", () => toast("Configuração alterada (lembre-se de salvar)", "info"))
  );

  // ------- carregar tudo na primeira entrada -------
  loadEmpresa(); loadUsers(); loadRegras();

  // ================== INTEGRAÇÃO: Mercado Livre ==================
  (async () => {
    const card = document.querySelector('[data-integration="ml"]');
    if (!card) return;

    const statusEl      = document.getElementById("ml-status");
    const badgeEl       = document.getElementById("ml-badge");
    const btnConn       = document.getElementById("ml-connect");
    const btnDisc       = document.getElementById("ml-disconnect");
    const btnAccounts   = document.getElementById("ml-accounts-btn");
    const btnShowStores = document.querySelector('[data-ml="me"]');

    const setLoading = (on) => { if (on && statusEl) statusEl.textContent = "Verificando status…"; };

    const applyUiDisconnected = () => {
      card.classList.remove("is-connected");
      if (statusEl) statusEl.textContent = "Não conectado";
      if (badgeEl)  badgeEl.textContent  = "E-commerce";
      if (btnConn)  btnConn.hidden = false;
      if (btnDisc)  btnDisc.hidden = true;
    };

    const applyUiConnected = (nickname, expiresAt) => {
      card.classList.add("is-connected");
      if (statusEl) {
        const exp = expiresAt ? ` (expira: ${new Date(expiresAt).toLocaleString("pt-BR")})` : "";
        statusEl.innerHTML = `Conectado como <b>@${esc(nickname || "conta")}</b>${exp}`;
      }
      if (badgeEl) badgeEl.textContent = "Conectado";
      if (btnConn) btnConn.hidden = true;
      if (btnDisc) btnDisc.hidden = false;
    };

    async function refreshMlStatus() {
      try {
        setLoading(true);
        const r = await fetch("/api/ml/status", { cache: "no-store" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        if (j.connected) applyUiConnected(j.nickname || "conta", j.expires_at);
        else             applyUiDisconnected();
      } catch (e) {
        console.warn("[ML] status falhou:", e);
        applyUiDisconnected();
      }
    }

    btnAccounts?.addEventListener("click", () => {
      const panel = document.querySelector('[data-ml="accounts"]');
      if (!panel) return;
      panel.scrollIntoView({ behavior: "smooth", block: "start" });
      panel.classList.add("ring");
      setTimeout(() => panel.classList.remove("ring"), 1200);
    });

    btnDisc?.addEventListener("click", async () => {
      const ok = await confirm("Tem certeza que deseja desconectar do Mercado Livre?");
      if (!ok) return;
      showLoading(btnDisc);
      try {
        const r = await fetch("/api/ml/disconnect", { method: "POST" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        await refreshMlStatus();
        toast("Desconectado do Mercado Livre com sucesso", "success");
      } catch (e) {
        console.error(e);
        toast("Falha ao desconectar do Mercado Livre", "error");
      } finally { hideLoading(btnDisc); }
    });

    // ------ Modal de Lojas ------
    const modal        = $("#ml-stores-modal");
    const modalLoading = $("#ml-stores-loading");
    const modalContent = $("#ml-stores-content");
    const modalEmpty   = $("#ml-stores-empty");
    const modalError   = $("#ml-stores-error");

    const openModal  = () => { if (!modal) return; modal.hidden = false; document.body.style.overflow = "hidden"; };
    const closeModal = () => { if (!modal) return; modal.hidden = true;  document.body.style.overflow = ""; };

    // helper: mostra apenas um estado do modal
    const setStoresState = (state) => {
      if (!modal) return;
      const is = (s) => state === s;
      modalLoading.hidden = !is("loading");
      modalContent.hidden = !is("content");
      modalEmpty.hidden   = !is("empty");
      modalError.hidden   = !is("error");
    };

    // normaliza resposta de /api/ml/stores OU /api/ml/me (fallback)
    const normalizeStores = (data) => {
      if (!data) return [];
      if (Array.isArray(data.stores)) return data.stores;
      if (Array.isArray(data.accounts)) {
        return data.accounts.map((a) => ({
          id: a.user_id || a.id,
          name: a.nickname || a.name || `Conta ${a.user_id || a.id}`,
          nickname: a.nickname,
          active: a.active ?? true,
          site_id: a.site_id || a.site || "MLB",
        }));
      }
      if (data.user_id || data.id || data.nickname) {
        return [{
          id: data.user_id || data.id,
          name: data.nickname || data.name || "Conta",
          nickname: data.nickname,
          active: true,
          site_id: data.site_id || "MLB",
        }];
      }
      return [];
    };

    const renderStoreItem = (store) => `
      <div class="modal-store-item">
        <div class="modal-store-info">
          <div class="modal-store-name">${esc(store.name || store.nickname || "Loja")}</div>
          <div class="modal-store-id">ID: ${esc(store.id || "N/A")} • ${esc(store.site_id || "")}</div>
        </div>
        <span class="modal-store-badge ${store.active ? "active" : "inactive"}">
          ${store.active ? "Ativa" : "Inativa"}
        </span>
      </div>
    `;

    let _loadingStores = false;
    async function loadStores() {
      if (!modal || _loadingStores) return;   // evita chamadas paralelas
      _loadingStores = true;

      setStoresState("loading");
      modalContent.innerHTML = "";

      try {
        const tryFetch = async (url) => {
          const r = await fetch(url, { cache: "no-store" });
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        };

        let data = null;
        try { data = await tryFetch("/api/ml/stores"); }
        catch { try { data = await tryFetch("/api/ml/me"); } catch { data = null; } }

        const stores = normalizeStores(data);

        if (!stores.length) {
          setStoresState("empty");
          return;
        }

        modalContent.innerHTML = stores.map(renderStoreItem).join("");
        setStoresState("content");
      } catch (e) {
        console.error("[ML Modal] Erro ao carregar lojas:", e);
        setStoresState("error");
      } finally {
        _loadingStores = false;
      }
    }

    btnShowStores?.addEventListener("click", () => { openModal(); loadStores(); });
    $$("[data-close-modal]", modal).forEach((b) => b.addEventListener("click", closeModal));
    modal?.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal?.hidden) closeModal(); });

    // primeira leitura do status
    refreshMlStatus();
  })();

  // Ctrl/Cmd + S salva o formulário visível
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      const activePane = $(".config-pane.active");
      const form = activePane && $("form", activePane);
      if (form) {
        form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
        toast("Salvando…", "info");
      }
    }
  });
});
