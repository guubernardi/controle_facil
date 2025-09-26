(function injectHeader() {
  // Normaliza caminho (pode ser /, /index.html, /dashboard.html, etc.)
  const rawPath = location.pathname || '/index.html';
  const path = rawPath === '/' ? '/index.html' : rawPath;
  const isIndex = path.endsWith('index.html');

  // ações específicas por página
  const actionsHtml = isIndex ? `
      <!-- ação rápida: botão Nova Devolução (preserva id usado pelo frontend) -->
      <div class="acoes-header">
        <button id="botao-nova-devolucao" class="botao botao-principal">
          <svg class="icone" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 0a.5.5 0 0 1 .5.5v7h7a.5.5 0 0 1 0 1h-7v7a.5.5 0 0 1-1 0v-7h-7a.5.5 0 0 1 0-1h7v-7A.5.5 0 0 1 8 0z"/>
          </svg>
          <span>Nova Devolução</span>
        </button>
      </div>
  ` : '';

  // HTML do navbar (usado para injetar ou substituir headers existentes)
  const html = `
  <header class="navbar" role="banner">
    <div class="container nav-inner">
      <a href="/index.html" class="brand" aria-label="Ir para a página inicial">
        <img src="assets/img/logo_rf.png" alt="Logotipo do sistema" />
        <span>Retorno Facil</span>
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

      ${actionsHtml}
    </div>
  </header>`;

  const existingNavbar = document.querySelector('.navbar');
  const existingCabecalho = document.getElementById('cabecalho') || document.querySelector('.cabecalho');

  // Se já existe um navbar, não alteramos
  if (existingNavbar) return;

  // Se existe um header estático (cabecalho), substituímos pelo navbar padronizado
  if (existingCabecalho) {
    existingCabecalho.outerHTML = html;
  } else {
    // senão, injetamos no início do body
    document.body.insertAdjacentHTML('afterbegin', html);
  }

  // destacar link ativo (reutiliza a variável `path` já calculada acima)
  const isDash = path.endsWith('dashboard.html');
  const isRegistros = path.endsWith('registros.html');

  document.querySelectorAll('.nav-links a').forEach(a => {
    const key = a.getAttribute('data-active');
    a.classList.toggle('active', (key === 'dashboard' && isDash) || (key === 'index' && isIndex) || (key === 'registros' && isRegistros));
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
