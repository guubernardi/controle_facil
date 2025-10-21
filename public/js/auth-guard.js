// public/js/auth-guard.js
(async function () {
  // caminho normalizado
  const PATH = location.pathname.toLowerCase();

  // páginas públicas (exatas) + prefixos públicos (ex.: /docs/*)
  const PUBLIC_EXACT = new Set([
    '/', '/login.html', '/register.html', '/reset.html'
  ]);
  const PUBLIC_PREFIXES = ['/docs'];

  const isPublic = PUBLIC_EXACT.has(PATH) || PUBLIC_PREFIXES.some(p => PATH.startsWith(p));

  const DEFAULT_NEXT = location.pathname + location.search + location.hash;

  async function getMe() {
    try {
      const r = await fetch('/api/auth/me', { credentials: 'include' });
      if (r.status === 401) return null;
      const j = await r.json().catch(() => null);
      return j?.user || null;
    } catch {
      return null;
    }
  }

  function goLogin() {
    const url = new URL('/login.html', location.origin);
    // preserva next existente se já veio por query
    const curr = new URL(location.href);
    const next = curr.searchParams.get('next') || DEFAULT_NEXT;
    url.searchParams.set('next', next);
    location.href = url.toString();
  }

  function setText(el, val) { if (el) el.textContent = val; }

  function wireHeaderAndSidebar(user) {
    setText(document.getElementById('userInfo'), `${user.name} (${user.role})`);
    setText(document.getElementById('sidebarUserName'), user.name);
    setText(document.getElementById('sidebarUserEmail'), user.email);

    const n = document.querySelector('.sidebar-user-name');
    const e = document.querySelector('.sidebar-user-email');
    if (n && !n.id) n.textContent = user.name;
    if (e && !e.id) e.textContent = user.email;

    // Mercado Livre (opcional)
    fetch('/api/ml/status', { credentials: 'include' })
      .then(r => r.json())
      .then(ml => {
        const mlEl = document.getElementById('mlInfo') || document.querySelector('.sidebar-ml');
        if (mlEl) mlEl.textContent = ml?.connected ? `ML: ${ml.nickname}` : 'ML: desconectado';
      }).catch(() => {});

    // Logout
    const btn = document.getElementById('btnLogout') || document.querySelector('.sidebar-logout');
    if (btn && !btn.__wired) {
      btn.__wired = true;
      btn.addEventListener('click', async () => {
        try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch {}
        goLogin();
      });
    }
  }

  function applyRbacUI(role) {
    document.querySelectorAll('[data-roles]').forEach(el => {
      const list = (el.getAttribute('data-roles') || '')
        .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      if (list.length && !list.includes(String(role).toLowerCase())) {
        el.style.display = 'none';
        if ('disabled' in el) try { el.disabled = true; } catch {}
      }
    });
  }

  // Busca usuário
  const user = await getMe();

  // 1) Se a página é protegida e não há usuário -> login
  if (!user && !isPublic) return goLogin();

  // 2) Se a página é pública de autenticação e já está logado -> manda pra home (ou "next")
  if (user && (PATH === '/login.html' || PATH === '/register.html' || PATH === '/reset.html' || PATH === '/')) {
    const curr = new URL(location.href);
    const next = curr.searchParams.get('next') || '/home.html';
    if (location.pathname + location.search !== next) {
      location.replace(next);
      return;
    }
  }

  // 3) Expõe e preenche UI quando logado
  window.__currentUser = user;
  if (user) {
    wireHeaderAndSidebar(user);
    applyRbacUI(user.role);
  }
})();
