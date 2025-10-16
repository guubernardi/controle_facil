// settings/config.js – roteador de abas + CRUD simples (com fallback localStorage)
document.addEventListener("DOMContentLoaded", () => {
  // ---------- helpers ----------
  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

  // Usa o #toast existente (config.css já estiliza .toast/.show)
  const toast = (msg) => {
    const el = document.getElementById("toast");
    if (!el) {
      // fallback simples
      console.log("[toast]", msg);
      return;
    }
    el.textContent = msg;
    el.classList.add("show");
    setTimeout(() => el.classList.remove("show"), 2600);
  };

  const esc = (s = "") =>
    String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

  const showLoading = (btn) => {
    if (!btn) return;
    btn.disabled = true;
    btn.dataset.originalText = btn.textContent;
    btn.innerHTML = '<span class="spinner"></span> Carregando...';
  };
  const hideLoading = (btn) => {
    if (!btn) return;
    btn.disabled = false;
    btn.textContent = btn.dataset.originalText || btn.textContent;
  };

  // Estilos mínimos para o confirm (overlay + centro)
  const ensureConfirmCss = () => {
    if (document.getElementById("confirm-css")) return;
    const style = document.createElement("style");
    style.id = "confirm-css";
    style.textContent = `
      .confirm-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:99999;opacity:0;transition:opacity .2s}
      .confirm-overlay.show{opacity:1}
      .confirm-dialog{max-width:420px;width:calc(100% - 32px);background:#fff;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.2);padding:18px}
      .confirm-icon{font-size:22px;margin-bottom:8px}
      .confirm-message{margin:0 0 14px;color:#111827}
      .confirm-actions{display:flex;gap:10px;justify-content:flex-end}
      .btn--danger{background:#dc2626;color:#fff;border:1px solid #b91c1c}
    `;
    document.head.appendChild(style);
  };

  const confirm = (msg) =>
    new Promise((resolve) => {
      ensureConfirmCss();
      const overlay = document.createElement("div");
      overlay.className = "confirm-overlay";
      overlay.innerHTML = `
        <div class="confirm-dialog" role="dialog" aria-modal="true">
          <div class="confirm-icon">⚠</div>
          <p class="confirm-message">${msg}</p>
          <div class="confirm-actions">
            <button class="btn btn--ghost confirm-cancel">Cancelar</button>
            <button class="btn btn--danger confirm-ok">Confirmar</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add("show"));
      const done = (val) => {
        overlay.classList.remove("show");
        setTimeout(() => overlay.remove(), 180);
        resolve(val);
      };
      overlay.querySelector(".confirm-cancel").onclick = () => done(false);
      overlay.querySelector(".confirm-ok").onclick = () => done(true);
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) done(false);
      });
      document.addEventListener(
        "keydown",
        (onEsc) => {
          if (onEsc.key === "Escape") done(false);
        },
        { once: true }
      );
    });

  // Mini cliente (API -> localStorage fallback)
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

  // ---------- roteador de abas ----------
  const panes = $$(".config-pane");
  const menu = $$(".item-menu");
  const showPane = (id) => {
    panes.forEach((p) => p.classList.toggle("active", p.id === id));
    menu.forEach((m) => m.classList.toggle("ativo", m.dataset.target === id));
    localStorage.setItem("settings:lastTab", id);
  };
  const applyHash = () => {
    const wanted = (location.hash || "#empresa").replace("#", "");
    const exists = panes.some((p) => p.id === wanted);
    showPane(exists ? wanted : "empresa");
  };
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

  // ---------- EMPRESA ----------
  const formEmpresa = $("#form-empresa");
  const btnEmpresaReload = $("#empresa-recarregar");

  async function loadEmpresa() {
    showLoading(btnEmpresaReload);
    try {
      const d = (await api.get("/company")) || {};
      ["razao_social", "nome_fantasia", "cnpj", "email", "telefone", "endereco"].forEach((k) => {
        if (formEmpresa?.[k]) formEmpresa[k].value = d[k] || "";
      });
      toast("Dados da empresa carregados");
    } catch {
      toast("Erro ao carregar dados da empresa");
    } finally {
      hideLoading(btnEmpresaReload);
    }
  }

  formEmpresa?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = formEmpresa.querySelector('button[type="submit"]');
    showLoading(submitBtn);
    try {
      const payload = Object.fromEntries(new FormData(formEmpresa).entries());
      await api.put("/company", payload);
      toast("Dados da empresa salvos!");
      formEmpresa.classList.add("form-success");
      setTimeout(() => formEmpresa.classList.remove("form-success"), 600);
    } catch {
      toast("Erro ao salvar dados da empresa");
    } finally {
      hideLoading(submitBtn);
    }
  });
  btnEmpresaReload?.addEventListener("click", loadEmpresa);

  // ---------- USUÁRIOS ----------
  const tbodyUsers = $("#usuarios-list");
  const formAddUser = $("#form-add-user");
  const btnUsersSave = $("#usuarios-salvar");
  const btnUsersReload = $("#usuarios-recarregar");
  let users = [];

  function renderUsers() {
    if (!tbodyUsers) return;
    tbodyUsers.innerHTML = users
      .map(
        (u, i) => `
      <tr class="user-row">
        <td>${esc(u.nome)}</td>
        <td>${esc(u.email)}</td>
        <td>
          <select data-i="${i}" class="edit-role">
            <option value="admin"   ${u.papel === "admin" ? "selected" : ""}>Admin</option>
            <option value="gestor"  ${u.papel === "gestor" ? "selected" : ""}>Gestor</option>
            <option value="operador"${u.papel === "operador" ? "selected" : ""}>Operador</option>
          </select>
        </td>
        <td><button class="btn btn--ghost remove" data-i="${i}">Remover</button></td>
      </tr>`
      )
      .join("");
  }

  async function loadUsers() {
    showLoading(btnUsersReload);
    try {
      users = (await api.get("/users")) || [];
      renderUsers();
      toast("Lista de usuários atualizada");
    } catch {
      toast("Erro ao carregar usuários");
    } finally {
      hideLoading(btnUsersReload);
    }
  }

  formAddUser?.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(formAddUser);
    const nome = (f.get("nome") || "").toString().trim();
    const email = (f.get("email") || "").toString().trim().toLowerCase();
    const papel = (f.get("papel") || "operador").toString();

    if (!nome) return toast("Informe o nome do usuário");
    if (!/^\S+@\S+\.\S+$/.test(email)) return toast("E-mail inválido");
    if (users.some((u) => (u.email || "").toLowerCase() === email)) return toast("Este e-mail já está cadastrado");

    users.push({ nome, email, papel });
    formAddUser.reset();
    renderUsers();
    toast(`Usuário ${nome} adicionado!`);
  });

  tbodyUsers?.addEventListener("change", (e) => {
    if (e.target.classList.contains("edit-role")) {
      const i = +e.target.dataset.i;
      if (users[i]) {
        users[i].papel = e.target.value;
        toast("Papel alterado (salve para aplicar)");
      }
    }
  });

  tbodyUsers?.addEventListener("click", async (e) => {
    if (e.target.classList.contains("remove")) {
      const i = +e.target.dataset.i;
      const user = users[i];
      if (await confirm(`Remover o usuário <strong>${esc(user?.nome || "")}</strong>?`)) {
        users.splice(i, 1);
        renderUsers();
        toast("Usuário removido (salve para aplicar)");
      }
    }
  });

  btnUsersSave?.addEventListener("click", async () => {
    showLoading(btnUsersSave);
    try {
      await api.put("/users", users);
      toast("Usuários salvos!");
    } catch {
      toast("Erro ao salvar usuários");
    } finally {
      hideLoading(btnUsersSave);
    }
  });

  btnUsersReload?.addEventListener("click", loadUsers);

  // ---------- REGRAS ----------
  const formRegras = $("#form-regras");
  const btnRegrasReload = $("#regras-recarregar");

  async function loadRegras() {
    showLoading(btnRegrasReload);
    try {
      const d = (await api.get("/rules")) || {};
      const data = {
        rule_rejeitado_zero: d.rule_rejeitado_zero ?? true,
        rule_motivo_cliente_zero: d.rule_motivo_cliente_zero ?? true,
        rule_cd_somente_frete: d.rule_cd_somente_frete ?? true,
        label_aprovada: d.label_aprovada ?? "Aprovada",
        label_rejeitada: d.label_rejeitada ?? "Rejeitada",
        label_recebido_cd: d.label_recebido_cd ?? "Recebido no CD",
        label_em_inspecao: d.label_em_inspecao ?? "Em inspeção",
      };
      Object.entries(data).forEach(([k, v]) => {
        if (!formRegras?.[k]) return;
        if (formRegras[k].type === "checkbox") formRegras[k].checked = !!v;
        else formRegras[k].value = v;
      });
      toast("Regras carregadas");
    } catch {
      toast("Erro ao carregar regras");
    } finally {
      hideLoading(btnRegrasReload);
    }
  }

  formRegras?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = formRegras.querySelector('button[type="submit"]');
    showLoading(submitBtn);
    try {
      const fd = new FormData(formRegras);
      const payload = Object.fromEntries(fd.entries());
      ["rule_rejeitado_zero", "rule_motivo_cliente_zero", "rule_cd_somente_frete"].forEach(
        (k) => (payload[k] = !!formRegras[k].checked)
      );
      await api.put("/rules", payload);
      toast("Regras salvas!");
      formRegras.classList.add("form-success");
      setTimeout(() => formRegras.classList.remove("form-success"), 600);
    } catch {
      toast("Erro ao salvar regras");
    } finally {
      hideLoading(submitBtn);
    }
  });

  btnRegrasReload?.addEventListener("click", loadRegras);
  $$('input[type="checkbox"]', formRegras).forEach((c) =>
    c.addEventListener("change", () => toast("Configuração alterada (salve para aplicar)"))
  );

  // Carregar dados iniciais
  loadEmpresa();
  loadUsers();
  loadRegras();

  // ---------- INTEGRAÇÃO MERCADO LIVRE ----------
  (async () => {
    const card = document.querySelector('[data-integration="ml"]');
    if (!card) return;

    const statusEl = document.getElementById("ml-status");
    const btnConn = card.querySelector('[data-ml="connect"]');
    const btnDisc = card.querySelector('[data-ml="disconnect"]');
    const btnShowStores = card.querySelector('[data-ml="me"]');
    const listEl = card.querySelector('[data-ml="accounts"]');

    const setLoadingStatus = (on) => {
      if (statusEl) statusEl.textContent = on ? "Verificando status…" : (statusEl.textContent || "—");
    };

    function applyUiDisconnected() {
      card.classList.remove("is-connected");
      if (statusEl) statusEl.textContent = "Não conectado";
      if (btnConn) btnConn.hidden = false;
      if (btnDisc) btnDisc.hidden = true;
      if (listEl) listEl.innerHTML = "";
    }

    function applyUiConnected(nickname, expiresAt) {
      card.classList.add("is-connected");
      if (statusEl) {
        const exp = expiresAt ? ` (expira: ${new Date(expiresAt).toLocaleString("pt-BR")})` : "";
        statusEl.innerHTML = `Conectado como <b>@${esc(nickname || "conta")}</b>${exp}`;
      }
      if (btnConn) btnConn.hidden = true;
      if (btnDisc) btnDisc.hidden = false;
    }

    async function fetchJsonWithTimeout(url, ms = 10000) {
      const ctrl = new AbortController();
      const id = setTimeout(() => ctrl.abort(), ms);
      try {
        const r = await fetch(url, { cache: "no-store", signal: ctrl.signal });
        clearTimeout(id);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } finally {
        clearTimeout(id);
      }
    }

    async function refreshMlStatus() {
      try {
        setLoadingStatus(true);
        const j = await fetchJsonWithTimeout("/api/ml/status");
        if (j.connected) {
          applyUiConnected(j.nickname || "conta", j.expires_at);
        } else {
          applyUiDisconnected();
        }
      } catch (e) {
        console.warn("[ML] status erro:", e);
        applyUiDisconnected();
      } finally {
        setLoadingStatus(false);
      }
    }

    // Modal de lojas
    const modal = $("#ml-stores-modal");
    const modalLoading = $("#ml-stores-loading");
    const modalContent = $("#ml-stores-content");
    const modalEmpty = $("#ml-stores-empty");
    const modalError = $("#ml-stores-error");

    const openModal = () => {
      if (!modal) return;
      modal.hidden = false;
      document.body.style.overflow = "hidden";
    };
    const closeModal = () => {
      if (!modal) return;
      modal.hidden = true;
      document.body.style.overflow = "";
    };

    function normalizeStores(payload) {
      // Aceita vários formatos: {stores:[...]}, {accounts:[...]}, {items:[...]}, [...]
      const root =
        (payload && (payload.stores || payload.accounts || payload.items || payload.list)) || payload || [];
      const arr = Array.isArray(root) ? root : [];
      return arr.map((it) => ({
        id: it.id ?? it.user_id ?? it.account_id ?? it.seller_id ?? it.nickname ?? "N/A",
        name: it.name ?? it.nickname ?? it.store_name ?? `Conta ${it.id ?? ""}`.trim(),
        active: (it.active ?? it.enabled ?? (it.status ? String(it.status).toLowerCase() === "active" : true)),
      }));
    }

    async function loadStores() {
      if (!modal) return;

      // estado inicial
      modalLoading.hidden = false;
      modalContent.hidden = true;
      modalEmpty.hidden = true;
      modalError.hidden = true;

      try {
        let data;
        try {
          // 1ª tentativa: endpoint dedicado (se existir no servidor)
          data = await fetchJsonWithTimeout("/api/ml/stores");
        } catch (e1) {
          // fallback: alguns projetos expõem /api/ml/me
          const me = await fetchJsonWithTimeout("/api/ml/me");
          data = me || {};
        }

        const stores = normalizeStores(data);

        if (!stores.length) {
          modalLoading.hidden = true;
          modalEmpty.hidden = false;
          return;
        }

        // Render
        modalContent.innerHTML = stores
          .map(
            (s) => `
            <div class="modal-store-item">
              <div class="modal-store-info">
                <div class="modal-store-name">${esc(s.name)}</div>
                <div class="modal-store-id">ID: ${esc(String(s.id))}</div>
              </div>
              <span class="modal-store-badge ${s.active ? "active" : "inactive"}">
                ${s.active ? "Ativa" : "Inativa"}
              </span>
            </div>`
          )
          .join("");

        modalLoading.hidden = true;
        modalContent.hidden = false;
      } catch (e) {
        console.error("[ML Modal] Erro ao carregar lojas:", e);
        modalLoading.hidden = true;
        modalError.hidden = false;
      }
    }

    // Botões (usando os data-ml do seu HTML)
    btnShowStores?.addEventListener("click", () => {
      openModal();
      loadStores();
    });
    $$("[data-close-modal]", modal).forEach((btn) => btn.addEventListener("click", closeModal));
    modal?.addEventListener("click", (e) => e.target === modal && closeModal());
    document.addEventListener("keydown", (e) => e.key === "Escape" && !modal?.hidden && closeModal());

    btnDisc?.addEventListener("click", async () => {
      const ok = await confirm("Tem certeza que deseja desconectar do Mercado Livre?");
      if (!ok) return;
      showLoading(btnDisc);
      try {
        const r = await fetch("/api/ml/disconnect", { method: "POST" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        await refreshMlStatus();
        toast("Desconectado do Mercado Livre");
      } catch (e) {
        console.warn(e);
        toast("Falha ao desconectar do Mercado Livre");
      } finally {
        hideLoading(btnDisc);
      }
    });

    await refreshMlStatus();
  })();

  // Ctrl/Cmd+S salva o form visível
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      const activePane = $(".config-pane.active");
      const form = activePane && $("form", activePane);
      if (form) {
        form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
        toast("Salvando…");
      }
    }
  });
});
