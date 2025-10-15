// public/js/ml-integration.js
(() => {
  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));
  const el = {
    pill:       $('[data-ml="status-pill"]'),
    connect:    $('[data-ml="connect"]'),
    disconnect: $('[data-ml="disconnect"]'),
    me:         $('[data-ml="me"]'),
    list:       $('[data-ml="accounts"]'),
    log:        $('[data-ml="log"]'),
    card:       $('#ml-card') || $('[data-ml="card"]')
  };

  const getJSON  = async (url) => (await fetch(url, { cache: 'no-store' })).json();
  const postJSON = async (url, body) =>
    (await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : '{}'
    })).json();

  function setPill(connected, text) {
    if (!el.pill) return;
    el.pill.textContent = text || (connected ? 'Conectado' : 'Desconectado');
    el.pill.classList.toggle('ml-pill--ok', connected);
    el.pill.classList.toggle('ml-pill--err', !connected);
  }

  function setLoading(on) {
    if (!el.card) return;
    el.card.classList.toggle('is-loading', !!on);
  }

  async function refresh() {
    try {
      setLoading(true);

      const status = await getJSON('/api/ml/status');
      const accounts = await getJSON('/api/ml/accounts').catch(() => ({ items: [], active_user_id: null }));

      const pillText = status.connected
        ? `${status.nickname} (${status.user_id})`
        : 'Desconectado';
      setPill(!!status.connected, pillText);

      if (el.list) {
        el.list.innerHTML = '';
        accounts.items.forEach(a => {
          const li = document.createElement('li');
          li.className = 'ml-acc';
          li.innerHTML = `
            <span class="ml-acc__name">${a.nickname}</span>
            <span class="ml-acc__id">(${a.user_id})</span>
          `;
          if (a.user_id === accounts.active_user_id) {
            const badge = document.createElement('span');
            badge.className = 'ml-badge';
            badge.textContent = 'ativa';
            li.appendChild(badge);
          } else {
            const btn = document.createElement('button');
            btn.className = 'ml-btn';
            btn.textContent = 'Tornar ativa';
            btn.onclick = async () => {
              await postJSON('/api/ml/active', { user_id: a.user_id });
              await refresh();
            };
            li.appendChild(btn);
          }
          el.list.appendChild(li);
        });
      }

      if (el.log) {
        el.log.hidden = false;
        el.log.textContent = JSON.stringify({ status, accounts }, null, 2);
      }
    } catch (e) {
      setPill(false, 'Erro');
      if (el.log) { el.log.hidden = false; el.log.textContent = String(e); }
    } finally {
      setLoading(false);
    }
  }

  // Botões
  if (el.connect)    el.connect.onclick    = () => { window.location.href = '/auth/ml/login'; };
  if (el.disconnect) el.disconnect.onclick = async () => {
    // tenta remover a ativa (multi-contas); se não houver, faz fallback sem body
    try {
      const acc = await getJSON('/api/ml/accounts');
      await postJSON('/api/ml/disconnect', { user_id: acc.active_user_id });
    } catch {
      await postJSON('/api/ml/disconnect', {});
    }
    await refresh();
  };
  if (el.me) el.me.onclick = async () => {
    const data = await getJSON('/api/ml/me');
    if (el.log) { el.log.hidden = false; el.log.textContent = JSON.stringify(data, null, 2); }
    alert(data?.ok ? `Logado como ${data.account.nickname}` : 'Falha no /api/ml/me');
  };

  // Inicializa
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
  refresh();
})();
