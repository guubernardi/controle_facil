// public/js/auth-guard.js
(async function () {
  const PATH = location.pathname.toLowerCase();
  const PUBLIC_PAGES = new Set(['/','/login.html','/reset.html','/register.html']);
  const isPublic = PUBLIC_PAGES.has(PATH);

  function setText(el, val) { if (el) el.textContent = val; }

  function goLogin() {
    const url = new URL('/login.html', location.origin);
    const next = location.pathname + location.search + location.hash;
    url.searchParams.set('next', next);
    location.href = url.toString();
  }

  async function getMe() {
    try {
      const r = await fetch('/api/auth/me', { credentials: 'include' });
      if (r.status === 401) return null;
      const j = await r.json().catch(() => null);
      return j?.user || null;
    } catch { return null; }
  }

  const user = await getMe();

  // Página privada sem user -> manda pro login
  if (!user && !isPublic) return goLogin();

  // Página pública: se já estiver logado, manda pra Home; senão, não faz mais nada
  if (isPublic) {
    if (user && PATH !== '/')
      location.replace('/home.html');
    window.__currentUser = user;
    return;
  }

  // A partir daqui, só em páginas autenticadas
  window.__currentUser = user;

  // Header/Sidebar
  setText(document.getElementById('userInfo'), `${user.name} (${user.role})`);
  setText(document.getElementById('sidebarUserName'), user.name);
  setText(document.getElementById('sidebarUserEmail'), user.email);

  const n = document.querySelector('.sidebar-user-name');
  const e = document.querySelector('.sidebar-user-email');
  if (n && !n.id) n.textContent = user.name;
  if (e && !e.id) e.textContent = user.email;

  // Mercado Livre (só se logado)
  try {
    const r = await fetch('/api/ml/status', { credentials: 'include' });
    const ml = await r.json().catch(() => ({}));
    const mlEl = document.getElementById('mlInfo') || document.querySelector('.sidebar-ml');
    if (mlEl) mlEl.textContent = ml?.connected ? `ML: ${ml.nickname}` : 'ML: desconectado';
  } catch {}

  // Logout
  const btn = document.getElementById('btnLogout') || document.querySelector('.sidebar-logout');
  if (btn && !btn.__wired) {
    btn.__wired = true;
    btn.addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
      goLogin();
    });
  }

  // RBAC
  document.querySelectorAll('[data-roles]').forEach(el => {
    const list = (el.getAttribute('data-roles') || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (list.length && !list.includes(String(user.role).toLowerCase())) {
      el.style.display = 'none';
      if ('disabled' in el) try { el.disabled = true; } catch {}
    }
  });
})();
