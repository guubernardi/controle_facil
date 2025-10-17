// public/js/auth-guard.js
(async function () {
  const DEFAULT_NEXT = location.pathname + location.search + location.hash;
  const PUBLIC_PAGES = new Set(['/login.html', '/reset.html', '/']);

  async function getMe() {
    try {
      const r = await fetch('/api/auth/me', { credentials: 'include' });
      if (r.status === 401) return null;
      const j = await r.json().catch(() => null);
      return j?.user || null;
    } catch { return null; }
  }

  function goLogin() {
    const url = new URL('/login.html', location.origin);
    url.searchParams.set('next', DEFAULT_NEXT);
    location.href = url.toString();
  }

  function setText(el, val) { if (el) el.textContent = val; }

  function wireHeaderAndSidebar(user) {
    // Alvos possíveis (usa o que existir na página)
    setText(document.getElementById('userInfo'), `${user.name} (${user.role})`);
    setText(document.getElementById('sidebarUserName'), user.name);
    setText(document.getElementById('sidebarUserEmail'), user.email);

    // Fallback por classe (se não houver IDs)
    const n = document.querySelector('.sidebar-user-name');
    const e = document.querySelector('.sidebar-user-email');
    if (n && !n.id) n.textContent = user.name;
    if (e && !e.id) e.textContent = user.email;

    // Mercado Livre (se houver um espaço para isso)
    fetch('/api/ml/status', { credentials: 'include' })
      .then(r => r.json())
      .then(ml => {
        const mlEl = document.getElementById('mlInfo') || document.querySelector('.sidebar-ml');
        if (mlEl) mlEl.textContent = ml?.connected ? `ML: ${ml.nickname}` : 'ML: desconectado';
      }).catch(() => {});

    // Logout (por id OU por classe)
    const btn = document.getElementById('btnLogout') || document.querySelector('.sidebar-logout');
    if (btn && !btn.__wired) {
      btn.__wired = true;
      btn.addEventListener('click', async () => {
        await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
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

  // Protege páginas (exceto públicas)
  const user = await getMe();
  if (!user && !PUBLIC_PAGES.has(location.pathname.toLowerCase())) return goLogin();

  // Expõe e preenche UI
  window.__currentUser = user;
  if (user) {
    wireHeaderAndSidebar(user);
    applyRbacUI(user.role);
  }
})();
