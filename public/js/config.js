// public/js/config.js
document.addEventListener('DOMContentLoaded', () => {
  const $  = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  /* ============ TOAST ============ */
  function showToast(titulo, msg, tipo = 'info') {
    const t = $('#toast');
    if (!t) return;

    const titleEl = $('#toast-titulo');
    const descEl  = $('#toast-descricao');

    if (titleEl) titleEl.textContent = titulo;
    if (descEl)  descEl.textContent  = msg;

    t.classList.remove('toast-success', 'toast-error');
    if (tipo === 'success') t.classList.add('toast-success');
    if (tipo === 'error')   t.classList.add('toast-error');

    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 4000);
  }

  /* ============ NAVEGAÇÃO ENTRE ABAS (Integrações / Empresa) ============ */
  (function initTabs() {
    const menuItems = $$('.item-menu');
    const panes     = $$('.config-pane');

    function ativarAba(targetId) {
      menuItems.forEach(el => el.classList.remove('ativo'));
      panes.forEach(el => {
        el.classList.remove('active');
        el.hidden = true;
      });

      const link = document.querySelector(`.item-menu[data-target="${targetId}"]`);
      const pane = document.getElementById(targetId);

      if (link) link.classList.add('ativo');
      if (pane) {
        pane.classList.add('active');
        pane.hidden = false;
      }
    }

    menuItems.forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const target = link.dataset.target || link.getAttribute('href')?.replace('#', '');
        if (target) ativarAba(target);
      });
    });

    // Garante que a primeira aba esteja ativa
    const first = menuItems[0];
    if (first && first.dataset.target) ativarAba(first.dataset.target);
  })();

  /* ============ INTEGRAÇÃO MERCADO LIVRE ============ */
  (function initML() {
    const statusEl   = $('#ml-status');
    const btnAction  = $('#btn-ml-action');
    const btnSync    = $('#btn-sync-ml');
    const listEl     = $('#ml-accounts-list');
    const dlgHelp    = $('#dlg-ml-help');
    const btnClose   = $('#close-help');

    if (!statusEl) return;

    // CSS colocou display: none no #ml-status — força aparecer
    statusEl.style.display = 'inline-flex';

    let currentAccounts = [];

    function setStatus(stateClass, text) {
      statusEl.classList.remove('ok', 'off');
      if (stateClass) statusEl.classList.add(stateClass);
      statusEl.textContent = text;
    }

    function renderAccounts() {
      if (!listEl) return;

      if (!currentAccounts.length) {
        listEl.innerHTML =
          '<li style="color:#94a3b8; font-style:italic; padding:10px;">Nenhuma conta conectada.</li>';
        return;
      }

      listEl.innerHTML = currentAccounts.map(acc => {
        const nick =
          acc.nickname ||
          acc.nickname_ml ||
          (`Conta ${acc.user_id || ''}`).trim();

        const first =
          (nick || 'ML').trim().charAt(0).toUpperCase() || 'M';

        const expires =
          acc.expires_at ||
          acc.expires_in_human ||
          acc.expires_label ||
          '';

        return `
          <li class="ml-account-item">
            <div class="ml-acc-info">
              <div class="ml-acc-avatar">${first}</div>
              <div>
                <div style="font-weight:600; color:#0f172a;">${nick}</div>
                ${acc.user_id
                  ? `<div style="font-size:.75rem; color:#6b7280;">ID: ${acc.user_id}</div>`
                  : ''
                }
                ${expires
                  ? `<div style="font-size:.7rem; color:#9ca3af;">Expira: ${expires}</div>`
                  : ''
                }
              </div>
            </div>
            <div class="ml-acc-actions">
              <button type="button"
                      class="btn-acc-remove"
                      data-id="${acc.user_id || ''}">
                Remover
              </button>
            </div>
          </li>
        `;
      }).join('');

      // Liga eventos de "Remover"
      listEl.querySelectorAll('.btn-acc-remove').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          if (!id) return;

          if (!confirm('Remover esta conta do Mercado Livre?')) return;

          btn.disabled = true;
          try {
            const resp = await fetch(`/api/auth/ml/disconnect/${encodeURIComponent(id)}`, {
              method: 'POST'
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            showToast('Conta desconectada', 'A conta foi removida com sucesso.', 'success');
            await loadAccounts();
          } catch (err) {
            console.error('[config] erro ao desconectar conta ML', err);
            showToast('Erro ao desconectar', err.message || 'Tente novamente.', 'error');
            btn.disabled = false;
          }
        });
      });
    }

    async function loadAccounts() {
      try {
        setStatus(null, 'Carregando...');
        const resp = await fetch('/api/auth/ml/list');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

        const data = await resp.json().catch(() => ({}));
        let accounts = [];

        if (Array.isArray(data)) accounts = data;
        else if (Array.isArray(data.accounts)) accounts = data.accounts;
        else if (Array.isArray(data.rows)) accounts = data.rows;

        currentAccounts = accounts;

        if (!accounts.length) {
          if (btnSync) btnSync.hidden = true;
          if (btnAction) btnAction.textContent = 'Conectar Conta';
          setStatus('off', 'Nenhuma conta conectada');
        } else {
          if (btnSync) btnSync.hidden = false;
          if (btnAction) btnAction.textContent = 'Nova Conta';

          const label = accounts.length === 1
            ? '1 conta conectada'
            : `${accounts.length} contas conectadas`;

          setStatus('ok', label);
        }

        renderAccounts();
      } catch (err) {
        console.error('[config] erro ao carregar contas ML', err);
        if (btnSync) btnSync.hidden = true;
        setStatus('off', 'Erro ao carregar contas');
        currentAccounts = [];
        renderAccounts();
      }
    }

    // Clique no botão principal (Conectar Conta / Nova Conta)
    if (btnAction) {
      btnAction.addEventListener('click', (e) => {
        e.preventDefault();

        // Se não tem nenhuma conta, vai direto pro fluxo normal
        if (!currentAccounts.length) {
          window.location.href = '/api/auth/ml/login';
          return;
        }

        // Já tem conta → abre diálogo explicativo de multi-conta
        if (dlgHelp && typeof dlgHelp.showModal === 'function') {
          dlgHelp.showModal();
        } else {
          const msg =
            'Para conectar outra conta, é recomendado usar uma aba anônima logada no Controle Fácil.\n\nDeseja continuar mesmo assim?';
          if (confirm(msg)) {
            window.location.href = '/api/auth/ml/login';
          }
        }
      });
    }

    // Fechar dialog de ajuda
    if (dlgHelp && btnClose) {
      btnClose.addEventListener('click', () => dlgHelp.close());
    }

    // Botão de "Sincronizar"
    if (btnSync) {
      btnSync.addEventListener('click', async () => {
        const oldLabel = btnSync.textContent;
        btnSync.disabled = true;
        btnSync.textContent = 'Sincronizando...';

        try {
          const resp = await fetch('/api/returns/sync?days=30');
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

          let info = '';
          try {
            const data = await resp.json();
            if (typeof data.total === 'number') {
              info = `${data.total} devoluções analisadas.`;
            } else if (typeof data.created === 'number') {
              info = `${data.created} devoluções novas criadas.`;
            }
          } catch (_) {
            // se não veio JSON, beleza
          }

          showToast(
            'Sincronização concluída',
            info || 'As devoluções foram sincronizadas com o Mercado Livre.',
            'success'
          );
        } catch (err) {
          console.error('[config] erro ao sincronizar devoluções', err);
          showToast(
            'Erro ao sincronizar',
            err.message || 'Tente novamente em alguns instantes.',
            'error'
          );
        } finally {
          btnSync.disabled = false;
          btnSync.textContent = oldLabel;
        }
      });
    }

    // Carrega na entrada
    loadAccounts();
  })();
});
