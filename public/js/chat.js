/* Chat — abas Cliente | Plataforma
 * - Filtra mensagens por origem (cliente vs. mediação/plataforma)
 * - Esconde a coluna esquerda quando estiver na aba "Plataforma"
 * - Mock de mensagens (substitua por fetch real quando integrar)
 */
;(() => {
  // ===== Helpers
  const $ = (s, ctx = document) => ctx.querySelector(s)
  const when = (iso) => {
    const d = new Date(iso)
    return isNaN(d) ? '—' : d.toLocaleString('pt-BR')
  }

  // ===== Elementos (IDs em PT)
  const el = {
    // abas
    abaCliente: $('#abaCliente'),
    abaPlataforma: $('#abaPlataforma'),
    // painéis
    painelCliente: $('#painel-cliente'),
    painelPlataforma: $('#painel-plataforma'),
    // áreas de mensagens
    mensagensCliente: $('#mensagensCliente'),
    mensagensPlataforma: $('#mensagensPlataforma'),
    // layout
    mainContent: $('.main-content'),
    leftPanel: $('.left-panel'),
    rightPanel: $('.right-panel'),
  }

  // ===== Estado
  const state = {
    active: 'cliente',         // 'cliente' | 'plataforma'
    mensagens: [],             // [{ id, author_role, author_name, text, attachments[], created_at }]
    carregando: false,
  }

  // ===== Mocks (substitua por fetch real dos endpoints do ML)
  async function carregarMensagens() {
    state.carregando = true
    renderSkeletons()
    const now = Date.now()
    // alterna buyer/seller/platform
    state.mensagens = Array.from({ length: 18 }).map((_, i) => {
      const role = ['buyer', 'seller', 'platform'][i % 3]
      return {
        id: `m_${now}_${i}`,
        author_role: role,
        author_name: role === 'buyer' ? 'Comprador'
                    : role === 'seller' ? 'Vendedor'
                    : 'Mediador',
        text:
          role === 'platform'
            ? 'Mensagem da mediação do Mercado Livre.'
            : role === 'buyer'
              ? 'Olá, tive um problema com o produto.'
              : 'Claro! Vamos resolver.',
        attachments: i === 2 ? [{ id: 'a1', name: 'foto.jpg', url: '#', mime: 'image/jpeg' }] : [],
        created_at: new Date(now - i * 90 * 1000).toISOString(),
      }
    })
    state.carregando = false
    render()
  }

  // ===== Render
  function bubble(m) {
    const isSeller = /seller|respond/.test(m.author_role || '')
    const lado = isSeller ? 'out' : 'in'
    const wrap = document.createElement('div')
    wrap.className = `msg ${lado}`
    wrap.innerHTML = `
      <div class="meta"><span>${m.author_name || m.author_role}</span> • <span>${when(m.created_at)}</span></div>
      <div class="bubble">${(m.text || '').replace(/\n/g, '<br>')}</div>
    `
    if (Array.isArray(m.attachments) && m.attachments.length) {
      m.attachments.forEach((a) => {
        const link = document.createElement('a')
        link.className = 'attachment'
        link.href = a.url || '#'
        link.target = '_blank'
        link.rel = 'noopener'
        link.textContent = `📎 ${a.name || a.id || 'arquivo'}`
        wrap.appendChild(link)
      })
    }
    return wrap
  }

  function renderSkeletons() {
    // só um feedback simples de carregamento dentro da área ativa
    const alvo = state.active === 'plataforma' ? el.mensagensPlataforma : el.mensagensCliente
    if (!alvo) return
    alvo.innerHTML = `
      <div class="skeleton" style="width:70%;height:.9rem;margin-bottom:.75rem"></div>
      <div class="skeleton" style="width:55%;height:.9rem;margin-bottom:1rem"></div>
      <div class="skeleton" style="width:62%;height:.9rem;margin-bottom:.75rem"></div>
      <div class="skeleton" style="width:40%;height:.9rem"></div>
    `
  }

  function renderCliente() {
    const msgs = state.mensagens.filter((m) =>
      /buyer|seller|complain|respond/i.test(m.author_role || '')
    )
    const box = el.mensagensCliente
    box.innerHTML = ''
    if (!msgs.length) {
      box.innerHTML = '<div class="empty-text">Nenhuma mensagem do cliente.</div>'
      return
    }
    const frag = document.createDocumentFragment()
    msgs.forEach((m) => frag.appendChild(bubble(m)))
    box.appendChild(frag)
    box.scrollTop = box.scrollHeight
  }

  function renderPlataforma() {
    const msgs = state.mensagens.filter((m) =>
      /platform|mediator|system/i.test(m.author_role || '')
    )
    const box = el.mensagensPlataforma
    box.innerHTML = ''
    if (!msgs.length) {
      box.innerHTML = '<div class="empty-text">Nenhuma mensagem de mediação ainda.</div>'
      return
    }
    const frag = document.createDocumentFragment()
    msgs.forEach((m) => frag.appendChild(bubble(m)))
    box.appendChild(frag)
    box.scrollTop = box.scrollHeight
  }

  function render() {
    if (state.active === 'cliente') renderCliente()
    else renderPlataforma()
  }

  // ===== Abas
  function setAba(key) {
    state.active = key
    const isCliente = key === 'cliente'

    // visual das abas
    el.abaCliente.setAttribute('aria-selected', String(isCliente))
    el.abaPlataforma.setAttribute('aria-selected', String(!isCliente))

    // mostra/oculta painéis
    el.painelCliente.hidden = !isCliente
    el.painelPlataforma.hidden = isCliente

    // layout: esconder coluna esquerda quando for "Plataforma"
    if (el.mainContent) el.mainContent.classList.toggle('plataforma', !isCliente)
    if (el.leftPanel) el.leftPanel.style.display = isCliente ? '' : 'none'

    // re-render específico
    render()
  }

  function handleTabKeys(e) {
    const tabs = [el.abaCliente, el.abaPlataforma]
    const idx = tabs.indexOf(document.activeElement)
    if (idx < 0) return
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const next = e.key === 'ArrowRight' ? (idx + 1) % tabs.length : (idx - 1 + tabs.length) % tabs.length
      const key = next === 0 ? 'cliente' : 'plataforma'
      setAba(key)
      tabs[next].focus()
    }
  }

  // ===== Eventos
  el.abaCliente.addEventListener('click', () => setAba('cliente'))
  el.abaPlataforma.addEventListener('click', () => setAba('plataforma'))
  el.abaCliente.addEventListener('keydown', handleTabKeys)
  el.abaPlataforma.addEventListener('keydown', handleTabKeys)

  // ===== Boot
  ;(async () => {
    await carregarMensagens()
    setAba('cliente') // inicia no cliente
  })()
})()
