// /public/js/chat.js — Chat de Devoluções (MVP estável + paginação threads)

(() => {
  const $  = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const listEl    = $("#threadList");
  const pagerEl   = $("#threadsPager");
  const searchEl  = $("#threadSearch");
  const msgsEl    = $("#messages");
  const titleEl   = $("#roomTitle");
  const subEl     = $("#roomSub");
  const openEl    = $("#roomOpenLink");
  const formEl    = $("#composer");
  const bodyEl    = $("#msgBody");
  const btnSend   = $("#btnSend");

  let currentId = null;     // return_id selecionado
  let threads   = [];       // lista de devoluções da página atual
  let polling   = true;

  // estado de paginação (threads)
  const state = {
    page: 1,
    pageSize: 12,           // quantas conversas por página
    total: 0,
    pages: 1
  };

  document.addEventListener("visibilitychange", () => {
    polling = document.visibilityState === "visible";
  });

  // -------------------- Helpers --------------------
  function htmlEscape(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  function nl2br(s) {
    return htmlEscape(s).replace(/\r?\n/g, "<br>");
  }

  async function api(url, opt) {
    const r = await fetch(url, opt);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error || j?.message || r.statusText || "Erro");
    return j;
  }

  function lojaToMarketplace(s = "") {
    s = String(s).toLowerCase();
    if (s.includes("shopee")) return "Shopee";
    if (s.includes("magalu") || s.includes("magazineluiza")) return "Magalu";
    if (s.includes("mercado") || s.includes("ml") || s.includes("meli")) return "Mercado Livre";
    return "Outros";
  }

  function mkIcon(name) {
    if (name === "Mercado Livre")
      return `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#ffea00"/><path d="M7 11c2-2 8-2 10 0" stroke="#0f172a" stroke-width="1.4" fill="none"/></svg>`;
    if (name === "Shopee")
      return `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="14" rx="2" fill="#ef4444"/><path d="M12 4c-1.5 0-2.5 1-2.8 2H7v2h10V6h-2.2C14.5 5 13.5 4 12 4Z" fill="#fff"/></svg>`;
    if (name === "Magalu")
      return `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2" fill="#0ea5e9"/><rect x="5" y="8" width="14" height="2" fill="#22c55e"/><rect x="5" y="12" width="10" height="2" fill="#f59e0b"/></svg>`;
    return `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="#e5e7eb"/></svg>`;
  }

  function setLoading(on) {
    try {
      if (on && window.pageLoaderShow) window.pageLoaderShow();
      if (!on && window.pageLoaderDone) window.pageLoaderDone();
    } catch {}
  }

  // -------------------- Threads (com paginação) --------------------
  // Busca paginação direto da API de returns (page/pageSize). Mantém fallback.
  async function fetchThreads(page = 1) {
    const ps = state.pageSize;
    // tenta primeiro com ordering por updated_at
    try {
      const j = await api(`/api/returns?page=${page}&pageSize=${ps}&orderBy=updated_at&orderDir=desc`);
      const items = Array.isArray(j.items) ? j.items : (Array.isArray(j) ? j : []);
      state.total = Number(j.total ?? items.length);
      state.page  = Number(j.page ?? page);
      state.pages = Math.max(1, Math.ceil(state.total / ps));
      return items;
    } catch {
      // fallback: endpoint simples sem paginação — vamos simular páginas no front
      const j = await api("/api/returns?orderDir=desc");
      const all = Array.isArray(j.items) ? j.items : (Array.isArray(j) ? j : []);
      state.total = all.length;
      state.pages = Math.max(1, Math.ceil(state.total / ps));
      state.page  = Math.min(page, state.pages);
      const start = (state.page - 1) * ps;
      return all.slice(start, start + ps);
    }
  }

  function renderPager() {
    if (!pagerEl) return;
    const { page, pages } = state;

    // máximo de 7 botões numéricos (com elipses quando necessário)
    const maxBtns = 7;
    let start = Math.max(1, page - Math.floor(maxBtns / 2));
    let end   = Math.min(pages, start + maxBtns - 1);
    start     = Math.max(1, Math.min(start, Math.max(1, end - maxBtns + 1)));

    const btn = (label, p, opts = {}) => {
      const disabled = !!opts.disabled;
      const active   = !!opts.active;
      return `<button class="btn${active ? " is-active": ""}" ${disabled ? "disabled": ""} data-page="${p}">${label}</button>`;
    };

    let html = "";
    html += btn("‹", Math.max(1, page - 1), { disabled: page <= 1 });
    if (start > 1) {
      html += btn("1", 1, { active: page === 1 });
      if (start > 2) html += `<span class="btn" disabled style="pointer-events:none;">…</span>`;
    }
    for (let p = start; p <= end; p++) {
      html += btn(String(p), p, { active: p === page });
    }
    if (end < pages) {
      if (end < pages - 1) html += `<span class="btn" disabled style="pointer-events:none;">…</span>`;
      html += btn(String(pages), pages, { active: page === pages });
    }
    html += btn("›", Math.min(pages, page + 1), { disabled: page >= pages });

    pagerEl.innerHTML = html;

    // eventos
    pagerEl.querySelectorAll(".btn[data-page]").forEach((b) => {
      b.addEventListener("click", async () => {
        const p = Number(b.dataset.page);
        await goToPage(p);
      });
    });
  }

  function renderThreads(items) {
    threads = items;
    const q = (searchEl?.value || "").trim().toLowerCase();
    listEl.innerHTML = "";

    items.forEach((r) => {
      const mk = lojaToMarketplace(r.loja_nome || "");
      const title = r.loja_nome || mk || "Loja";
      const sub = `Pedido ${r.id_venda || r.id || "—"} • ${(String(r.status || "").replaceAll("_", " ") || "—")}`;
      if (q && !(title.toLowerCase().includes(q) || sub.toLowerCase().includes(q))) return;

      const li = document.createElement("li");
      li.className = "thread";
      li.dataset.id = r.id;
      li.innerHTML = `
        <div class="logo">${mkIcon(mk)}</div>
        <div class="tinfo">
          <div class="title">${htmlEscape(title)}</div>
          <div class="sub">${htmlEscape(sub)}</div>
        </div>
        <div class="badge">#${r.id}</div>
      `;
      li.addEventListener("click", () =>
        openThread(r.id, { title, mk, order: r.id_venda || r.id, loja: r.loja_nome || "" })
      );
      listEl.appendChild(li);
    });

    // Seleciona a primeira se nada estiver ativo
    if (!currentId && items.length) {
      listEl.querySelector(".thread")?.click();
    }

    renderPager();
  }

  async function goToPage(p) {
    setLoading(true);
    try {
      const items = await fetchThreads(p);
      renderThreads(items);
    } catch (e) {
      listEl.innerHTML = `<li class="thread"><div class="sub">Falha ao carregar conversas: ${htmlEscape(e.message)}</div></li>`;
      state.page = 1; state.pages = 1; state.total = 0;
      renderPager();
    } finally {
      setLoading(false);
    }
  }

  function setActive(id) {
    currentId = id;
    $$(".thread").forEach((el) => el.classList.toggle("is-active", String(el.dataset.id) === String(id)));
  }

  function scrollBottom(force = false) {
    const nearBottom = msgsEl.scrollTop + msgsEl.clientHeight >= msgsEl.scrollHeight - 120;
    if (force || nearBottom) msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  // -------------------- Messages --------------------
  function mapDirectionFromRole(role) {
    const r = String(role || "").toLowerCase();
    if (r === "respondent") return "out";
    return "in";
  }

  function senderLabel(role) {
    const r = String(role || "").toLowerCase();
    if (r === "respondent") return "Você";
    if (r === "mediator") return "Mediador";
    return "Cliente";
  }

  function msgBubble({ direction, body, when, sender, attachments }) {
    const el = document.createElement("div");
    el.className = `msg ${direction === "out" ? "out" : "in"}`;
    const hasAtt = Array.isArray(attachments) && attachments.length;
    const attHtml = hasAtt
      ? `<div class="atts">${attachments
          .map((a) => `<span class="att" title="${htmlEscape(a.original_filename || a.filename || a)}">${htmlEscape(a.original_filename || a.filename || a)}</span>`).join("")}</div>`
      : "";
    el.innerHTML = `
      <div class="bubble">${nl2br(body || "")}${attHtml}</div>
      <div class="meta"><span>${htmlEscape(sender || "")}</span><span>${when ? new Date(when).toLocaleString("pt-BR") : ""}</span></div>
    `;
    return el;
  }

  async function loadMessages(id) {
    msgsEl.innerHTML = "";
    setLoading(true);
    try {
      const j = await api(`/api/returns/${encodeURIComponent(id)}/messages`);
      const items = Array.isArray(j.items) ? j.items : Array.isArray(j) ? j : [];

      if (!items.length) {
        msgsEl.innerHTML = `<div class="placeholder">Sem mensagens ainda. Envie a primeira resposta.</div>`;
      } else {
        items.forEach((m) => {
          const body = m.body ?? m.message ?? "";
          const when = m.created_at || m.date_created || m.message_date || m.createdAt;
          const dir  = m.direction || mapDirectionFromRole(m.sender_role);
          const sender = m.sender_name || (m.direction === "out" ? "Você" : senderLabel(m.sender_role));
          msgsEl.appendChild(msgBubble({ direction: dir, body, when, sender, attachments: m.attachments }));
        });
      }
      bodyEl.disabled = false;
      btnSend.disabled = false;
    } catch (e) {
      msgsEl.innerHTML = `<div class="placeholder">Não foi possível carregar as mensagens (${htmlEscape(e.message)}).</div>`;
      bodyEl.disabled = true;
      btnSend.disabled = true;
    } finally {
      setLoading(false);
      scrollBottom(true);
    }
  }

  async function openThread(id, meta) {
    setActive(id);
    titleEl.textContent = meta?.loja || meta?.title || `Devolução #${id}`;
    subEl.textContent = `Pedido ${meta?.order || id} • ${meta?.mk || ""}`;
    openEl.href = `devolucao-editar.html?id=${encodeURIComponent(id)}`;
    openEl.hidden = false;
    await loadMessages(id);
  }

  async function sendMessage(ev) {
    ev.preventDefault();
    if (!currentId) return;

    const text = (bodyEl.value || "").trim();
    if (!text) return;

    btnSend.disabled = true;

    // envio otimista
    const temp = msgBubble({ direction: "out", body: text, when: Date.now(), sender: "Você" });
    temp.classList.add("pending");
    msgsEl.appendChild(temp);
    scrollBottom(true);
    bodyEl.value = "";

    try {
      await api(`/api/returns/${encodeURIComponent(currentId)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ body: text })
      });
      temp.classList.remove("pending");
      await loadMessages(currentId);
    } catch (e) {
      const b = temp.querySelector(".bubble");
      b.innerHTML = `${nl2br(text)}<br><small class="err">Falha ao enviar: ${htmlEscape(e.message)}</small>`;
      temp.classList.add("failed");
    } finally {
      btnSend.disabled = false;
      bodyEl.focus();
    }
  }

  // -------------------- Boot & Polling --------------------
  async function boot() {
    setLoading(true);
    try {
      const items = await fetchThreads(1);
      renderThreads(items);
    } catch (e) {
      listEl.innerHTML = `<li class="thread"><div class="sub">Falha ao carregar conversas: ${htmlEscape(e.message)}</div></li>`;
      renderPager();
    } finally {
      setLoading(false);
    }

    // Refresh mensagens da conversa aberta (20s)
    (async function loopMsgs() {
      while (true) {
        await sleep(20000);
        if (!polling || !currentId) continue;
        try { await loadMessages(currentId); } catch {}
      }
    })();

    // Refresh leve da lista (60s) mantendo página atual
    (async function loopThreads() {
      while (true) {
        await sleep(60000);
        if (!polling) continue;
        try {
          const items = await fetchThreads(state.page);
          renderThreads(items);
        } catch {}
      }
    })();

    // SSE opcional
    try {
      if ("EventSource" in window) {
        const es = new EventSource("/events");
        es.addEventListener("message:new", (ev) => {
          const data = JSON.parse(ev.data || "{}");
          if (data.returnId && String(data.returnId) === String(currentId)) {
            msgsEl.appendChild(
              msgBubble({
                direction: data.direction || "in",
                body: data.body,
                when: data.createdAt || Date.now(),
                sender: data.sender || "Cliente"
              })
            );
            scrollBottom();
          }
        });
      }
    } catch {}
  }

  // -------------------- Listeners --------------------
  searchEl?.addEventListener("input", async () => {
    // Como a busca é client-side, apenas re-renderizamos os itens atuais.
    // Se quiser busca server-side, implemente ?q= no backend e chame fetchThreads(1) passando o termo.
    renderThreads(threads);
  });

  formEl?.addEventListener("submit", sendMessage);

  bodyEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      formEl?.dispatchEvent(new Event("submit", { cancelable: true }));
    }
  });

  // init
  boot();
})();
