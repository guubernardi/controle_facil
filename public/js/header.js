(function injectHeader() {
  const rawPath = location.pathname || '/index.html';
  if (rawPath.endsWith('registros.html')) {
    location.replace('/index.html');
    return;
  }

  const path = rawPath === '/' ? '/index.html' : rawPath;
  const isIndex = path.endsWith('index.html');
  const isDash  = path.endsWith('dashboard.html');
  const isLogs  = path.endsWith('logs.html');

  const actionsHtml = isIndex ? `
    <div class="acoes-header">
      <button id="botao-nova-devolucao" class="botao botao-principal">
        <svg class="icone" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M8 0a.5.5 0 0 1 .5.5v7h7a.5.5 0 0 1 0 1h-7v7a.5.5 0 0 1-1 0v-7h-7a.5.5 0 0 1 0-1h7v-7A.5.5 0 0 1 8 0z"/>
        </svg>
        <span>Nova Devolução</span>
      </button>
    </div>
  ` : '';

  const html = `
  <header class="navbar" role="banner">
    <div class="container nav-inner">
      <a href="/index.html" class="brand" aria-label="Ir para a página inicial">
        <img src="/assets/img/logo_rf.png" alt="Retorno Facil" />
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
          <svg class="nav-ico" viewBox="0 0 16 16"><path d="M8 1L3 5v7h10V5L8 1z" fill="currentColor"/></svg>
          <span>Devoluções</span>
        </a>
        <a data-active="dashboard" href="/dashboard.html">
          <svg class="nav-ico" viewBox="0 0 16 16"><path d="M2 2h5v5H2V2zm7 0h5v9h-5V2zM2 9h5v5H2V9z" fill="currentColor"/></svg>
          <span>Dashboard</span>
        </a>
        <a data-active="logs" href="/logs.html">
          <svg class="nav-ico" viewBox="0 0 16 16"><path d="M2 3h12v2H2zM2 7h12v2H2zM2 11h12v2H2z" fill="currentColor"/></svg>
          <span>Log de Custos</span>
        </a>
      </nav>

      ${actionsHtml}
    </div>
  </header>`;

  if (!document.querySelector('.navbar')) {
    const existingCabecalho = document.getElementById('cabecalho') || document.querySelector('.cabecalho');
    if (existingCabecalho) existingCabecalho.outerHTML = html; else document.body.insertAdjacentHTML('afterbegin', html);
  }

  // destaca link ativo
  document.querySelectorAll('.nav-links a').forEach(a => {
    const key = a.getAttribute('data-active');
    const active = (key === 'dashboard' && isDash) || (key === 'index' && isIndex) || (key === 'logs' && isLogs);
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current');
  });

  // toggle mobile
  const toggle = document.querySelector('.nav-toggle');
  const links  = document.querySelector('.nav-links');
  if (toggle && links) {
    toggle.addEventListener('click', () => {
      const show = !links.classList.contains('show');
      links.classList.toggle('show', show);
      toggle.setAttribute('aria-expanded', String(show));
    });
  }
})();
