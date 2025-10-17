// -------------------------------------------------------------
// Sidebar / Navigation
// -------------------------------------------------------------
(() => {
  'use strict';

  // Helper: refresh Lucide icons safely
  const refreshIcons = () => {
    if (typeof lucide !== 'undefined' && lucide?.createIcons) {
      try { lucide.createIcons(); } catch { /* noop */ }
    }
  };

  // Boot when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  function init() {
    const body          = document.body;
    const sidebar       = document.getElementById('sidebar');
    const desktopToggle = document.getElementById('sidebar-toggle');         // dentro da sidebar (desktop)
    const mobileToggle  = document.getElementById('sidebar-toggle-mobile');  // botão flutuante (mobile)
    const overlay       = document.getElementById('sidebar-overlay');

    if (!sidebar) return;

    // Layout com sidebar
    body.classList.add('has-sidebar');

    // Remove qualquer “ML: …” do rodapé sem tocar nos HTMLs
    sanitizeFooter();

    // Marca item ativo
    setActivePage();

    // Botão "Nova Devolução" (se existir)
    setupNovaDevolucaoButton();

    // ---------- Helpers ----------
    const isDesktop = () => window.innerWidth > 768;
    const setAria = (el, expanded) => el && el.setAttribute('aria-expanded', String(!!expanded));

    const setMobileOpen = (open) => {
      if (open) {
        sidebar.classList.add('mobile-open');
        overlay?.classList.add('active');
        body.classList.add('sidebar-mobile-open');
      } else {
        sidebar.classList.remove('mobile-open');
        overlay?.classList.remove('active');
        body.classList.remove('sidebar-mobile-open');
      }
      setAria(mobileToggle, open);

      // Atualiza ícone do mobile
      const icon = mobileToggle?.querySelector('[data-lucide]');
      if (icon) {
        icon.setAttribute('data-lucide', open ? 'x' : 'menu');
        refreshIcons();
      }
    };

    const toggleDesktopCollapse = () => {
      if (isDesktop()) {
        sidebar.classList.toggle('collapsed');
        body.classList.toggle('sidebar-collapsed');

        const collapsed = sidebar.classList.contains('collapsed');
        localStorage.setItem('sidebarCollapsed', collapsed ? 'true' : 'false');
        setAria(desktopToggle, !collapsed);

        // Atualiza ícone do desktop
        const icon = desktopToggle?.querySelector('[data-lucide]');
        if (icon) {
          icon.setAttribute('data-lucide', collapsed ? 'chevron-right' : 'chevron-left');
          refreshIcons();
        }
      } else {
        setMobileOpen(!sidebar.classList.contains('mobile-open'));
      }
    };

    // ---------- Bind dos botões ----------
    desktopToggle?.addEventListener('click', toggleDesktopCollapse);
    mobileToggle?.addEventListener('click', () => setMobileOpen(!sidebar.classList.contains('mobile-open')));
    overlay?.addEventListener('click', () => setMobileOpen(false));

    // Fechar com ESC no mobile
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') setMobileOpen(false);
    });

    // Restaurar colapso no desktop
    const savedCollapsed = localStorage.getItem('sidebarCollapsed');
    if (savedCollapsed === 'true' && isDesktop()) {
      sidebar.classList.add('collapsed');
      body.classList.add('sidebar-collapsed');
      setAria(desktopToggle, false);

      const icon = desktopToggle?.querySelector('[data-lucide]');
      if (icon) {
        icon.setAttribute('data-lucide', 'chevron-right');
        refreshIcons();
      }
    }

    // Ajustes no resize (fecha mobile ao ir para desktop)
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (isDesktop()) {
          setMobileOpen(false);
        }
      }, 150);
    });

    // Inicializa ícones uma vez
    refreshIcons();
  }

  // Marca o item ativo usando <body data-page="..."> com fallback por URL
  function setActivePage() {
    let activeKey = (document.body.dataset.page || '').toLowerCase().trim();

    if (!activeKey) {
      const raw  = (location.pathname || '/home.html').toLowerCase();
      const path = raw === '/' ? '/home.html' : raw;

      if (path.includes('/home')) activeKey = 'home';
      else if (path.includes('/central')) activeKey = 'central';
      else if (path.endsWith('/index.html') || path.includes('devolucao') || path.includes('devoluções')) activeKey = 'devolucoes';
      else if (path.includes('/dashboard')) activeKey = 'dashboards';
      else if (path.includes('/logs')) activeKey = 'logs';
      else if (path.includes('/config')) activeKey = 'settings';
    }

    document.querySelectorAll('.sidebar-nav-item').forEach((item) => {
      const key = (item.dataset.page || '').toLowerCase();
      const isActive = key === activeKey;
      item.classList.toggle('active', isActive);
      if (isActive) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    });
  }

  // Remove “ML: …” exibido no rodapé da sidebar, sem mexer nos HTMLs
  function sanitizeFooter() {
    const footer = document.querySelector('.sidebar-footer');
    if (!footer) return;

    // Remove nós de texto que começam com "ML:"
    [...footer.childNodes].forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) {
        const txt = (n.textContent || '').trim();
        if (/^ML\s*:/i.test(txt) || /^bernardigustavo/i.test(txt)) {
          footer.removeChild(n);
        }
      }
    });

    // Remove elementos com o texto "ML:" (p/spans herdados)
    footer.querySelectorAll('p,div,small,span').forEach((el) => {
      const txt = (el.textContent || '').trim();
      if (/^ML\s*:/i.test(txt) || /^bernardigustavo/i.test(txt)) {
        el.remove();
      }
    });

    // Remove elementos com marcas “ml” legadas
    footer.querySelectorAll("[class*='ml'],[id*='ml'],[data-ml]").forEach((el) => el.remove());
  }

  // Integra o botão "Nova Devolução"
  function setupNovaDevolucaoButton() {
    const btn = document.getElementById('sidebar-nova-devolucao');
    if (!btn) return;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // dispara evento para quem ouve abrir modal
      document.dispatchEvent(new CustomEvent('nova-devolucao:abrir'));
    });
  }
})();
