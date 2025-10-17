// public/js/login.js
(() => {
  const form = document.querySelector('[data-login-form]') || document.querySelector('form');
  const emailEl = form?.querySelector('input[type="email"], [name="email"]');
  const passEl  = form?.querySelector('input[type="password"], [name="password"]');
  const rememberEl = form?.querySelector('input[type="checkbox"][name="remember"]') || form?.querySelector('input[type="checkbox"]');
  const errorBox = document.getElementById('login-error'); // opcional (se existir)

  function showError(msg) {
    if (errorBox) {
      errorBox.textContent = msg || 'Falha ao autenticar.';
      errorBox.hidden = false;
    } else {
      alert(msg || 'Falha ao autenticar.');
    }
  }

  async function onSubmit(ev) {
    ev.preventDefault();
    const email = emailEl?.value?.trim();
    const password = passEl?.value ?? '';
    const remember = !!rememberEl?.checked;

    try {
      const resp = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email, password, remember })
      });

      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data?.error || 'Falha ao autenticar.');
      }

      // destino pós-login:
      const params = new URLSearchParams(location.search);
      const nextParam = params.get('next');
      const storedNext = sessionStorage.getItem('postLoginRedirect');
      const target = nextParam || storedNext || '/home.html';

      sessionStorage.removeItem('postLoginRedirect');
      window.location.replace(target);
    } catch (e) {
      showError(e.message);
    }
  }

  if (form) form.addEventListener('submit', onSubmit);

  // toggle de visibilidade da senha (se tiver botão/ícone com [data-toggle-pass])
  const toggle = document.querySelector('[data-toggle-pass]');
  if (toggle && passEl) {
    toggle.addEventListener('click', () => {
      passEl.type = passEl.type === 'password' ? 'text' : 'password';
    });
  }
})();
