(function () {
  // --- 1) descobre a aba ativa pela classe do <body>
  const body = document.body;
  let activeKey = '';

  if (body) {
    if (body.classList.contains('index-page') || body.classList.contains('devolucoes-page')) {
      activeKey = 'index';
    } else if (body.classList.contains('dashboard-page')) {
      activeKey = 'dashboard';
    } else if (body.classList.contains('logs-page') || body.classList.contains('log-html')) {
      activeKey = 'logs';
    }
    if (body.classList.contains('home-page') || body.classList.contains('home-page')) {
      activeKey = 'home';
    }

  }

  // --- 2) fallback pela rota
  if (!activeKey) {
    const raw = location.pathname || '/index.html';
    const path = raw === '/' ? '/index.html' : raw.toLowerCase();
    if (path.endsWith('/index.html')) activeKey = 'index';
    else if (path.endsWith('/dashboard.html')) activeKey = 'dashboard';
    else if (path.endsWith('/logs.html')) activeKey = 'logs';
    else if (path.includes('devolucao') || path.includes('devoluções')) activeKey = 'index';
    else if (path.includes('home.html')) activeKey = 'home'; activeKey = 'home';
  }

  // Só mostra a ação “Nova Devolução” na home
  const actionsHtml = activeKey === 'index'
    ? `
      <div class="acoes-header">
        <button id="botao-nova-devolucao" class="botao botao-principal" type="button">
          <svg class="icone" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 0a.5.5 0 0 1 .5.5v7h7a.5.5 0 0 1 0 1h-7v7a.5.5 0 0 1-1 0v-7h-7a.5.5 0 0 1 0-1h7v-7A.5.5 0 0 1 8 0z"/>
          </svg>
          <span>Nova Devolução</span>
        </button>
      </div>`
    : '';

  // markup da navbar
  const html = `
  <header class="navbar" role="banner">
    <div class="container nav-inner">
      <a href="/index.html" class="brand" aria-label="Ir para a página inicial">
        <img src="/assets/img/logo_rf.png" alt="Retorno Facil" />
        <span>Retorno Facil</span>
      </a>

     <nav class="nav-links" role="navigation" aria-label="Menu principal">
    <a data-active="home" href="/home.html">
        <svg class="nav-ico" viewBox="0 0 16 16">
            <path d="M8 1.5l-7 6V14h4v-4h6v4h4V7.5l-7-6zM5 14H3V8.5l5-4.25 5 4.25V14h-2v-4H7v4H5z" fill="currentColor"></path>
        </svg>
        <span>Home</span>
    </a>  
    
    <a data-active="index" href="/index.html">
        <svg class="nav-ico" viewBox="0 0 16 16">
            <path d="M11 6a4 4 0 1 1-7.9 1L1 7.2a6 6 0 1 0 11.8 1.8l2.2-2.2a.5.5 0 0 0-.7-.7L12 8c-.1-2.8-2.5-5-5-5a5 5 0 0 0-4.6 3H2L5 9V4L2 7h3.6A3.9 3.9 0 0 1 11 6z" fill="currentColor"></path>
        </svg>
        <span>Devoluções</span>
    </a>
    
    <a data-active="dashboard" href="/dashboard.html">
        <svg class="nav-ico" viewBox="0 0 16 16">
            <path d="M14 14H2V2h12v12zm-2-8h-2v6h2V6zm-4 4H6v2h2v-2zm-2-6h2v2H6V4zm6 6h-2v2h2v-2zm-4-4H6v2h2V6z" fill="currentColor"></path>
        </svg>
        <span>Dashboard</span>
    </a>
    
    <a data-active="logs" href="/logs.html">
        <svg class="nav-ico" viewBox="0 0 16 16">
            <path d="M12.5 1h-9C2.67 1 2 1.67 2 2.5v11C2 14.33 2.67 15 3.5 15h9c.83 0 1.5-.67 1.5-1.5v-11C14 1.67 13.33 1 12.5 1zM7 3h5v2H7V3zm5 3H7v2h5V6zM7 9h5v2H7V9zm-4 2.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2zM3 5.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2zM3 8.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2z" fill="currentColor"></path>
        </svg>
        <span>Log de Custos</span>
    </a>
</nav>

      ${actionsHtml}
    </div>
  </header>`;

  // insere se ainda não existir uma .navbar
  if (!document.querySelector('.navbar')) {
    const placeholder = document.getElementById('cabecalho') || document.querySelector('.cabecalho');
    if (placeholder) placeholder.outerHTML = html;
    else document.body.insertAdjacentHTML('afterbegin', html);
  }

  // marca ativo
  document.querySelectorAll('.nav-links a').forEach((a) => {
    const key = a.getAttribute('data-active');
    const isActive = key === activeKey;
    a.classList.toggle('active', isActive);
    if (isActive) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
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

  // ação “Nova Devolução” → abre o modal da home (sem redirecionar)
  const novo = document.getElementById('botao-nova-devolucao');
  if (novo) {
    novo.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // se o objeto global existir, usa direto
      if (window.sistemaDevolucoes && typeof window.sistemaDevolucoes.abrirModal === 'function') {
        window.sistemaDevolucoes.abrirModal();
      } else {
        // fallback: emite um evento que o index.js pode ouvir
        document.dispatchEvent(new CustomEvent('nova-devolucao:abrir'));
      }
    });
  }
})();
