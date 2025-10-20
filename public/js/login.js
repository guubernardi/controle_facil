// public/js/login.js
(() => {
  const form = document.getElementById('loginForm');
  const emailEl = document.getElementById('email');
  const passEl  = document.getElementById('password');
  const rememberEl = document.getElementById('rememberMe');
  const errorBox = document.getElementById('loginError');

  const btn = document.getElementById('btnLogin');
  const loader = document.getElementById('pageLoader');

  function setLoading(on) {
    if (on) {
      errorBox && (errorBox.style.display = 'none');
      btn?.classList.add('is-loading');
      if (btn) btn.disabled = true;
      loader?.classList.add('is-active');
      loader?.setAttribute('aria-hidden', 'false');
    } else {
      btn?.classList.remove('is-loading');
      if (btn) btn.disabled = false;
      loader?.classList.remove('is-active');
      loader?.setAttribute('aria-hidden', 'true');
    }
  }

  function showError(msg) {
    setLoading(false);
    if (errorBox) {
      errorBox.textContent = msg || 'Falha ao autenticar.';
      errorBox.style.display = 'block';
    } else {
      alert(msg || 'Falha ao autenticar.');
    }
  }

  async function onSubmit(ev) {
    ev.preventDefault();

    const email = emailEl?.value?.trim();
    const password = passEl?.value ?? '';
    const remember = !!rememberEl?.checked;

    if (!email || !password) {
      return showError('Preencha e-mail e senha.');
    }

    setLoading(true);

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
      // mantém o loader enquanto troca de página
      window.location.replace(target);
    } catch (e) {
      showError(e.message);
    } finally {
      // se a navegação não acontecer (erro), o finally garante o reset
      // se acontecer, a página descarrega e esse bloco é irrelevante
      setLoading(false);
    }
  }

  if (form) form.addEventListener('submit', onSubmit);

  // Toggle de visibilidade da senha
  const toggle = document.getElementById('togglePassword');
  if (toggle && passEl) {
    toggle.addEventListener('click', () => {
      passEl.type = passEl.type === 'password' ? 'text' : 'password';
      toggle.setAttribute('aria-pressed', passEl.type === 'text' ? 'true' : 'false');
    });
  }
})();
