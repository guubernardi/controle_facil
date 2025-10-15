// -------------------------------------------------------------
// Sidebar / Navigation
// -------------------------------------------------------------
;(() => {
  function initSidebar() {
    const sidebar        = document.getElementById("sidebar");
    const desktopToggle  = document.getElementById("sidebar-toggle");         // dentro da sidebar (desktop)
    const mobileToggle   = document.getElementById("sidebar-toggle-mobile");  // botão flutuante (mobile)
    const sidebarOverlay = document.getElementById("sidebar-overlay");
    const body           = document.body;

    if (!sidebar) return;

    // Layout com sidebar
    body.classList.add("has-sidebar");

    // Marca item ativo
    setActivePage();

    // Botão "Nova Devolução" (se existir)
    setupNovaDevolucaoButton();

    // ---------- Helpers ----------
    const isDesktop = () => window.innerWidth > 768;

    const setAriaExpanded = (el, expanded) => {
      if (!el) return;
      el.setAttribute("aria-expanded", String(!!expanded));
    };

    const setMobileOpen = (open) => {
      if (open) {
        sidebar.classList.add("mobile-open");
        sidebarOverlay?.classList.add("active");
        body.classList.add("sidebar-mobile-open"); // move o FAB para a direita
      } else {
        sidebar.classList.remove("mobile-open");
        sidebarOverlay?.classList.remove("active");
        body.classList.remove("sidebar-mobile-open");
      }
      setAriaExpanded(mobileToggle, open);
    };

    const toggleDesktopCollapse = () => {
      // No desktop, colapsa/expande a sidebar
      if (isDesktop()) {
        sidebar.classList.toggle("collapsed");
        body.classList.toggle("sidebar-collapsed");
        const collapsed = sidebar.classList.contains("collapsed");
        localStorage.setItem("sidebarCollapsed", collapsed);
        setAriaExpanded(desktopToggle, !collapsed);
      } else {
        // No mobile, abre/fecha
        setMobileOpen(!sidebar.classList.contains("mobile-open"));
      }
    };

    // ---------- Bind dos botões ----------
    desktopToggle?.addEventListener("click", toggleDesktopCollapse);
    mobileToggle?.addEventListener("click", () => setMobileOpen(!sidebar.classList.contains("mobile-open")));

    // Fechar no overlay (mobile)
    sidebarOverlay?.addEventListener("click", () => setMobileOpen(false));

    // Restaurar colapso no desktop
    const savedCollapsed = localStorage.getItem("sidebarCollapsed");
    if (savedCollapsed === "true" && isDesktop()) {
      sidebar.classList.add("collapsed");
      body.classList.add("sidebar-collapsed");
      setAriaExpanded(desktopToggle, false);
    }

    // Ajustes no resize
    let resizeTimer;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (isDesktop()) {
          // saindo do mobile -> garante tudo fechado/limpo
          setMobileOpen(false);
        }
      }, 200);
    });
  }

  // Descobre qual página está ativa e aplica "active"
  function setActivePage() {
    const body = document.body;
    let activeKey = "";

    // 1) Pelo <body>
    if (body) {
      if (body.classList.contains("home-page")) {
        activeKey = "home";
      } else if (body.classList.contains("central-page")) {
        activeKey = "central";
      } else if (body.classList.contains("devolucoes-page") || body.classList.contains("index-page")) {
        activeKey = "devolucoes";
      } else if (body.classList.contains("dashboard-page") || body.classList.contains("dashboard-html")) {
        activeKey = "dashboard";
      } else if (body.classList.contains("logs-page") || body.classList.contains("log-html")) {
        activeKey = "logs";
      }
    }

    // 2) Fallback: pela URL
    if (!activeKey) {
      const raw  = location.pathname || "/home.html";
      const path = raw === "/" ? "/home.html" : raw.toLowerCase();

      if (path.includes("home.html")) {
        activeKey = "home";
      } else if (path.includes("central.html")) {
        activeKey = "central";
      } else if (path.endsWith("/index.html") || path.includes("index.html") ||
                 path.includes("devolucao") || path.includes("devoluções")) {
        activeKey = "devolucoes";
      } else if (path.includes("dashboard.html")) {
        activeKey = "dashboard";
      } else if (path.includes("logs.html")) {
        activeKey = "logs";
      }
    }

    // 3) Aplica "active" nos itens
    document.querySelectorAll(".sidebar-nav-item").forEach((item) => {
      const key = item.dataset.page || "";
      const isActive = key === activeKey;
      item.classList.toggle("active", isActive);
      if (isActive) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    });
  }

  // Integra o botão "Nova Devolução"
  function setupNovaDevolucaoButton() {
    const btn = document.getElementById("sidebar-nova-devolucao");
    if (!btn) return;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (window.sistemaDevolucoes?.abrirModal) {
        window.sistemaDevolucoes.abrirModal();
      } else {
        document.dispatchEvent(new CustomEvent("nova-devolucao:abrir"));
      }
    });
  }

  // Boot
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initSidebar);
  } else {
    initSidebar();
  }
})();
