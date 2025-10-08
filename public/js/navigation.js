// Sidebar Navigation JavaScript
// -------------------------------------------------------------
// Ajustes:
// 1) O item ativo agora é lido de data-page (em vez de data-active).
// 2) Detecção de rota corrigida para "devolucoes" (sistema-devolucoes.html).
// 3) Comentários em português para facilitar manutenção.
// -------------------------------------------------------------
;(() => {
  // Inicializa a sidebar (desktop + mobile)
  function initSidebar() {
    const sidebar        = document.getElementById("sidebar")
    const sidebarToggle  = document.getElementById("sidebar-toggle")
    const sidebarOverlay = document.getElementById("sidebar-overlay")
    const body           = document.body

    if (!sidebar) return

    // Marca o body para aplicar layout com sidebar
    body.classList.add("has-sidebar")

    // Define o item ativo do menu
    setActivePage()

    // Botão "Nova Devolução" (se existir)
    setupNovaDevolucaoButton()

    // Alterna colapso no desktop / abre/fecha no mobile
    if (sidebarToggle) {
      sidebarToggle.addEventListener("click", () => {
        if (window.innerWidth > 768) {
          sidebar.classList.toggle("collapsed")
          body.classList.toggle("sidebar-collapsed")

          // Persiste estado no localStorage
          const isCollapsed = sidebar.classList.contains("collapsed")
          localStorage.setItem("sidebarCollapsed", isCollapsed)
        } else {
          // Mobile
          sidebar.classList.toggle("mobile-open")
          sidebarOverlay?.classList.toggle("active")
        }
      })
    }

    // Fecha sidebar no toque do overlay (mobile)
    if (sidebarOverlay) {
      sidebarOverlay.addEventListener("click", () => {
        sidebar.classList.remove("mobile-open")
        sidebarOverlay.classList.remove("active")
      })
    }

    // Restaura estado de colapso (desktop)
    const savedCollapsed = localStorage.getItem("sidebarCollapsed")
    if (savedCollapsed === "true" && window.innerWidth > 768) {
      sidebar.classList.add("collapsed")
      body.classList.add("sidebar-collapsed")
    }

    // Tratamento de resize (remove overlay no desktop)
    let resizeTimer
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (window.innerWidth > 768) {
          sidebar.classList.remove("mobile-open")
          sidebarOverlay?.classList.remove("active")
        }
      }, 250)
    })
  }

    // Determina qual página está ativa e aplica a classe "active" no menu
    function setActivePage() {
    const body = document.body
    let activeKey = ""

    // 1) Por classe no <body> (se você usa essas classes nas páginas)
    if (body) {
      if (body.classList.contains("home-page")) {
        activeKey = "home"
      } else if (body.classList.contains("central-page")) {
        activeKey = "central"
      } else if (body.classList.contains("devolucoes-page") || body.classList.contains("index-page")) {
        activeKey = "devolucoes"
      } else if (body.classList.contains("dashboards-page")) {
        activeKey = "dashboards"
      } else if (body.classList.contains("logs-page") || body.classList.contains("log-html")) {
        activeKey = "logs"
      }
    }

    // 2) Fallback: deduz pelo pathname (URL)
    if (!activeKey) {
      const raw  = location.pathname || "/home.html"
      const path = raw === "/" ? "/home.html" : raw.toLowerCase()

      if (path.includes("home.html")) {
        activeKey = "home"
      } else if (path.includes("central.html")) {
        activeKey = "central"
      } else if (path.endsWith("/index.html") || path.includes("index.html") ||
                path.includes("devolucao") || path.includes("devoluções")) {
        // sua página de Devoluções agora é index.html
        activeKey = "devolucoes"
      } else if (path.includes("dashboards.html")) {
        activeKey = "dashboards"
      } else if (path.includes("logs.html")) {
        activeKey = "logs"
      }
    }

    // 3) Aplica "active" baseado no data-page do link
    const navItems = document.querySelectorAll(".sidebar-nav-item")
    navItems.forEach((item) => {
      const key = item.dataset.page || ""
      const isActive = key === activeKey

      item.classList.toggle("active", isActive)
      if (isActive) item.setAttribute("aria-current", "page")
      else item.removeAttribute("aria-current")
    })
  }

  // Integra o botão "Nova Devolução" com o sistema (se existir)
  function setupNovaDevolucaoButton() {
    const novoDevolucaoBtn = document.getElementById("sidebar-nova-devolucao")
    if (novoDevolucaoBtn) {
      novoDevolucaoBtn.addEventListener("click", (e) => {
        e.preventDefault()
        e.stopPropagation()

        // Se existir objeto global, chama direto; senão dispara um evento
        if (window.sistemaDevolucoes && typeof window.sistemaDevolucoes.abrirModal === "function") {
          window.sistemaDevolucoes.abrirModal()
        } else {
          document.dispatchEvent(new CustomEvent("nova-devolucao:abrir"))
        }
      })
    }
  }

  // Boot quando o DOM estiver pronto
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initSidebar)
  } else {
    initSidebar()
  }
})()
