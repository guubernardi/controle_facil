(function injectHeader() {
  const html = `
  <header class="navbar" role="banner">
    <div class="container nav-inner">
      <a href="/index.html" class="brand" aria-label="Ir para a página inicial">
        <img src="assets/img/logo_rf.png" alt="Logotipo do sistema" />
        <span>Sistema de Devoluções</span>
      </a>
      <button class="nav-toggle" aria-label="Abrir menu" aria-expanded="false">
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <path class="bar bar1" d="M4 7h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          <path class="bar bar2" d="M4 12h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          <path class="bar bar3" d="M4 17h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </button>
      <nav class="nav-links" role="navigation" aria-label="Menu principal">
        <a data-active="index" href="/index.html">
          <svg class="nav-ico" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 1L3 5v7h10V5L8 1z" fill="currentColor"/></svg>
          <span>Devoluções</span>
        </a>
        <a data-active="dashboard" href="/dashboard.html">
          <svg class="nav-ico" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2 2h5v5H2V2zm7 0h5v9h-5V2zM2 9h5v5H2V9z" fill="currentColor"/></svg>
          <span>Dashboard</span>
        </a>
        <a data-active="registros" href="/registros.html">
          <svg class="nav-ico" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3 2h10v2H3V2zm0 3h10v9H3V5zm2 2v5h2V7H5z" fill="currentColor"/></svg>
          <span>Registros</span>
        </a>
      </nav>
    </div>
  </header>`;
  document.body.insertAdjacentHTML('afterbegin', html);

  // destacar link ativo
  // Normaliza caminho (pode ser /, /index.html, /dashboard.html, etc.)
  const rawPath = location.pathname || '/index.html';
  const path = rawPath === '/' ? '/index.html' : rawPath;
  const isDash = path.endsWith('dashboard.html');
  const isIndex = path.endsWith('index.html');
  const isRegistros = path.endsWith('registros.html');

  document.querySelectorAll('.nav-links a').forEach(a => {
    const key = a.getAttribute('data-active');
  a.classList.toggle('active', (key === 'dashboard' && isDash) || (key === 'index' && isIndex) || (key === 'registros' && isRegistros));
    // add aria-current for accessibility
    if (a.classList.contains('active')) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });

  // toggle menu (mobile)
  const toggle = document.querySelector('.nav-toggle');
  const links = document.querySelector('.nav-links');
  if (toggle && links) {
    toggle.addEventListener('click', () => {
      const show = !links.classList.contains('show');
      links.classList.toggle('show', show);
      toggle.setAttribute('aria-expanded', String(show));
    });
  }
})();
