// settings/config.js – abas + CRUD + integração ML (robusto)
// (c) seu projeto
document.addEventListener("DOMContentLoaded", () => {
  const $ = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => Array.from(c.querySelectorAll(s));
  const esc = (s = "") => String(s).replace(/[&<>"']/g, (m) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m]));

  // usa o #toast da página
  const toast = (msg) => {
    const el = $("#toast");
    if (!el) return console.log("[toast]", msg);
    el.textContent = msg;
    el.classList.add("show");
    setTimeout(() => el.classList.remove("show"), 2600);
  };

  // loading helpers
  const showLoading = (btn) => { if (!btn) return; btn.disabled = true; btn.dataset.originalText = btn.textContent; btn.innerHTML = '<span class="spinner"></span> Carregando...'; };
  const hideLoading  = (btn) => { if (!btn) return; btn.disabled = false; btn.textContent = btn.dataset.originalText || btn.textContent; };

  // confirm com overlay fixo
  const ensureConfirmCss = () => {
    if ($("#confirm-css")) return;
    const s = document.createElement("style");
    s.id = "confirm-css";
    s.textContent = `
      .confirm-overlay{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .2s}
      .confirm-overlay.show{opacity:1}
      .confirm-dialog{max-width:420px;width:calc(100% - 32px);background:#fff;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.2);padding:18px}
      .confirm-actions{display:flex;gap:10px;justify-content:flex-end}
      .btn--danger{background:#dc2626;color:#fff;border:1px solid #b91c1c}
    `;
    document.head.appendChild(s);
  };
  const confirmDlg = (msg) => new Promise((resolve) => {
    ensureConfirmCss();
    const ov = document.createElement("div");
    ov.className = "confirm-overlay";
    ov.innerHTML = `
      <div class="confirm-dialog" role="dialog" aria-modal="true">
        <div style="font-size:20px;margin-bottom:8px">⚠</div>
        <p class="confirm-message" style="margin:0 0 14px">${msg}</p>
        <div class="confirm-actions">
          <button class="btn btn--ghost confirm-cancel">Cancelar</button>
          <button class="btn btn--danger confirm-ok">Confirmar</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    requestAnimationFrame(() => ov.classList.add("show"));
    const done = (v)=>{ ov.classList.remove("show"); setTimeout(()=>ov.remove(),180); resolve(v); };
    ov.querySelector(".confirm-cancel").onclick = () => done(false);
    ov.querySelector(".confirm-ok").onclick     = () => done(true);
    ov.addEventListener("click", (e)=>{ if (e.target===ov) done(false); });
    document.addEventListener("keydown",(e)=>{ if(e.key==="Escape") done(false); },{once:true});
  });

  // API settings (fallback localStorage)
  const api = {
    async get(path){
      try {
        const r = await fetch(`/api/settings${path}`);
        if(!r.ok) throw 0;
        if(r.status===204) return null;
        const ct = r.headers.get("content-type")||"";
        return ct.includes("application/json") ? await r.json() : null;
      } catch {
        return JSON.parse(localStorage.getItem(`settings:${path}`)||"null");
      }
    },
    async put(path,payload){
      try{
        const r = await fetch(`/api/settings${path}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
        if(!r.ok) throw 0;
        if(r.status===204) return payload;
        const ct = r.headers.get("content-type")||"";
        return ct.includes("application/json")? await r.json() : payload;
      }catch{
        localStorage.setItem(`settings:${path}`, JSON.stringify(payload));
        return payload;
      }
    }
  };

  // --------- roteador de abas ---------
  const panes = $$(".config-pane");
  const menu  = $$(".item-menu");
  const showPane = (id)=>{
    panes.forEach(p=>p.classList.toggle("active", p.id===id));
    menu.forEach(m=>m.classList.toggle("ativo", m.dataset.target===id));
    localStorage.setItem("settings:lastTab", id);
  };
  const applyHash = ()=>{
    const wanted = (location.hash||"#empresa").slice(1);
    showPane(panes.some(p=>p.id===wanted)?wanted:"empresa");
  };
  window.addEventListener("hashchange", applyHash);
  menu.forEach(a=>a.addEventListener("click",(e)=>{e.preventDefault(); const id=e.currentTarget.dataset.target; if(!id) return; location.hash=`#${id}`;}));
  if(!location.hash){ location.hash = `#${localStorage.getItem("settings:lastTab")||"empresa"}`; }
  applyHash();

  // --------- EMPRESA ---------
  const formEmpresa = $("#form-empresa");
  const btnEmpresaReload = $("#empresa-recarregar");
  async function loadEmpresa(){
    showLoading(btnEmpresaReload);
    try{
      const d=(await api.get("/company"))||{};
      ["razao_social","nome_fantasia","cnpj","email","telefone","endereco"].forEach(k=>{ if(formEmpresa?.[k]) formEmpresa[k].value=d[k]||""; });
      toast("Dados da empresa carregados");
    }catch{ toast("Erro ao carregar dados da empresa"); }
    finally{ hideLoading(btnEmpresaReload); }
  }
  formEmpresa?.addEventListener("submit", async (e)=>{
    e.preventDefault();
    const btn = formEmpresa.querySelector('button[type="submit"]'); showLoading(btn);
    try{
      const payload = Object.fromEntries(new FormData(formEmpresa).entries());
      await api.put("/company", payload);
      toast("Dados da empresa salvos!");
      formEmpresa.classList.add("form-success"); setTimeout(()=>formEmpresa.classList.remove("form-success"),600);
    }catch{ toast("Erro ao salvar dados da empresa"); }
    finally{ hideLoading(btn); }
  });
  btnEmpresaReload?.addEventListener("click", loadEmpresa);

  // --------- USUÁRIOS ---------
  const tbodyUsers = $("#usuarios-list");
  const formAddUser = $("#form-add-user");
  const btnUsersSave = $("#usuarios-salvar");
  const btnUsersReload = $("#usuarios-recarregar");
  let users = [];
  const renderUsers = ()=>{
    if(!tbodyUsers) return;
    tbodyUsers.innerHTML = users.map((u,i)=>`
      <tr class="user-row">
        <td>${esc(u.nome)}</td>
        <td>${esc(u.email)}</td>
        <td>
          <select data-i="${i}" class="edit-role">
            <option value="admin"   ${u.papel==="admin"?"selected":""}>Admin</option>
            <option value="gestor"  ${u.papel==="gestor"?"selected":""}>Gestor</option>
            <option value="operador"${u.papel==="operador"?"selected":""}>Operador</option>
          </select>
        </td>
        <td><button class="btn btn--ghost remove" data-i="${i}">Remover</button></td>
      </tr>`).join("");
  };
  async function loadUsers(){ showLoading(btnUsersReload); try{ users=(await api.get("/users"))||[]; renderUsers(); toast("Lista de usuários atualizada"); }catch{ toast("Erro ao carregar usuários"); } finally{ hideLoading(btnUsersReload); } }
  formAddUser?.addEventListener("submit",(e)=>{
    e.preventDefault();
    const f = new FormData(formAddUser);
    const nome=(f.get("nome")||"").toString().trim();
    const email=(f.get("email")||"").toString().trim().toLowerCase();
    const papel=(f.get("papel")||"operador").toString();
    if(!nome) return toast("Informe o nome do usuário");
    if(!/^\S+@\S+\.\S+$/.test(email)) return toast("E-mail inválido");
    if(users.some(u=>(u.email||"").toLowerCase()===email)) return toast("Este e-mail já está cadastrado");
    users.push({nome,email,papel}); formAddUser.reset(); renderUsers(); toast(`Usuário ${nome} adicionado!`);
  });
  tbodyUsers?.addEventListener("change",(e)=>{ if(e.target.classList.contains("edit-role")){ const i=+e.target.dataset.i; if(users[i]){ users[i].papel=e.target.value; toast("Papel alterado (salve para aplicar)"); } } });
  tbodyUsers?.addEventListener("click", async (e)=>{ if(e.target.classList.contains("remove")){ const i=+e.target.dataset.i; const u=users[i]; if(await confirmDlg(`Remover o usuário <strong>${esc(u?.nome||"")}</strong>?`)){ users.splice(i,1); renderUsers(); toast("Usuário removido (salve para aplicar)"); } }});
  btnUsersSave?.addEventListener("click", async ()=>{ showLoading(btnUsersSave); try{ await api.put("/users", users); toast("Usuários salvos!"); }catch{ toast("Erro ao salvar usuários"); } finally{ hideLoading(btnUsersSave); }});
  btnUsersReload?.addEventListener("click", loadUsers);

  // --------- REGRAS ---------
  const formRegras = $("#form-regras");
  const btnRegrasReload = $("#regras-recarregar");
  async function loadRegras(){
    showLoading(btnRegrasReload);
    try{
      const d=(await api.get("/rules"))||{};
      const data={
        rule_rejeitado_zero: d.rule_rejeitado_zero ?? true,
        rule_motivo_cliente_zero: d.rule_motivo_cliente_zero ?? true,
        rule_cd_somente_frete: d.rule_cd_somente_frete ?? true,
        label_aprovada: d.label_aprovada ?? "Aprovada",
        label_rejeitada: d.label_rejeitada ?? "Rejeitada",
        label_recebido_cd: d.label_recebido_cd ?? "Recebido no CD",
        label_em_inspecao: d.label_em_inspecao ?? "Em inspeção",
      };
      Object.entries(data).forEach(([k,v])=>{
        if(!formRegras?.[k]) return;
        if(formRegras[k].type==="checkbox") formRegras[k].checked=!!v; else formRegras[k].value=v;
      });
      toast("Regras carregadas");
    }catch{ toast("Erro ao carregar regras"); }
    finally{ hideLoading(btnRegrasReload); }
  }
  formRegras?.addEventListener("submit", async (e)=>{
    e.preventDefault();
    const btn=formRegras.querySelector('button[type="submit"]'); showLoading(btn);
    try{
      const fd=new FormData(formRegras); const payload=Object.fromEntries(fd.entries());
      ["rule_rejeitado_zero","rule_motivo_cliente_zero","rule_cd_somente_frete"].forEach(k=>payload[k]=!!formRegras[k].checked);
      await api.put("/rules", payload); toast("Regras salvas!");
      formRegras.classList.add("form-success"); setTimeout(()=>formRegras.classList.remove("form-success"),600);
    }catch{ toast("Erro ao salvar regras"); }
    finally{ hideLoading(btn); }
  });
  $$('input[type="checkbox"]', formRegras).forEach(c=>c.addEventListener("change",()=>toast("Configuração alterada (salve para aplicar)")));

  // carregar dados iniciais
  loadEmpresa(); loadUsers(); loadRegras();

  // --------- INTEGRAÇÃO: MERCADO LIVRE ---------
  (async () => {
    const card = document.querySelector('[data-integration="ml"]');
    if (!card) return;

    const statusEl     = $("#ml-status");
    const btnConn      = card.querySelector('[data-ml="connect"]');
    const btnDisc      = card.querySelector('[data-ml="disconnect"]');
    const btnShowStores= card.querySelector('[data-ml="me"]');
    const listEl       = card.querySelector('[data-ml="accounts"]');

    const setConnUI = (connected, nickname, exp) => {
      if (connected) {
        card.classList.add("is-connected");
        if (statusEl) {
          const expTxt = exp ? ` (expira: ${new Date(exp).toLocaleString("pt-BR")})` : "";
          statusEl.innerHTML = `Conectado como <b>@${esc(nickname||"conta")}</b>${expTxt}`;
        }
        if (btnConn) btnConn.hidden = true;
        if (btnDisc) btnDisc.hidden = false;
      } else {
        card.classList.remove("is-connected");
        if (statusEl) statusEl.textContent = "Não conectado";
        if (btnConn) btnConn.hidden = false;
        if (btnDisc) btnDisc.hidden = true;
        if (listEl) listEl.innerHTML = "";
      }
    };

    const fetchJsonWithTimeout = async (url, ms=10000) => {
      const ctrl = new AbortController(); const t = setTimeout(()=>ctrl.abort(), ms);
      try {
        const r = await fetch(url, { cache:"no-store", signal: ctrl.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } finally {
        clearTimeout(t);
      }
    };

    async function refreshMlStatus(){
      try{
        if (statusEl) statusEl.textContent = "Verificando status…";
        const j = await fetchJsonWithTimeout("/api/ml/status");
        setConnUI(!!j.connected, j.nickname, j.expires_at);
      }catch(e){
        console.warn("[ML] status erro:", e);
        setConnUI(false);
      }
    }

    // ---------- modal de lojas ----------
    const modal        = $("#ml-stores-modal");
    const modalLoading = $("#ml-stores-loading");
    const modalContent = $("#ml-stores-content");
    const modalEmpty   = $("#ml-stores-empty");
    const modalError   = $("#ml-stores-error");

    const setModalView = (view) => {
      const map = {
        loading: modalLoading,
        content: modalContent,
        empty:   modalEmpty,
        error:   modalError,
      };
      Object.entries(map).forEach(([k,el])=>{
        if(!el) return;
        const on = (k===view);
        el.hidden = !on;
        el.style.display = on ? (k==="content" ? "flex" : "block") : "none";
      });
    };

    const openModal  = ()=>{ if(!modal) return; modal.hidden=false; document.body.style.overflow="hidden"; };
    const closeModal = ()=>{ if(!modal) return; modal.hidden=true;  document.body.style.overflow=""; };

    const normalizeStores = (payload)=>{
      const root = (payload && (payload.stores||payload.accounts||payload.items||payload.list)) || payload || [];
      const arr = Array.isArray(root) ? root : [];
      return arr.map((it)=>({
        id: it.id ?? it.user_id ?? it.account_id ?? it.seller_id ?? it.nickname ?? "N/A",
        name: it.name ?? it.nickname ?? it.store_name ?? `Conta ${it.id ?? ""}`.trim(),
        active: (it.active ?? it.enabled ?? (it.status ? String(it.status).toLowerCase()==="active" : true))
      }));
    };

    async function loadStores(){
      if(!modal) return;
      setModalView("loading");
      try{
        let data;
        try{
          data = await fetchJsonWithTimeout("/api/ml/stores"); // se existir
        }catch(e1){
          console.debug("[ML] /api/ml/stores falhou, tentando /api/ml/me", e1?.message || e1);
          data = await fetchJsonWithTimeout("/api/ml/me");
        }
        const stores = normalizeStores(data);
        if(!stores.length){ setModalView("empty"); return; }

        modalContent.innerHTML = stores.map((s)=>`
          <div class="modal-store-item">
            <div class="modal-store-info">
              <div class="modal-store-name">${esc(s.name)}</div>
              <div class="modal-store-id">ID: ${esc(String(s.id))}</div>
            </div>
            <span class="modal-store-badge ${s.active ? "active":"inactive"}">${s.active?"Ativa":"Inativa"}</span>
          </div>`).join("");

        setModalView("content");
      }catch(e){
        console.error("[ML Modal] Erro ao carregar lojas:", e);
        setModalView("error");
      }
    }

    btnShowStores?.addEventListener("click", ()=>{ openModal(); loadStores(); });
    $$("[data-close-modal]", modal).forEach((b)=>b.addEventListener("click", closeModal));
    modal?.addEventListener("click",(e)=>{ if(e.target===modal) closeModal(); });
    document.addEventListener("keydown",(e)=>{ if(e.key==="Escape" && !modal?.hidden) closeModal(); });

    // desconectar
    btnDisc?.addEventListener("click", async ()=>{
      if(!(await confirmDlg("Tem certeza que deseja desconectar do Mercado Livre?"))) return;
      showLoading(btnDisc);
      try{
        const r = await fetch("/api/ml/disconnect",{method:"POST"});
        if(!r.ok) throw new Error(`HTTP ${r.status}`);
        await refreshMlStatus();
        toast("Desconectado do Mercado Livre");
      }catch(e){
        console.warn(e);
        toast("Falha ao desconectar do Mercado Livre");
      }finally{
        hideLoading(btnDisc);
      }
    });

    await refreshMlStatus();
  })();

  // Ctrl/Cmd+S salva o formulário ativo
  document.addEventListener("keydown",(e)=>{
    if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==="s"){
      e.preventDefault();
      const pane=$(".config-pane.active"); const form=pane && $("form",pane);
      if(form){ form.dispatchEvent(new Event("submit",{cancelable:true,bubbles:true})); toast("Salvando…"); }
    }
  });
});
