// public/js/login.js
(() => {
  const form       = document.getElementById('loginForm');
  const emailEl    = document.getElementById('email');
  const passEl     = document.getElementById('password');
  const rememberEl = document.getElementById('rememberMe');
  const errorBox   = document.getElementById('loginError');

  const btn    = document.getElementById('btnLogin');
  const loader = document.getElementById('pageLoader');

  // janela para backfill pós-login (dias)
  const BACKFILL_DAYS = 7;

  function setLoading(on) {
    if (on) {
      if (errorBox) errorBox.style.display = 'none';
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

  // ---- helpers de backfill (não bloqueiam navegação) ----
  function fireGetKeepalive(url) {
    try {
      // GET com keepalive (não falha a UI se der erro)
      return fetch(url, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { 'Accept': 'application/json' },
        keepalive: true
      }).catch(() => {});
    } catch {
      // último recurso (ping por imagem)
      try { const img = new Image(); img.src = url; } catch {}
      return Promise.resolve();
    }
  }

  async function backfillAfterLogin({ days = BACKFILL_DAYS } = {}) {
    // 1) valida token/contas ML (se disponível no server, ignora erro)
    const pPing = fireGetKeepalive('/api/ml/ping');

    // 2) importa claims (todas as contas) últimos N dias, statuses mais relevantes
    const qs = new URLSearchParams({
      days: String(days),
      statuses: 'opened,in_progress',
      silent: '1',
      all: '1'
    }).toString();
    const pClaims = fireGetKeepalive(`/api/ml/claims/import?${qs}`);

    // 3) tenta sincronizar shipping e mensagens (se não existir no server, 404 é ok)
    const pShip  = fireGetKeepalive(`/api/ml/shipping/sync?recent_days=${encodeURIComponent(days)}&silent=1`);
    const pMsg   = fireGetKeepalive(`/api/ml/messages/sync?recent_days=${encodeURIComponent(days)}&silent=1`);

    // dá um pequeno orçamento de tempo só para despachar as requisições
    const budgetMs = 300;
    await Promise.race([
      Promise.all([pPing, pClaims, pShip, pMsg]),
      new Promise(res => setTimeout(res, budgetMs))
    ]).catch(() => {});
  }

  async function onSubmit(ev) {
    ev.preventDefault();

    const email    = emailEl?.value?.trim();
    const password = passEl?.value ?? '';
    const remember = !!rememberEl?.checked;

    if (!email || !password) {
      return showError('Preencha e-mail e senha.');
    }

    setLoading(true);

    try {
      const resp = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        credentials: 'same-origin',
        body: JSON.stringify({ email, password, remember })
      });

      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data?.error || 'Falha ao autenticar.');
      }

      // destino pós-login
      const params     = new URLSearchParams(location.search);
      const nextParam  = params.get('next');
      const storedNext = sessionStorage.getItem('postLoginRedirect');
      const target     = nextParam || storedNext || '/home.html';
      sessionStorage.removeItem('postLoginRedirect');

      // dispara o backfill sem travar a navegação (pequeno orçamento p/ despacho)
      await backfillAfterLogin({ days: BACKFILL_DAYS }).catch(() => {});

      // redireciona mantendo loader (experiência suave)
      window.location.replace(target);
    } catch (e) {
      showError(e.message);
    } finally {
      // se a navegação não ocorrer (erro), reverte loading
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
