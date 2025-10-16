// settings/config.js – roteador de abas + CRUD simples (com fallback localStorage)
document.addEventListener("DOMContentLoaded", () => {
  // utilidades
  const $ = (sel, ctx = document) => ctx.querySelector(sel)
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel))

  const toast = (msg, type = "info") => {
    // Remove toast anterior se existir
    const existing = document.querySelector(".toast-notification")
    if (existing) existing.remove()

    const icons = {
      success: "✓",
      error: "✕",
      warning: "⚠",
      info: "ℹ",
    }

    const t = document.createElement("div")
    t.className = `toast-notification toast-${type}`
    t.innerHTML = `
      <span class="toast-icon">${icons[type] || icons.info}</span>
      <span class="toast-message">${msg}</span>
    `
    document.body.appendChild(t)

    // Anima entrada
    requestAnimationFrame(() => {
      t.classList.add("show")
    })

    // Remove após 3 segundos
    setTimeout(() => {
      t.classList.remove("show")
      setTimeout(() => t.remove(), 300)
    }, 3000)
  }

  const esc = (s = "") =>
    String(s).replace(
      /[&<>"']/g,
      (m) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[m],
    )

  const showLoading = (btn) => {
    if (!btn) return
    btn.disabled = true
    btn.dataset.originalText = btn.textContent
    btn.innerHTML = '<span class="spinner"></span> Carregando...'
  }

  const hideLoading = (btn) => {
    if (!btn) return
    btn.disabled = false
    btn.textContent = btn.dataset.originalText || btn.textContent
  }

  const confirm = (msg) => {
    return new Promise((resolve) => {
      const overlay = document.createElement("div")
      overlay.className = "confirm-overlay"
      overlay.innerHTML = `
        <div class="confirm-dialog">
          <div class="confirm-icon">⚠</div>
          <p class="confirm-message">${msg}</p>
          <div class="confirm-actions">
            <button class="btn btn--ghost confirm-cancel">Cancelar</button>
            <button class="btn btn--danger confirm-ok">Confirmar</button>
          </div>
        </div>
      `
      document.body.appendChild(overlay)

      requestAnimationFrame(() => overlay.classList.add("show"))

      const cleanup = (result) => {
        overlay.classList.remove("show")
        setTimeout(() => overlay.remove(), 200)
        resolve(result)
      }

      overlay.querySelector(".confirm-cancel").onclick = () => cleanup(false)
      overlay.querySelector(".confirm-ok").onclick = () => cleanup(true)
      overlay.onclick = (e) => {
        if (e.target === overlay) cleanup(false)
      }
    })
  }

  // -------- mini storage (API -> localStorage fallback) ----------
  const api = {
    async get(path) {
      try {
        const r = await fetch(`/api/settings${path}`)
        if (!r.ok) throw 0
        if (r.status === 204) return null
        const ct = r.headers.get("content-type") || ""
        return ct.includes("application/json") ? await r.json() : null
      } catch {
        return JSON.parse(localStorage.getItem(`settings:${path}`) || "null")
      }
    },
    async put(path, payload) {
      try {
        const r = await fetch(`/api/settings${path}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
        if (!r.ok) throw 0
        if (r.status === 204) return payload
        const ct = r.headers.get("content-type") || ""
        return ct.includes("application/json") ? await r.json() : payload
      } catch {
        localStorage.setItem(`settings:${path}`, JSON.stringify(payload))
        return payload
      }
    },
  }

  // -------- roteamento/hash (#empresa, #usuarios, #regras, #integracoes) --------
  const panes = $$(".config-pane")
  const menu = $$(".item-menu")

  function showPane(id) {
    panes.forEach((p) => p.classList.toggle("active", p.id === id))
    menu.forEach((m) => m.classList.toggle("ativo", m.dataset.target === id))
    localStorage.setItem("settings:lastTab", id)
  }

  function applyHash() {
    const wanted = (location.hash || "#empresa").replace("#", "")
    const exists = panes.some((p) => p.id === wanted)
    showPane(exists ? wanted : "empresa")
  }
  window.addEventListener("hashchange", applyHash)

  menu.forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault()
      const id = e.currentTarget.dataset.target
      if (!id) return
      if (location.hash !== `#${id}`) location.hash = `#${id}`
      else applyHash()
      e.currentTarget.blur()
    }),
  )

  if (!location.hash) {
    const last = localStorage.getItem("settings:lastTab") || "empresa"
    location.hash = `#${last}`
  }
  applyHash()

  // ================== EMPRESA ==================
  const formEmpresa = $("#form-empresa")
  const btnEmpresaReload = $("#empresa-recarregar")

  async function loadEmpresa() {
    showLoading(btnEmpresaReload)
    try {
      const d = (await api.get("/company")) || {}
      ;["razao_social", "nome_fantasia", "cnpj", "email", "telefone", "endereco"].forEach((k) => {
        if (formEmpresa?.[k]) formEmpresa[k].value = d[k] || ""
      })
      toast("Dados da empresa carregados", "success")
    } catch (error) {
      toast("Erro ao carregar dados da empresa", "error")
    } finally {
      hideLoading(btnEmpresaReload)
    }
  }

  formEmpresa?.addEventListener("submit", async (e) => {
    e.preventDefault()
    const submitBtn = formEmpresa.querySelector('button[type="submit"]')
    showLoading(submitBtn)

    try {
      const payload = Object.fromEntries(new FormData(formEmpresa).entries())
      await api.put("/company", payload)
      toast("Dados da empresa salvos com sucesso!", "success")

      formEmpresa.classList.add("form-success")
      setTimeout(() => formEmpresa.classList.remove("form-success"), 600)
    } catch (error) {
      toast("Erro ao salvar dados da empresa", "error")
    } finally {
      hideLoading(submitBtn)
    }
  })

  btnEmpresaReload?.addEventListener("click", loadEmpresa)

  // ================== USUÁRIOS ==================
  const tbodyUsers = $("#usuarios-list")
  const formAddUser = $("#form-add-user")
  const btnUsersSave = $("#usuarios-salvar")
  const btnUsersReload = $("#usuarios-recarregar")
  let users = []

  function renderUsers() {
    if (!tbodyUsers) return
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
      </tr>`,
      )
      .join("")

    requestAnimationFrame(() => {
      $$(".user-row", tbodyUsers).forEach((row, i) => {
        row.style.animationDelay = `${i * 50}ms`
        row.classList.add("fade-in")
      })
    })
  }

  async function loadUsers() {
    showLoading(btnUsersReload)
    try {
      users = (await api.get("/users")) || []
      renderUsers()
      toast("Lista de usuários atualizada", "success")
    } catch (error) {
      toast("Erro ao carregar usuários", "error")
    } finally {
      hideLoading(btnUsersReload)
    }
  }

  formAddUser?.addEventListener("submit", (e) => {
    e.preventDefault()
    const f = new FormData(formAddUser)
    const nome = (f.get("nome") || "").toString().trim()
    const email = (f.get("email") || "").toString().trim().toLowerCase()
    const papel = (f.get("papel") || "operador").toString()

    if (!nome) {
      toast("Informe o nome do usuário", "warning")
      return
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      toast("E-mail inválido", "warning")
      return
    }
    if (users.some((u) => (u.email || "").toLowerCase() === email)) {
      toast("Este e-mail já está cadastrado", "warning")
      return
    }

    users.push({ nome, email, papel })
    formAddUser.reset()
    renderUsers()
    toast(`Usuário ${nome} adicionado com sucesso!`, "success")
  })

  tbodyUsers?.addEventListener("change", (e) => {
    if (e.target.classList.contains("edit-role")) {
      const i = +e.target.dataset.i
      if (users[i]) {
        users[i].papel = e.target.value
        toast("Papel do usuário alterado (lembre-se de salvar)", "info")
      }
    }
  })

  tbodyUsers?.addEventListener("click", async (e) => {
    if (e.target.classList.contains("remove")) {
      const i = +e.target.dataset.i
      const user = users[i]

      const confirmed = await confirm(
        `Tem certeza que deseja remover o usuário <strong>${esc(user?.nome || "")}</strong>?`,
      )

      if (confirmed) {
        users.splice(i, 1)
        renderUsers()
        toast("Usuário removido (lembre-se de salvar)", "success")
      }
    }
  })

  btnUsersSave?.addEventListener("click", async () => {
    showLoading(btnUsersSave)
    try {
      await api.put("/users", users)
      toast("Lista de usuários salva com sucesso!", "success")
    } catch (error) {
      toast("Erro ao salvar usuários", "error")
    } finally {
      hideLoading(btnUsersSave)
    }
  })

  btnUsersReload?.addEventListener("click", loadUsers)

  // ================== REGRAS ==================
  const formRegras = $("#form-regras")
  const btnRegrasReload = $("#regras-recarregar")

  async function loadRegras() {
    showLoading(btnRegrasReload)
    try {
      const d = (await api.get("/rules")) || {}
      const data = {
        rule_rejeitado_zero: d.rule_rejeitado_zero ?? true,
        rule_motivo_cliente_zero: d.rule_motivo_cliente_zero ?? true,
        rule_cd_somente_frete: d.rule_cd_somente_frete ?? true,
        label_aprovada: d.label_aprovada ?? "Aprovada",
        label_rejeitada: d.label_rejeitada ?? "Rejeitada",
        label_recebido_cd: d.label_recebido_cd ?? "Recebido no CD",
        label_em_inspecao: d.label_em_inspecao ?? "Em inspeção",
      }
      Object.entries(data).forEach(([k, v]) => {
        if (!formRegras?.[k]) return
        if (formRegras[k].type === "checkbox") formRegras[k].checked = !!v
        else formRegras[k].value = v
      })
      toast("Regras carregadas", "success")
    } catch (error) {
      toast("Erro ao carregar regras", "error")
    } finally {
      hideLoading(btnRegrasReload)
    }
  }

  formRegras?.addEventListener("submit", async (e) => {
    e.preventDefault()
    const submitBtn = formRegras.querySelector('button[type="submit"]')
    showLoading(submitBtn)

    try {
      const fd = new FormData(formRegras)
      const payload = Object.fromEntries(fd.entries())
      ;["rule_rejeitado_zero", "rule_motivo_cliente_zero", "rule_cd_somente_frete"].forEach(
        (k) => (payload[k] = !!formRegras[k].checked),
      )
      await api.put("/rules", payload)
      toast("Regras salvas com sucesso!", "success")

      formRegras.classList.add("form-success")
      setTimeout(() => formRegras.classList.remove("form-success"), 600)
    } catch (error) {
      toast("Erro ao salvar regras", "error")
    } finally {
      hideLoading(submitBtn)
    }
  })

  btnRegrasReload?.addEventListener("click", loadRegras)

  $$('input[type="checkbox"]', formRegras).forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      toast("Configuração alterada (lembre-se de salvar)", "info")
    })
  })

  // ------- carregar tudo na primeira entrada -------
  loadEmpresa()
  loadUsers()
  loadRegras()

  // ================== INTEGRAÇÃO: Mercado Livre ==================
  ;(async () => {
    const card = document.querySelector('[data-integration="ml"]')
    if (!card) return

    const statusEl      = document.getElementById("ml-status")
    const btnConn       = card.querySelector('[data-ml="connect"]')
    const btnDisc       = card.querySelector('[data-ml="disconnect"]')
    const btnShowStores = card.querySelector('[data-ml="me"]')
    const accList       = card.querySelector('[data-ml="accounts"]')

    function applyUiDisconnected() {
      card.classList.remove("is-connected")
      if (statusEl) statusEl.textContent = "Não conectado"
      if (btnConn) btnConn.hidden = false
      if (btnDisc) btnDisc.hidden = true
    }

    function applyUiConnected(nickname, expiresAt) {
      card.classList.add("is-connected")
      if (statusEl) {
        const exp = expiresAt ? ` (expira: ${new Date(expiresAt).toLocaleString("pt-BR")})` : ""
        statusEl.innerHTML = `Conectado como <b>@${esc(nickname || "conta")}</b>${exp}`
      }
      if (btnConn) btnConn.hidden = true
      if (btnDisc) btnDisc.hidden = false
    }

    async function refreshMlStatus() {
      try {
        if (statusEl) statusEl.textContent = "Verificando status…"
        const r = await fetch("/api/ml/status", { cache: "no-store" })
        if (!r.ok) throw new Error("HTTP " + r.status)
        const j = await r.json()
        if (j.connected) {
          applyUiConnected(j.nickname || "conta", j.expires_at)
        } else {
          applyUiDisconnected()
        }
      } catch (e) {
        console.warn("[ML] status falhou:", e)
        applyUiDisconnected()
      }
    }

    // --------- Modal Lojas ----------
    const modal        = document.getElementById("ml-stores-modal")
    const modalLoading = document.getElementById("ml-stores-loading")
    const modalContent = document.getElementById("ml-stores-content")
    const modalEmpty   = document.getElementById("ml-stores-empty")
    const modalError   = document.getElementById("ml-stores-error")

    function openModal()  { if (modal){ modal.hidden = false; document.body.style.overflow = "hidden" } }
    function closeModal() { if (modal){ modal.hidden = true;  document.body.style.overflow = "" } }

    async function fetchAccounts() {
      const r = await fetch("/api/ml/me", { cache: "no-store" })
      if (!r.ok) throw new Error("HTTP " + r.status)
      const data = await r.json()

      // Normaliza vários formatos possíveis
      let raw = data.accounts || data.items || data.users || data.results || []
      if (!Array.isArray(raw)) raw = []

      // Se a API retornar apenas um objeto com id/nickname
      if (!raw.length && (data.id || data.user_id) && (data.nickname || data.name)) {
        raw = [{ id: data.id || data.user_id, nickname: data.nickname || data.name, active: true }]
      }

      return raw.map(a => ({
        id:    a.id || a.user_id || a.account_id || a.uid || "",
        name:  a.nickname || a.name || a.store_name || "Loja",
        active: a.active !== undefined ? !!a.active : true
      }))
    }

    function renderAccountsInCard(stores) {
      if (!accList) return
      if (!stores.length) { accList.innerHTML = ""; return }
      accList.innerHTML = stores.map(s => `
        <li class="ml-acc-row">
          <div class="ml-acc-left">
            <span class="ml-acc-name">${esc(s.name)}</span>
          </div>
          <span class="ml-badge">${esc(s.id)}</span>
        </li>
      `).join("")
    }

    async function loadStoresIntoModal() {
      if (!modal) return
      modalLoading.hidden = false
      modalContent.hidden = true
      modalEmpty.hidden = true
      modalError.hidden = true

      try {
        const stores = await fetchAccounts()

        // Preenche listinha do card
        renderAccountsInCard(stores)

        if (!stores.length) {
          modalLoading.hidden = true
          modalEmpty.hidden = false
          return
        }

        modalContent.innerHTML = stores.map((s, i) => `
          <div class="modal-store-item" style="animation-delay:${i*0.05}s">
            <div class="modal-store-info">
              <div class="modal-store-name">${esc(s.name)}</div>
              <div class="modal-store-id">ID: ${esc(s.id)}</div>
            </div>
            <span class="modal-store-badge ${s.active ? "active" : "inactive"}">
              ${s.active ? "Ativa" : "Inativa"}
            </span>
          </div>
        `).join("")
        modalLoading.hidden = true
        modalContent.hidden = false
      } catch (err) {
        console.error("[ML Modal] Erro ao carregar lojas:", err)
        modalLoading.hidden = true
        modalError.hidden = false
      }
    }

    // Botão "Contas" abre o modal
    btnShowStores?.addEventListener("click", () => {
      openModal()
      loadStoresIntoModal()
    })

    // Fechar modal (botões e overlay)
    modal?.querySelectorAll("[data-close-modal]").forEach(btn => btn.addEventListener("click", closeModal))
    modal?.addEventListener("click", e => { if (e.target === modal) closeModal() })
    document.addEventListener("keydown", e => { if (e.key === "Escape" && !modal?.hidden) closeModal() })

    // Desconectar
    btnDisc?.addEventListener("click", async () => {
      const confirmed = await confirm("Tem certeza que deseja desconectar do Mercado Livre?")
      if (!confirmed) return

      showLoading(btnDisc)
      try {
        const r = await fetch("/api/ml/disconnect", { method: "POST" })
        if (!r.ok) throw new Error("HTTP " + r.status)
        await refreshMlStatus()
        renderAccountsInCard([])
        toast("Desconectado do Mercado Livre com sucesso", "success")
      } catch (e) {
        toast("Falha ao desconectar do Mercado Livre", "error")
      } finally {
        hideLoading(btnDisc)
      }
    })

    // status inicial + carrega lista (no card) em background
    await refreshMlStatus()
    try {
      const stores = await fetchAccounts()
      renderAccountsInCard(stores)
    } catch (e) {
      console.warn("[ML] Não foi possível obter contas:", e)
    }
  })()

  document.addEventListener("keydown", (e) => {
    // Ctrl/Cmd + S para salvar o formulário ativo
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault()
      const activePane = $(".config-pane.active")
      if (activePane) {
        const form = $("form", activePane)
        if (form) {
          form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }))
          toast("Salvando...", "info")
        }
      }
    }
  })
})
