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

    const statusEl = document.getElementById("ml-status")
    const badgeEl = document.getElementById("ml-badge")
    const btnConn = document.getElementById("ml-connect")
    const btnDisc = document.getElementById("ml-disconnect")
    const btnAccounts = document.getElementById("ml-accounts-btn")
    const btnShowStores = document.querySelector('[data-ml="me"]')

    function setLoading(on) {
      if (on && statusEl) statusEl.textContent = "Verificando status…"
    }

    function applyUiDisconnected() {
      card.classList.remove("is-connected")
      if (statusEl) statusEl.textContent = "Não conectado"
      if (badgeEl) badgeEl.textContent = "E-commerce"
      if (btnConn) btnConn.hidden = false
      if (btnDisc) btnDisc.hidden = true
    }

    function applyUiConnected(nickname, expiresAt) {
      card.classList.add("is-connected")
      if (statusEl) {
        const exp = expiresAt ? ` (expira: ${new Date(expiresAt).toLocaleString("pt-BR")})` : ""
        statusEl.innerHTML = `Conectado como <b>@${esc(nickname || "conta")}</b>${exp}`
      }
      if (badgeEl) badgeEl.textContent = "Conectado"
      if (btnConn) btnConn.hidden = true
      if (btnDisc) btnDisc.hidden = false
    }

    async function refreshMlStatus() {
      try {
        setLoading(true)
        const r = await fetch("/api/ml/status", { cache: "no-store" })
        if (!r.ok) throw new Error("HTTP " + r.status)
        const j = await r.json()
        if (j.connected) {
          applyUiConnected(j.nickname || "conta", j.expires_at)
          toast("Mercado Livre conectado", "success")
        } else {
          applyUiDisconnected()
        }
      } catch (e) {
        console.warn("[ML] status falhou:", e)
        applyUiDisconnected()
        toast("Erro ao verificar status do Mercado Livre", "error")
      }
    }

    btnAccounts?.addEventListener("click", () => {
      const panel = document.querySelector('[data-ml="accounts"]')
      if (panel) {
        panel.scrollIntoView({ behavior: "smooth", block: "start" })
        panel.classList.add("ring")
        setTimeout(() => panel.classList.remove("ring"), 1200)
      }
    })

    btnDisc?.addEventListener("click", async () => {
      const confirmed = await confirm("Tem certeza que deseja desconectar do Mercado Livre?")

      if (confirmed) {
        showLoading(btnDisc)
        try {
          const r = await fetch("/api/ml/disconnect", { method: "POST" })
          if (!r.ok) throw new Error("HTTP " + r.status)
          await refreshMlStatus()
          toast("Desconectado do Mercado Livre com sucesso", "success")
        } catch (e) {
          toast("Falha ao desconectar do Mercado Livre", "error")
        } finally {
          hideLoading(btnDisc)
        }
      }
    })

    const modal = $("#ml-stores-modal")
    const modalLoading = $("#ml-stores-loading")
    const modalContent = $("#ml-stores-content")
    const modalEmpty = $("#ml-stores-empty")
    const modalError = $("#ml-stores-error")

    function openModal() {
      if (!modal) return
      modal.hidden = false
      document.body.style.overflow = "hidden"
    }

    function closeModal() {
      if (!modal) return
      modal.hidden = true
      document.body.style.overflow = ""
    }

    async function loadStores() {
      if (!modal) return

      // Mostra loading
      modalLoading.hidden = false
      modalContent.hidden = true
      modalEmpty.hidden = true
      modalError.hidden = true

      try {
        // Faz requisição para buscar lojas
        const response = await fetch("/api/ml/stores", { cache: "no-store" })

        if (!response.ok) throw new Error("Erro ao buscar lojas")

        const data = await response.json()
        const stores = data.stores || []

        if (stores.length === 0) {
          // Nenhuma loja encontrada
          modalLoading.hidden = true
          modalEmpty.hidden = false
        } else {
          // Renderiza lojas
          modalContent.innerHTML = stores
            .map(
              (store) => `
            <div class="modal-store-item">
              <div class="modal-store-info">
                <div class="modal-store-name">${esc(store.name || store.nickname || "Loja")}</div>
                <div class="modal-store-id">ID: ${esc(store.id || "N/A")}</div>
              </div>
              <span class="modal-store-badge ${store.active ? "active" : "inactive"}">
                ${store.active ? "Ativa" : "Inativa"}
              </span>
            </div>
          `,
            )
            .join("")

          modalLoading.hidden = true
          modalContent.hidden = false
        }
      } catch (error) {
        console.error("[ML Modal] Erro ao carregar lojas:", error)
        modalLoading.hidden = true
        modalError.hidden = false
      }
    }

    // Botão "Contas" abre o modal
    btnShowStores?.addEventListener("click", () => {
      openModal()
      loadStores()
    })

    // Botões de fechar modal
    $$("[data-close-modal]", modal).forEach((btn) => {
      btn.addEventListener("click", closeModal)
    })

    // Clique no overlay fecha o modal
    modal?.addEventListener("click", (e) => {
      if (e.target === modal) closeModal()
    })

    // ESC fecha o modal
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !modal?.hidden) {
        closeModal()
      }
    })

    refreshMlStatus()
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
