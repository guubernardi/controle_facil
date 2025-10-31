/* Chat — abas Cliente | Plataforma
 * - Composer com textarea, anexos e enviar (Ctrl/⌘+Enter)
 * - Filtra por canal (cliente|plataforma) + role
 * - Esconde coluna esquerda na aba "Plataforma"
 */
;(() => {
  // ===== Helpers
  const $  = (s, ctx=document) => ctx.querySelector(s);
  const $$ = (s, ctx=document) => Array.from(ctx.querySelectorAll(s));
  const when = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? '—' : d.toLocaleString('pt-BR');
  };
  const uid = (p='m') => `${p}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  function scrollToBottom(box, force=false){
    if (!box) return;
    const nearBottom = (box.scrollHeight - box.scrollTop - box.clientHeight) < 80;
    if (force || nearBottom) box.scrollTop = box.scrollHeight;
  }
  function autoResize(t){
    if (!t) return;
    t.style.height = 'auto';
    t.style.height  = Math.min(t.scrollHeight, 320) + 'px';
  }

  // ===== Elementos
  const el = {
    // abas
    abaCliente: $('#abaCliente'),
    abaPlataforma: $('#abaPlataforma'),
    // painéis
    painelCliente: $('#painel-cliente'),
    painelPlataforma: $('#painel-plataforma'),
    // mensagens
    mensagensCliente: $('#mensagensCliente'),
    mensagensPlataforma: $('#mensagensPlataforma'),
    // layout
    mainContent: $('.main-content'),
    leftPanel: $('.left-panel'),
    // composer cliente
    formCliente: $('#formCliente'),
    textoCliente: $('#textoCliente'),
    arquivoCliente: $('#arquivoCliente'),
    btnEnviarCliente: $('#btnEnviarCliente'),
    prevCliente: $('#prevCliente'),
    // composer plataforma
    formPlataforma: $('#formPlataforma'),
    textoPlataforma: $('#textoPlataforma'),
    arquivoPlataforma: $('#arquivoPlataforma'),
    btnEnviarPlataforma: $('#btnEnviarPlataforma'),
    prevPlataforma: $('#prevPlataforma'),
  };

  // ===== Estado
  const state = {
    active: 'cliente', // 'cliente' | 'plataforma'
    mensagens: [],     // { id, canal: 'cliente'|'plataforma', author_role, author_name, text, attachments[], created_at }
    carregando: false,
  };

  // ===== Mocks (substitua por fetch real)
  async function carregarMensagens(){
    state.carregando = true;
    renderSkeletons();
    const now = Date.now();
    await new Promise(r => setTimeout(r, 400));
    state.mensagens = Array.from({length: 18}).map((_, i) => {
      const role  = ['buyer','seller','platform'][i % 3];
      const canal = role === 'platform' ? 'plataforma' : 'cliente';
      return {
        id: uid(),
        canal,
        author_role: role,
        author_name: role === 'buyer' ? 'Comprador' : role === 'seller' ? 'Vendedor' : 'Mediador',
        text: role === 'platform'
              ? 'Mensagem da mediação do Mercado Livre.'
              : role === 'buyer'
                ? 'Olá, tive um problema com o produto.'
                : 'Claro! Vamos resolver.',
        attachments: i === 2 ? [{ id:'a1', name:'foto.jpg', url:'#', mime:'image/jpeg' }] : [],
        created_at: new Date(now - i*90*1000).toISOString(),
      };
    });
    state.carregando = false;
    render();
  }

  // ===== Render
  function bubble(m){
    const isSeller = /seller|respond/i.test(m.author_role || '');
    const lado = isSeller ? 'out' : 'in';
    const wrap = document.createElement('div');
    wrap.className = `msg ${lado}`;
    wrap.innerHTML = `
      <div class="meta"><span>${m.author_name || m.author_role}</span> • <span>${when(m.created_at)}</span></div>
      <div class="bubble">${(m.text || '').replace(/\n/g, '<br>')}</div>
    `;
    if (Array.isArray(m.attachments) && m.attachments.length){
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

  function renderSkeletons(){
    const alvo = state.active === 'plataforma' ? el.mensagensPlataforma : el.mensagensCliente;
    if (alvo) alvo.innerHTML = `<div class="loading">Carregando mensagens...</div>`;
  }

  function renderCliente(){
    const msgs = state.mensagens.filter(m =>
      (m.canal ? m.canal === 'cliente' : /buyer|seller|complain|respond/i.test(m.author_role || ''))
    );
    const box = el.mensagensCliente;
    box.innerHTML = '';
    if (!msgs.length){
      box.innerHTML = `<div class="empty-text-centered">Nenhuma mensagem do cliente.</div>`;
      return;
    }
    const frag = document.createDocumentFragment();
    msgs.forEach(m => frag.appendChild(bubble(m)));
    box.appendChild(frag);
    scrollToBottom(box);
  }

  function renderPlataforma(){
    const msgs = state.mensagens.filter(m =>
      (m.canal ? m.canal === 'plataforma' : /platform|mediator|system/i.test(m.author_role || ''))
    );
    const box = el.mensagensPlataforma;
    box.innerHTML = '';
    if (!msgs.length){
      box.innerHTML = `<div class="empty-text-centered">Nenhuma mensagem de mediação ainda.</div>`;
      return;
    }
    const frag = document.createDocumentFragment();
    msgs.forEach(m => frag.appendChild(bubble(m)));
    box.appendChild(frag);
    scrollToBottom(box);
  }

  function render(){
    if (state.active === 'cliente') renderCliente();
    else renderPlataforma();
  }

  // ===== Abas
  function setAba(key){
    state.active = key;
    const isCliente = key === 'cliente';
    // visuais
    el.abaCliente.setAttribute('aria-selected', String(isCliente));
    el.abaPlataforma.setAttribute('aria-selected', String(!isCliente));
    // painéis
    el.painelCliente.hidden     = !isCliente;
    el.painelPlataforma.hidden  =  isCliente;
    // layout (CSS usa .plataforma para remover coluna esquerda)
    if (el.mainContent) el.mainContent.classList.toggle('plataforma', !isCliente);
    try { localStorage.setItem('rf_chat_tab', key); } catch {}
    render();
  }

  function handleTabKeys(e){
    const tabs = [el.abaCliente, el.abaPlataforma];
    const idx = tabs.indexOf(document.activeElement);
    if (idx < 0) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft'){
      e.preventDefault();
      const next = e.key === 'ArrowRight' ? (idx + 1) % tabs.length : (idx - 1 + tabs.length) % tabs.length;
      const key  = next === 0 ? 'cliente' : 'plataforma';
      setAba(key); tabs[next].focus();
    }
  }

  // ===== Composer (envio)
  function getFilesArray(input){
    const arr = [];
    if (!input?.files) return arr;
    for (const f of input.files){
      arr.push({ id: uid('f'), name: f.name, url: '#', mime: f.type || 'application/octet-stream' });
    }
    return arr;
  }

  function limparComposer({ textarea, inputFile, previews }){
    if (textarea){ textarea.value=''; autoResize(textarea); }
    if (inputFile){ inputFile.value=''; }
    if (previews){ previews.hidden = true; previews.innerHTML = ''; }
  }

  function renderPreviews(input, box){
    if (!input || !box) return;
    const files = Array.from(input.files || []);
    box.innerHTML = '';
    if (!files.length){ box.hidden = true; return; }
    files.forEach(f => {
      const div = document.createElement('div');
      div.className = 'preview';
      div.textContent = f.name.split('.').pop()?.toUpperCase() || 'ARQ';
      const rm = document.createElement('button');
      rm.className = 'rm'; rm.type='button'; rm.textContent='×';
      rm.onclick = () => { input.value=''; renderPreviews(input, box); };
      div.appendChild(rm);
      box.appendChild(div);
    });
    box.hidden = false;
  }

  function toggleButton(textarea, btn){
    if (!textarea || !btn) return;
    btn.disabled = !textarea.value.trim();
  }

  function submitCliente(e){
    e.preventDefault();
    const text = (el.textoCliente.value || '').trim();
    if (!text) return;
    state.mensagens.push({
      id: uid(),
      canal: 'cliente',
      author_role: 'seller',
      author_name: 'Vendedor',
      text,
      attachments: getFilesArray(el.arquivoCliente),
      created_at: new Date().toISOString(),
    });
    limparComposer({ textarea: el.textoCliente, inputFile: el.arquivoCliente, previews: el.prevCliente });
    renderCliente();
    scrollToBottom(el.mensagensCliente, true);
    el.textoCliente.focus();
  }

  function submitPlataforma(e){
    e.preventDefault();
    const text = (el.textoPlataforma.value || '').trim();
    if (!text) return;
    state.mensagens.push({
      id: uid(),
      canal: 'plataforma',
      author_role: 'seller', // vendedor falando com a plataforma
      author_name: 'Vendedor',
      text,
      attachments: getFilesArray(el.arquivoPlataforma),
      created_at: new Date().toISOString(),
    });
    limparComposer({ textarea: el.textoPlataforma, inputFile: el.arquivoPlataforma, previews: el.prevPlataforma });
    renderPlataforma();
    scrollToBottom(el.mensagensPlataforma, true);
    el.textoPlataforma.focus();
  }

  function handleHotkeySubmit(e, submitFn){
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter'){
      e.preventDefault(); submitFn(e);
    }
  }

  // ===== Eventos de abas
  el.abaCliente.addEventListener('click', () => setAba('cliente'));
  el.abaPlataforma.addEventListener('click', () => setAba('plataforma'));
  el.abaCliente.addEventListener('keydown', handleTabKeys);
  el.abaPlataforma.addEventListener('keydown', handleTabKeys);

  // ===== Eventos composer — Cliente
  if (el.formCliente){
    el.formCliente.addEventListener('submit', submitCliente);
    el.textoCliente?.addEventListener('input', () => {
      autoResize(el.textoCliente); toggleButton(el.textoCliente, el.btnEnviarCliente);
    });
    el.textoCliente?.addEventListener('keydown', (e) => handleHotkeySubmit(e, submitCliente));
    el.arquivoCliente?.addEventListener('change', () => renderPreviews(el.arquivoCliente, el.prevCliente));
  }

  // ===== Eventos composer — Plataforma
  if (el.formPlataforma){
    el.formPlataforma.addEventListener('submit', submitPlataforma);
    el.textoPlataforma?.addEventListener('input', () => {
      autoResize(el.textoPlataforma); toggleButton(el.textoPlataforma, el.btnEnviarPlataforma);
    });
    el.textoPlataforma?.addEventListener('keydown', (e) => handleHotkeySubmit(e, submitPlataforma));
    el.arquivoPlataforma?.addEventListener('change', () => renderPreviews(el.arquivoPlataforma, el.prevPlataforma));
  }

  // ===== Boot
  (async () => {
    await carregarMensagens();
    let saved = 'cliente';
    try { const s = localStorage.getItem('rf_chat_tab'); if (s === 'plataforma') saved = 'plataforma'; } catch {}
    setAba(saved);
  })();
})();
