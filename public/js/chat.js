/* Chat — Cliente | Plataforma (composer persistente + threads de mediação) */
;(() => {
  // ===== Config / integração backend =====
  const API = '/api/ml'; // base de rotas do backend

  // Headers dinâmicos (evita forçar Content-Type em FormData)
  function authHeaders({ json = true } = {}) {
    const token =
      localStorage.getItem('ML_SELLER_TOKEN') ||
      localStorage.getItem('ML_TOKEN') ||
      '';

    const sellerId =
      localStorage.getItem('ML_SELLER_ID') ||
      localStorage.getItem('ML_OWNER_ID') ||
      '';

    const h = {};
    if (json) h['Content-Type'] = 'application/json';

    if (token)    h['x-seller-token'] = token;
    if (sellerId) {
      h['x-seller-id'] = sellerId; // compat frontend antigo
      h['x-owner']     = sellerId; // alguns backends leem x-owner
    }
    return h;
  }

  // fetch com cookies de sessão e melhor mensagem de erro
  async function jfetch(url, opts = {}) {
    const res = await fetch(url, {
      credentials: 'include',
      ...opts,
      headers: {
        ...(opts.headers || {}),
        ...authHeaders(opts.json === false ? { json: false } : {}),
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const msg = `HTTP ${res.status} ${res.statusText} – ${text || url}`;
      if (res.status === 401) console.warn('Não autorizado. Faça login.', msg);
      if (res.status === 404) console.warn('Endpoint não encontrado.', msg);
      throw new Error(msg);
    }

    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  }

  // ===== Helpers visuais / DOM =====
  const $  = (s, ctx=document) => ctx.querySelector(s);
  const $$ = (s, ctx=document) => Array.from(ctx.querySelectorAll(s));
  const when = iso => { const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleString('pt-BR'); };
  const scrollToEnd = node => { if (node) node.scrollTop = node.scrollHeight; };

  // ===== Querystring util =====
  const qs = new URLSearchParams(location.search);
  const PACK_ID   = (qs.get('pack')   || '').replace(/[^\d]/g,'');
  const CLAIM_IDS = (qs.get('claims') || '')
                      .split(',')
                      .map(s => s.replace(/[^\d]/g,''))
                      .filter(Boolean);

  // ===== Elementos
  const el = {
    // abas
    abaCliente:      $('#abaCliente'),
    abaPlataforma:   $('#abaPlataforma'),
    // painéis
    painelCliente:    $('#painel-cliente'),
    painelPlataforma: $('#painel-plataforma'),
    // msgs
    msgsCliente:     $('#mensagensCliente'),
    msgsPlataforma:  $('#mensagensPlataforma'),
    // layout
    mainContent: $('.main-content'),
    leftPanel:   $('.left-panel'),
    // blocos da coluna esquerda
    clienteTools:   $('#cliente-tools'),
    platSide:       $('#plat-side'),
    platSearch:     $('#platSearch'),
    platThreadList: $('#platThreadList'),
    // composers
    compCli:     $('#composerCliente'),
    compPlat:    $('#composerPlataforma'),
    txtCli:      $('#msgInputCliente'),
    txtPlat:     $('#msgInputPlataforma'),
    upCli:       $('#uploadCliente'),
    upPlat:      $('#uploadPlataforma'),
    btnUpCli:    $('#btnFileCliente'),
    btnUpPlat:   $('#btnFilePlataforma'),
    // header da plataforma
    headerPlatName:  $('#painel-plataforma .header-name'),
  };

  // ===== Estado
  const state = {
    active: 'cliente',               // 'cliente' | 'plataforma'
    // Cliente (pack)
    packId: PACK_ID || null,
    cliente: [],                     // mensagens do pack
    // Plataforma (claims)
    platThreads: [],                 // [{type:'claim', id:'5319...', label:'Claim #5319...', subtitle:''}]
    platActiveId: null,              // claim selecionado (string)
  };
  const platMsgsById = Object.create(null); // { claimId: [msgs] }

  // ===== Garantias (composer fora da área de mensagens)
  function ensureComposerPlacement() {
    // Cliente
    if (el.compCli && el.painelCliente && el.compCli.parentElement !== el.painelCliente) {
      el.painelCliente.appendChild(el.compCli);
    }
    if (el.compCli && el.msgsCliente && el.msgsCliente.contains(el.compCli)) {
      el.painelCliente.appendChild(el.compCli);
    }
    // Plataforma
    if (el.compPlat && el.painelPlataforma && el.compPlat.parentElement !== el.painelPlataforma) {
      el.painelPlataforma.appendChild(el.compPlat);
    }
    if (el.compPlat && el.msgsPlataforma && el.msgsPlataforma.contains(el.compPlat)) {
      el.painelPlataforma.appendChild(el.compPlat);
    }
  }

  // ===== Responsivo — deixa a coluna visível na aba Plataforma
  function syncLeftPanelVisibility() {
    if (!el.leftPanel) return;
    const wide = window.innerWidth >= 1024;
    el.leftPanel.style.display = (state.active === 'plataforma' || wide) ? '' : 'none';
  }

  /* =====================================================================
   * INTEGRAÇÃO: Carregar mensagens reais
   * ===================================================================*/

  // ---- Cliente (pack)
  async function fetchClienteMessages() {
    if (!state.packId) return; // sem pack definido, deixa vazio
    const data = await jfetch(`${API}/chat/messages?type=pack&id=${state.packId}`);
    state.cliente = Array.isArray(data?.messages) ? data.messages : [];
  }

  // ---- Plataforma (claim)
  async function fetchPlataformaMessages(claimId) {
    if (!claimId) return;
    const data = await jfetch(`${API}/chat/messages?type=claim&id=${claimId}`);
    platMsgsById[claimId] = Array.isArray(data?.messages) ? data.messages : [];
  }

  // Lista de threads (claims)
  async function buildPlatThreads() {
    if (CLAIM_IDS.length) {
      state.platThreads = CLAIM_IDS.map(id => ({
        type: 'claim',
        id,
        label: `Claim #${id}`,
        subtitle: '' // opcional: pode preencher com /returns/by-claim/:id
      }));
      state.platActiveId = state.platThreads[0]?.id || null;
      return;
    }

    // fallback: tenta últimas comunicações para achar claims (opcional)
    try {
      const notices = await jfetch(`${API}/communications/notices?limit=10&offset=0`);
      const found = new Set();
      const out = [];
      for (const n of (notices?.results || notices || [])) {
        const cid = String(n?.claim_id || n?.payload?.claim_id || '').replace(/[^\d]/g,'');
        if (cid && !found.has(cid)) {
          found.add(cid);
          out.push({ type:'claim', id:cid, label:`Claim #${cid}`, subtitle: '' });
        }
      }
      if (out.length) {
        state.platThreads = out;
        state.platActiveId = out[0].id;
      }
    } catch (_) {
      // se falhar, mantém vazio
    }
  }

  /* =====================================================================
   * Render
   * ===================================================================*/

  function bubble(m) {
    const isSeller = /seller|respond/.test((m.author_role || '').toLowerCase());
    const side = isSeller ? 'out' : 'in';
    const wrap = document.createElement('div');
    wrap.className = `msg ${side}`;
    wrap.innerHTML = `
      <div class="meta"><span>${m.author_name || m.author_role || ''}</span> • <span>${when(m.created_at)}</span></div>
      <div class="bubble">${(m.text || '').replace(/\n/g,'<br>')}</div>
    `;
    if (Array.isArray(m.attachments) && m.attachments.length) {
      m.attachments.forEach(a => {
        const link = document.createElement('a');
        link.className = 'attachment';
        link.href = a.url || '#';
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = a.name || a.id || 'arquivo';
        wrap.appendChild(link);
      });
    }
    return wrap;
  }

  function renderSkeletons() {
    ensureComposerPlacement();
    const alvo = state.active === 'plataforma' ? el.msgsPlataforma : el.msgsCliente;
    if (alvo) alvo.innerHTML = `<div class="loading">Carregando mensagens...</div>`;
  }

  function renderCliente() {
    ensureComposerPlacement();
    const box = el.msgsCliente;
    if (!box) return;
    box.innerHTML = '';
    const list = state.cliente || [];
    if (!state.packId) {
      box.innerHTML = `<div class="empty-text-centered">Defina ?pack=ID na URL para carregar o chat com o cliente.</div>`;
      return;
    }
    if (!list.length) {
      box.innerHTML = `<div class="empty-text-centered">Nenhuma mensagem do cliente.</div>`;
      return;
    }
    const frag = document.createDocumentFragment();
    list.forEach(m => frag.appendChild(bubble(m)));
    box.appendChild(frag);
    scrollToEnd(box);
  }

  function renderPlataforma() {
    ensureComposerPlacement();
    const box = el.msgsPlataforma;
    if (!box) return;
    box.innerHTML = '';

    const list = platMsgsById[state.platActiveId] || [];
    if (!state.platActiveId) {
      box.innerHTML = `<div class="empty-text-centered">Selecione uma mediação na esquerda.</div>`;
      return;
    }
    if (!list.length) {
      box.innerHTML = `<div class="empty-text-centered">Nenhuma mensagem de mediação ainda.</div>`;
      return;
    }
    const frag = document.createDocumentFragment();
    list.forEach(m => frag.appendChild(bubble(m)));
    box.appendChild(frag);
    scrollToEnd(box);
  }

  function render() {
    if (state.active === 'cliente') renderCliente();
    else renderPlataforma();
  }

  // ===== Lista de threads da plataforma (coluna esquerda)
  function renderPlatThreadList() {
    if (!el.platThreadList) return;
    const q = (el.platSearch?.value || '').trim().toLowerCase();

    el.platThreadList.innerHTML = '';
    const items = state.platThreads.filter(t => {
      if (!q) return true;
      return (
        t.id.toLowerCase().includes(q) ||
        (t.label||'').toLowerCase().includes(q) ||
        (t.subtitle||'').toLowerCase().includes(q)
      );
    });

    if (!items.length) {
      el.platThreadList.innerHTML = `<li class="thread-empty">Nada encontrado</li>`;
      return;
    }

    const frag = document.createDocumentFragment();
    for (const t of items) {
      const li = document.createElement('li');
      li.className = 'thread-item' + (t.id === state.platActiveId ? ' active' : '');
      li.dataset.tid = t.id;
      li.innerHTML = `
        <div class="thread-title">${t.label}</div>
        <div class="thread-sub">${t.subtitle || ''}</div>
      `;
      li.addEventListener('click', async () => {
        await setPlatActive(t.id);
      });
      frag.appendChild(li);
    }
    el.platThreadList.appendChild(frag);
  }

  async function setPlatActive(claimId, opts = {}) {
    state.platActiveId = claimId;

    // Atualiza placeholder / título
    const thr = state.platThreads.find(t => t.id === claimId);
    if (el.txtPlat) {
      el.txtPlat.placeholder = thr
        ? `Fale com a plataforma sobre ${thr.label}...`
        : 'Fale com a plataforma (mediação)...';
    }
    if (el.headerPlatName) {
      el.headerPlatName.textContent = thr ? `Mediação — ${thr.label}` : 'Mediação';
    }

    // Busca mensagens reais da mediação
    try {
      renderSkeletons();
      await fetchPlataformaMessages(claimId);
    } catch (err) {
      console.error(err);
    }

    if (!opts.skipRenderList) renderPlatThreadList();
    renderPlataforma();
  }

  // ===== Abas
  function setAba(key) {
    state.active = key;
    const isCliente = key === 'cliente';

    el.abaCliente?.setAttribute('aria-selected', String(isCliente));
    el.abaPlataforma?.setAttribute('aria-selected', String(!isCliente));

    el.painelCliente.hidden    = !isCliente;
    el.painelPlataforma.hidden =  isCliente;

    // Alterna os blocos da coluna esquerda
    if (el.clienteTools) el.clienteTools.hidden = !isCliente;
    if (el.platSide)     el.platSide.hidden     = isCliente;

    // Classe de layout
    el.mainContent?.classList.toggle('plataforma', !isCliente);

    // Coluna esquerda visível na Plataforma
    syncLeftPanelVisibility();

    ensureComposerPlacement();
    render();
  }

  function handleTabKeys(e) {
    const tabs = [el.abaCliente, el.abaPlataforma];
    const idx = tabs.indexOf(document.activeElement);
    if (idx < 0) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = e.key === 'ArrowRight' ? (idx + 1) % tabs.length : (idx - 1 + tabs.length) % tabs.length;
      setAba(next === 0 ? 'cliente' : 'plataforma');
      tabs[next].focus();
    }
  }

  // ===== Envio / anexos
  function autoresize(ta) {
    if (!ta) return;
    ta.style.height = '0px';
    const max = 140;
    ta.style.height = Math.min(ta.scrollHeight, max) + 'px';
  }

  function wireComposer({ form, textarea, upload, btnUpload, destino }) {
    if (!form || !textarea) return;

    // abrir seletor de arquivos
    btnUpload?.addEventListener('click', () => upload?.click());

    // autoresize
    textarea.addEventListener('input', () => autoresize(textarea));
    autoresize(textarea);

    // enviar
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = (textarea.value || '').trim();
      const files = Array.from(upload?.files || []);

      if (!text && files.length === 0) return;

      try {
        // CLIENTE (pack): endpoint universal /chat/send
        if (destino === 'cliente') {
          if (!state.packId) return;
          await jfetch(`${API}/chat/send`, {
            method: 'POST',
            body: JSON.stringify({ type: 'pack', id: state.packId, text })
          });
          // refetch após enviar
          await fetchClienteMessages();
          renderCliente();
        }

        // PLATAFORMA (claim): upload + send-message
        if (destino === 'plataforma') {
          const claimId = state.platActiveId;
          if (!claimId) return;

          // 1) Uploads (se houver)
          let attachments = [];
          if (files.length) {
            for (const f of files) {
              const fd = new FormData();
              fd.append('file', f, f.name);
              const res = await fetch(`${API}/claims/${encodeURIComponent(claimId)}/attachments`, {
                method: 'POST',
                credentials: 'include',
                headers: authHeaders({ json: false }), // não seta Content-Type
                body: fd
              });
              if (!res.ok) {
                const t = await res.text().catch(()=> '');
                throw new Error(`Falha no upload: ${res.status} ${t}`);
              }
              const j = await res.json();
              const name = j?.filename || j?.file_name;
              if (name) attachments.push(name);
            }
          }

          // 2) Envia a mensagem (normalmente para o 'mediator')
          await jfetch(`${API}/claims/${encodeURIComponent(claimId)}/messages`, {
            method: 'POST',
            body: JSON.stringify({
              receiver_role: 'mediator',
              message: text,
              attachments
            })
          });

          // 3) Refetch e re-render
          await fetchPlataformaMessages(claimId);
          renderPlataforma();
        }
      } catch (err) {
        console.error(err);
        alert('Falha ao enviar mensagem. Verifique o token e os IDs.');
      } finally {
        textarea.value = '';
        if (upload) upload.value = '';
        autoresize(textarea);
      }
    });
  }

  // ===== Eventos
  el.abaCliente?.addEventListener('click', () => setAba('cliente'));
  el.abaPlataforma?.addEventListener('click', () => setAba('plataforma'));
  el.abaCliente?.addEventListener('keydown', handleTabKeys);
  el.abaPlataforma?.addEventListener('keydown', handleTabKeys);

  // Busca de threads (plataforma)
  el.platSearch?.addEventListener('input', renderPlatThreadList);

  // Conecta composers
  wireComposer({ form: el.compCli,  textarea: el.txtCli,  upload: el.upCli,  btnUpload: el.btnUpCli,  destino: 'cliente' });
  wireComposer({ form: el.compPlat, textarea: el.txtPlat, upload: el.upPlat, btnUpload: el.btnUpPlat, destino: 'plataforma' });

  // Responsivo
  window.addEventListener('resize', syncLeftPanelVisibility);

  // ===== Boot
  (async () => {
    ensureComposerPlacement();

    // monta lista de mediações (coluna esquerda)
    await buildPlatThreads();

    // carrega mensagens iniciais (cliente/plataforma)
    renderSkeletons();
    try {
      if (state.packId)       await fetchClienteMessages();
      if (state.platActiveId) await fetchPlataformaMessages(state.platActiveId);
    } catch (err) {
      console.error(err);
    }

    // desenha lista/headers
    renderPlatThreadList();

    // Seleciona aba inicial (se houver claim, começa na Plataforma)
    setAba(state.platActiveId ? 'plataforma' : 'cliente');
    syncLeftPanelVisibility();

    // Ajusta placeholder e header da plataforma
    if (state.platActiveId) {
      const thr = state.platThreads.find(t => t.id === state.platActiveId);
      if (el.txtPlat) el.txtPlat.placeholder = `Fale com a plataforma sobre ${thr?.label || 'Mediação'}...`;
      if (el.headerPlatName) el.headerPlatName.textContent = `Mediação — ${thr?.label || ''}`;
    }

    // Render final
    render();
  })();
})();
