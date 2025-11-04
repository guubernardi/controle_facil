/* Chat — Cliente | Plataforma (composer persistente + threads de mediação)
 * Boot automático:
 *  - Tenta ler claims de ?claims=, ?claim=, ?claim_id= ou ?id=
 *  - Se não vier nada, busca em /api/ml/communications/notices (últimas mediações)
 *  - Prefetch: carrega mensagens de até 10 mediações logo no boot
 *  - Seleciona a primeira claim e carrega as mensagens
 *  - Tenta resolver o pack a partir da claim e carrega o chat com cliente
 */
;(() => {
  // ===== Config backend =====
  const API = '/api/ml'; // base de rotas do backend

  function authHeaders() {
    const token    = localStorage.getItem('ML_SELLER_TOKEN') || '';
    const sellerId = localStorage.getItem('ML_SELLER_ID')    || '';
    const h = { 'Content-Type': 'application/json' };
    if (token)    h['x-seller-token'] = token;
    if (sellerId) h['x-seller-id']    = sellerId;
    return h;
  }

  async function jfetch(url, opts = {}) {
    const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), ...authHeaders() } });
    const ct = res.headers.get('content-type') || '';
    const body = ct.includes('application/json') ? await res.json().catch(()=>null) : await res.text().catch(()=> '');
    if (!res.ok) {
      const msg = (body && (body.error || body.message)) || `HTTP ${res.status}`;
      const detail = body && body.detail ? body.detail : null;
      throw new Error(`${msg}${detail ? ` — ${detail}` : ''}`);
    }
    return body;
  }

  // ===== Helpers de DOM =====
  const $  = (s, ctx=document) => ctx.querySelector(s);
  const $$ = (s, ctx=document) => Array.from(ctx.querySelectorAll(s));
  const when = iso => { const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleString('pt-BR'); };
  const uid  = (p='m') => `${p}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  const scrollToEnd = node => { if (node) node.scrollTop = node.scrollHeight; };

  // ===== Querystring =====
  const qs = new URLSearchParams(location.search);
  const PACK_ID_PARAM = (qs.get('pack') || '').replace(/[^\w\-:.]/g,'');
  // aceita várias formas: claims, claim, claim_id, id
  const RAW_CLAIMS =
    (qs.get('claims')   || qs.get('claim') || qs.get('claim_id') || qs.get('id') || '')
      .split(',')
      .map(s => s.replace(/[^\d]/g,''))
      .filter(Boolean);

  // ===== Elementos =====
  const el = {
    abaCliente:      $('#abaCliente'),
    abaPlataforma:   $('#abaPlataforma'),
    painelCliente:    $('#painel-cliente'),
    painelPlataforma: $('#painel-plataforma'),
    msgsCliente:     $('#mensagensCliente'),
    msgsPlataforma:  $('#mensagensPlataforma'),
    mainContent:     $('.main-content'),
    leftPanel:       $('.left-panel'),
    // lateral (plataforma)
    platSide:        $('#plat-side'),
    platSearch:      $('#platSearch'),
    platThreadList:  $('#platThreadList'),
    // composers
    compCli:     $('#composerCliente'),
    compPlat:    $('#composerPlataforma'),
    txtCli:      $('#msgInputCliente'),
    txtPlat:     $('#msgInputPlataforma'),
    upCli:       $('#uploadCliente'),
    upPlat:      $('#uploadPlataforma'),
    btnUpCli:    $('#btnFileCliente'),
    btnUpPlat:   $('#btnFilePlataforma'),
    // header plataforma
    headerPlatName:  $('#painel-plataforma .header-name'),
  };

  // ===== Estado =====
  const state = {
    active: 'plataforma', // inicia na plataforma se houver claim
    packId: PACK_ID_PARAM || null,
    cliente: [],

    platThreads: [],       // [{type:'claim', id, label, subtitle}]
    platActiveId: null,    // claim selecionada
  };
  const platMsgsById = Object.create(null); // { claimId: [msgs] }

  // ===== Garantias de layout =====
  function ensureComposerPlacement() {
    if (el.compCli && el.painelCliente && el.compCli.parentElement !== el.painelCliente) {
      el.painelCliente.appendChild(el.compCli);
    }
    if (el.compPlat && el.painelPlataforma && el.compPlat.parentElement !== el.painelPlataforma) {
      el.painelPlataforma.appendChild(el.compPlat);
    }
  }

  function syncLeftPanelVisibility() {
    if (!el.leftPanel) return;
    const wide = window.innerWidth >= 1024;
    el.leftPanel.style.display = (state.active === 'plataforma' || wide) ? '' : 'none';
  }

  // ===== Seller: garantir ML_SELLER_ID =====
  async function ensureSellerId() {
    if (localStorage.getItem('ML_SELLER_ID')) return true;
    try {
      const j = await jfetch(`${API}/stores`).catch(()=>null);
      const stores = (j && j.stores) || j || [];
      const pick = stores.find(s => String(s?.active) === 'true') || stores[0];
      if (pick) {
        localStorage.setItem('ML_SELLER_ID', String(pick.user_id || pick.id));
        console.log('⚙️ Loja (seller) auto:', localStorage.ML_SELLER_ID);
        return true;
      }
    } catch {}
    console.warn('⚠️ Sem ML_SELLER_ID — selecione uma loja.');
    return false;
  }

  /* =====================================================================
   * INTEGRAÇÃO: Carregar mensagens reais
   * ===================================================================*/
  async function fetchClienteMessages() {
    if (!state.packId) return;
    const data = await jfetch(`${API}/chat/messages?type=pack&id=${encodeURIComponent(state.packId)}`);
    state.cliente = Array.isArray(data?.messages) ? data.messages : [];
  }

  async function fetchPlataformaMessages(claimId) {
    if (!claimId) return;
    const data = await jfetch(`${API}/claims/${encodeURIComponent(claimId)}/messages`);
    platMsgsById[claimId] = Array.isArray(data?.messages) ? data.messages : [];
  }

  async function fetchClaimDetail(claimId) {
    // tenta alguns caminhos possíveis do backend
    const paths = [
      `${API}/claims/${encodeURIComponent(claimId)}`,               // GET detalhe (se exposto)
      `${API}/claims/${encodeURIComponent(claimId)}/detail`,       // alternativo
    ];
    for (const p of paths) {
      try {
        const d = await jfetch(p);
        if (d && (d.id || d.resource_id || d.stage || d.status)) return d;
      } catch { /* tenta o próximo */ }
    }
    return null;
  }

  async function tryResolvePackFromClaim(claimId) {
    if (state.packId) return state.packId; // já resolvido
    try {
      const detail = await fetchClaimDetail(claimId);
      const orderId = detail?.resource_id || detail?.order_id || null;
      if (!orderId) return null;

      // busca ordem para extrair pack_id
      const order = await jfetch(`${API}/orders/${encodeURIComponent(orderId)}`).catch(()=>null);
      const packId = order?.pack_id || order?.packId || null;
      if (packId) {
        state.packId = String(packId);
        try { localStorage.setItem('LAST_PACK_ID', state.packId); } catch {}
        await fetchClienteMessages(); // já deixa carregado
        return state.packId;
      }
    } catch (e) {
      console.warn('Não foi possível resolver pack da claim:', claimId, e?.message||e);
    }
    return null;
  }

  async function discoverThreadsFromNotices(limit = 20, offset = 0) {
    try {
      const notices = await jfetch(`${API}/communications/notices?limit=${limit}&offset=${offset}`);
      const found = new Set();
      const out = [];
      const list = notices?.results || notices || [];
      for (const n of list) {
        const cid = String(n?.claim_id || n?.payload?.claim_id || '').replace(/[^\d]/g,'');
        if (cid && !found.has(cid)) {
          found.add(cid);
          out.push({ type: 'claim', id: cid, label: `Claim #${cid}`, subtitle: '' });
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  async function buildPlatThreads() {
    // 1) claims via URL
    if (RAW_CLAIMS.length) {
      state.platThreads = RAW_CLAIMS.map(id => ({ type:'claim', id, label:`Claim #${id}`, subtitle:'' }));
      state.platActiveId = state.platThreads[0]?.id || null;
      return;
    }

    // 2) última claim usada (se não vier nada na URL)
    const last = (localStorage.getItem('CHAT_LAST_CLAIM') || '').replace(/[^\d]/g,'');
    if (last) {
      state.platThreads = [{ type:'claim', id:last, label:`Claim #${last}`, subtitle:'' }];
      state.platActiveId = last;
      return;
    }

    // 3) tenta descobrir pelas notices (mediações recentes)
    const fromNotices = await discoverThreadsFromNotices(30, 0);
    if (fromNotices.length) {
      state.platThreads = fromNotices;
      state.platActiveId = fromNotices[0].id;
      return;
    }

    // 4) sem nada encontrado: mantém vazio; UI mostrará instruções
    state.platThreads = [];
    state.platActiveId = null;
  }

  // Prefetch mensagens das primeiras N claims (para “abrir pronto”)
  async function prefetchPlatMessages(limit = 10) {
    const ids = (state.platThreads || []).map(t => t.id).slice(0, limit);
    for (const id of ids) {
      try { await fetchPlataformaMessages(id); } catch (e) { console.warn('prefetch fail claim', id, e?.message||e); }
    }
  }

  /* =====================================================================
   * Render
   * ===================================================================*/
  function bubble(m) {
    const isSeller = /seller|respond/.test((m.sender_role || m.author_role || '').toLowerCase());
    const side = isSeller ? 'out' : 'in';
    const wrap = document.createElement('div');
    wrap.className = `msg ${side}`;
    wrap.innerHTML = `
      <div class="meta"><span>${m.author_name || m.sender_role || ''}</span> • <span>${when(m.date_created || m.created_at)}</span></div>
      <div class="bubble">${(m.message || m.text || '').replace(/\n/g,'<br>')}</div>
    `;
    const atts = m.attachments || [];
    if (Array.isArray(atts) && atts.length) {
      atts.forEach(a => {
        const link = document.createElement('a');
        link.className = 'attachment';
        const fname = a.filename || a.file_name || a.original_filename || 'arquivo';
        link.textContent = fname;
        if (a.url) { link.href = a.url; link.target = '_blank'; link.rel = 'noopener'; }
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
      box.innerHTML = `<div class="empty-text-centered">Nenhum chat de cliente selecionado.</div>`;
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
      box.innerHTML = `
        <div class="empty-text-centered">
          Nenhuma mediação selecionada.<br>
        </div>`;
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
    if (state.active === 'plataforma') renderPlataforma();
    else renderCliente();
  }

  // ===== Lista lateral (plataforma)
  function renderPlatThreadList() {
    if (!el.platThreadList) return;
    const q = (el.platSearch?.value || '').trim().toLowerCase();
    el.platThreadList.innerHTML = '';

    const items = (state.platThreads || []).filter(t => {
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
      li.addEventListener('click', async () => { await setPlatActive(t.id); });
      frag.appendChild(li);
    }
    el.platThreadList.appendChild(frag);
  }

  async function setPlatActive(claimId, opts = {}) {
    state.platActiveId = claimId;

    // UI
    const thr = state.platThreads.find(t => t.id === claimId);
    if (el.txtPlat) el.txtPlat.placeholder = thr ? `Fale com a plataforma sobre ${thr.label}...` : 'Fale com a plataforma (mediação)...';
    if (el.headerPlatName) el.headerPlatName.textContent = thr ? `Mediação — ${thr.label}` : 'Mediação';

    try {
      renderSkeletons();
      await fetchPlataformaMessages(claimId);
    } catch (err) {
      console.error(err);
    }

    // descobre e carrega chat do cliente (pack) em background
    try {
      await tryResolvePackFromClaim(claimId);
      if (state.packId && (!state.cliente || state.cliente.length === 0)) {
        await fetchClienteMessages();
      }
    } catch (e) { console.warn(e); }

    try { localStorage.setItem('CHAT_LAST_CLAIM', String(claimId)); } catch {}
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

    el.mainContent?.classList.toggle('plataforma', !isCliente);
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

  // ===== Composer
  function autoresize(ta) {
    if (!ta) return;
    ta.style.height = '0px';
    const max = 140;
    ta.style.height = Math.min(ta.scrollHeight, max) + 'px';
  }

  function wireComposer({ form, textarea, upload, btnUpload, destino }) {
    if (!form || !textarea) return;

    btnUpload?.addEventListener('click', () => upload?.click());

    textarea.addEventListener('input', () => autoresize(textarea));
    autoresize(textarea);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text  = (textarea.value || '').trim();
      const files = Array.from(upload?.files || []);
      if (!text && files.length === 0) return;

      try {
        if (destino === 'cliente') {
          if (!state.packId) return;
          await jfetch(`${API}/chat/send`, {
            method: 'POST',
            body: JSON.stringify({ type: 'pack', id: state.packId, text })
          });
          await fetchClienteMessages();
          renderCliente();
        }

        if (destino === 'plataforma') {
          const claimId = state.platActiveId;
          if (!claimId) return;

          let attachments = [];
          if (files.length) {
            for (const f of files) {
              const fd = new FormData();
              fd.append('file', f, f.name);
              const res = await fetch(`${API}/claims/${encodeURIComponent(claimId)}/attachments`, {
                method: 'POST',
                headers: { ...authHeaders() }, // sem forçar Content-Type
                body: fd
              });
              const j = await res.json();
              if (j?.filename || j?.file_name) attachments.push(j.filename || j.file_name);
            }
          }

          await jfetch(`${API}/claims/${encodeURIComponent(claimId)}/messages`, {
            method: 'POST',
            body: JSON.stringify({
              receiver_role: 'mediator', // se não estiver em disputa, ajuste para 'complainant'
              message: text,
              attachments
            })
          });

          await fetchPlataformaMessages(claimId);
          renderPlataforma();
        }
      } catch (err) {
        console.error(err);
        alert('Falha ao enviar mensagem. Confira loja/claim.');
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
  el.platSearch?.addEventListener('input', renderPlatThreadList);

  wireComposer({ form: el.compCli,  textarea: el.txtCli,  upload: el.upCli,  btnUpload: el.btnUpCli,  destino: 'cliente' });
  wireComposer({ form: el.compPlat, textarea: el.txtPlat, upload: el.upPlat, btnUpload: el.btnUpPlat, destino: 'plataforma' });

  window.addEventListener('resize', syncLeftPanelVisibility);

  // ===== Boot =====
  (async () => {
    ensureComposerPlacement();

    // garante seller
    await ensureSellerId();

    // descobre threads (URL -> última -> notices)
    await buildPlatThreads();

    // prefetch mensagens de várias claims p/ abrir já “carregado”
    await prefetchPlatMessages(10);

    // se tiver claim ativa, começa na aba plataforma
    state.active = state.platActiveId ? 'plataforma' : (state.packId ? 'cliente' : 'plataforma');

    // tenta resolver pack a partir da claim ativa (carrega cliente em background)
    if (!state.packId && state.platActiveId) {
      await tryResolvePackFromClaim(state.platActiveId);
      if (state.packId) await fetchClienteMessages();
    } else if (state.packId) {
      await fetchClienteMessages();
    }

    // carrega mensagens da claim ativa (garantia após prefetch)
    if (state.platActiveId && !platMsgsById[state.platActiveId]) {
      try { await fetchPlataformaMessages(state.platActiveId); } catch {}
    }

    // pinta lista lateral e seleciona título/placeholder
    renderPlatThreadList();
    if (state.platActiveId) {
      const thr = state.platThreads.find(t => t.id === state.platActiveId);
      if (el.txtPlat) el.txtPlat.placeholder = `Fale com a plataforma sobre ${thr?.label || 'Mediação'}...`;
      if (el.headerPlatName) el.headerPlatName.textContent = `Mediação — ${thr?.label || ''}`;
    }

    // exibe a aba correta e renderiza
    setAba(state.active);
    syncLeftPanelVisibility();
    render();
  })();
})();
