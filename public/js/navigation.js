// -------------------------------------------------------------
// Sidebar / Navigation - Modern Implementation
// -------------------------------------------------------------
;(() => {
  // Boot when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init)
  } else {
    init()
  }

  function init() {
    const body = document.body
    const sidebar = document.getElementById("sidebar")
    const desktopToggle = document.getElementById("sidebar-toggle") // dentro da sidebar (desktop)
    const mobileToggle = document.getElementById("sidebar-toggle-mobile") // botão flutuante (mobile)
    const overlay = document.getElementById("sidebar-overlay")

    if (!sidebar) return

    // Layout com sidebar
    body.classList.add("has-sidebar")

    // Marca item ativo
    setActivePage()

    // Renderiza usuário no rodapé + botão sair
    renderSidebarUser()

    // ---------- Helpers ----------
    const isDesktop = () => window.innerWidth >= 1024
    const setAria = (el, expanded) => el && el.setAttribute("aria-expanded", String(!!expanded))

    const setMobileOpen = (open) => {
      if (open) {
        sidebar.classList.add("mobile-open")
        overlay?.classList.add("active")
        body.classList.add("sidebar-mobile-open")
      } else {
        sidebar.classList.remove("mobile-open")
        overlay?.classList.remove("active")
        body.classList.remove("sidebar-mobile-open")
      }
      setAria(mobileToggle, open)
    }

    const toggleDesktopCollapse = () => {
      if (isDesktop()) {
        sidebar.classList.toggle("collapsed")
        body.classList.toggle("sidebar-collapsed")

        const collapsed = sidebar.classList.contains("collapsed")
        localStorage.setItem("sidebarCollapsed", collapsed ? "true" : "false")
        setAria(desktopToggle, !collapsed)
      } else {
        setMobileOpen(!sidebar.classList.contains("mobile-open"))
      }
    }

    // ---------- Bind dos botões ----------
    desktopToggle?.addEventListener("click", toggleDesktopCollapse)
    mobileToggle?.addEventListener("click", () => setMobileOpen(!sidebar.classList.contains("mobile-open")))
    overlay?.addEventListener("click", () => setMobileOpen(false))

    // Fechar com ESC no mobile
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") setMobileOpen(false)
    })

    // Restaurar estado colapsado do localStorage (desktop)
    if (isDesktop()) {
      const savedCollapsed = localStorage.getItem("sidebarCollapsed")
      if (savedCollapsed === "true") {
        sidebar.classList.add("collapsed")
        body.classList.add("sidebar-collapsed")
        setAria(desktopToggle, false)
      }
    }

    // Fechar sidebar mobile ao clicar em um link
    const navLinks = sidebar.querySelectorAll(".sidebar-nav-item")
    navLinks.forEach(link => {
      link.addEventListener("click", () => {
        if (!isDesktop()) {
          setMobileOpen(false)
        }
      })
    })

    // Ajustar ao redimensionar janela
    let resizeTimer
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (isDesktop()) {
          setMobileOpen(false)
        }
      }, 250)
    })
  }

  // ---------- Marca item ativo ----------
  function setActivePage() {
    const currentPath = window.location.pathname
    const links = document.querySelectorAll(".sidebar-nav-item")
    
    links.forEach(link => {
      link.classList.remove("active")
      link.removeAttribute("aria-current")
      
      const href = link.getAttribute("href")
      if (href && currentPath.includes(href.replace(/^\//, ""))) {
        link.classList.add("active")
        link.setAttribute("aria-current", "page")
      }
    })
  }

  // ---------- Renderiza usuário no rodapé ----------
  function renderSidebarUser() {
    const userName = document.getElementById("sidebarUserName")
    const userEmail = document.getElementById("sidebarUserEmail")
    const btnLogout = document.getElementById("btnLogout")

    // Tenta pegar do localStorage ou usa valores padrão
    const user = JSON.parse(localStorage.getItem("user") || "{}")
    
    if (userName) {
      userName.textContent = user.name || "Usuário"
    }
    
    if (userEmail) {
      userEmail.textContent = user.email || ""
    }

    // Bind do botão de logout
    if (btnLogout) {
      btnLogout.addEventListener("click", () => {
        if (confirm("Deseja realmente sair?")) {
          localStorage.removeItem("user")
          localStorage.removeItem("token")
          window.location.href = "/login.html"
        }
      })
    }
  }
})()
