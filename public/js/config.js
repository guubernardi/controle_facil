// settings/config.js – roteador de abas + CRUD simples (com fallback localStorage)
document.addEventListener("DOMContentLoaded", () => {
  // utilidades
  const $  = (sel, ctx=document) => ctx.querySelector(sel);
  const $$ = (sel, ctx=document) => Array.from(ctx.querySelectorAll(sel));
  const toast = (msg) => {
    const t = $("#toast"); if(!t){ alert(msg); return; }
    t.textContent = msg; t.classList.add("show");
    setTimeout(()=>t.classList.remove("show"), 2200);
  };
  const esc = (s="") => String(s).replace(/[&<>"']/g, m => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[m]));

  // -------- mini storage (API -> localStorage fallback) ----------
  const api = {
    async get(path){
      try{
        const r = await fetch(`/api/settings${path}`);
        if(!r.ok) throw 0;
        // pode vir 204 sem body
        if (r.status === 204) return null;
        const ct = r.headers.get("content-type") || "";
        return ct.includes("application/json") ? await r.json() : null;
      }catch{
        return JSON.parse(localStorage.getItem(`settings:${path}`) || "null");
      }
    },
    async put(path, payload){
      try{
        const r = await fetch(`/api/settings${path}`, {
          method: "PUT",
          headers: {"Content-Type":"application/json"},
          body: JSON.stringify(payload)
        });
        if(!r.ok) throw 0;
        if (r.status === 204) return payload;
        const ct = r.headers.get("content-type") || "";
        return ct.includes("application/json") ? await r.json() : payload;
      }catch{
        localStorage.setItem(`settings:${path}`, JSON.stringify(payload));
        return payload;
      }
    }
  };

  // -------- roteamento/hash (#empresa, #usuarios, #regras, #integracoes) --------
  const panes = $$(".config-pane");
  const menu  = $$(".item-menu");

  function showPane(id){
    panes.forEach(p => p.classList.toggle("active", p.id === id));
    menu.forEach(m => m.classList.toggle("ativo", (m.dataset.target === id)));
    localStorage.setItem("settings:lastTab", id);
  }

  function applyHash(){
    const wanted = (location.hash || "#empresa").replace("#","");
    const exists = panes.some(p => p.id === wanted);
    showPane(exists ? wanted : "empresa");
  }
  window.addEventListener("hashchange", applyHash);

  // previne “pulo” de âncora e força atualização do hash
  menu.forEach(a => a.addEventListener("click", (e) => {
    e.preventDefault();
    const id = e.currentTarget.dataset.target;
    if (!id) return;
    if (location.hash !== `#${id}`) location.hash = `#${id}`;
    else applyHash(); // se já está no mesmo hash, ainda assim re-aplica seleção
    e.currentTarget.blur();
  }));

  // restaurar última aba se não houver hash
  if (!location.hash){
    const last = localStorage.getItem("settings:lastTab") || "empresa";
    location.hash = `#${last}`;
  }
  applyHash();

  // ================== EMPRESA ==================
  const formEmpresa = $("#form-empresa");
  const btnEmpresaReload = $("#empresa-recarregar");

  async function loadEmpresa(){
    const d = await api.get("/company") || {};
    ["razao_social","nome_fantasia","cnpj","email","telefone","endereco"]
      .forEach(k => { if (formEmpresa?.[k]) formEmpresa[k].value = d[k] || ""; });
  }
  formEmpresa?.addEventListener("submit", async (e)=>{
    e.preventDefault();
    const payload = Object.fromEntries(new FormData(formEmpresa).entries());
    await api.put("/company", payload);
    toast("Empresa salva.");
  });
  btnEmpresaReload?.addEventListener("click", loadEmpresa);

  // ================== USUÁRIOS ==================
  const tbodyUsers     = $("#usuarios-list");
  const formAddUser    = $("#form-add-user");
  const btnUsersSave   = $("#usuarios-salvar");
  const btnUsersReload = $("#usuarios-recarregar");
  let users = [];

  function renderUsers(){
    if (!tbodyUsers) return;
    tbodyUsers.innerHTML = users.map((u,i)=>`
      <tr>
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
  }

  async function loadUsers(){
    users = await api.get("/users") || [];
    renderUsers();
  }

  formAddUser?.addEventListener("submit", (e)=>{
    e.preventDefault();
    const f = new FormData(formAddUser);
    const nome  = (f.get("nome")  || "").toString().trim();
    const email = (f.get("email") || "").toString().trim().toLowerCase();
    const papel = (f.get("papel") || "operador").toString();

    if (!nome){ toast("Informe o nome."); return; }
    if (!/^\S+@\S+\.\S+$/.test(email)){ toast("E-mail inválido."); return; }
    if (users.some(u => (u.email||"").toLowerCase() === email)){
      toast("Este e-mail já está na lista.");
      return;
    }

    users.push({ nome, email, papel });
    formAddUser.reset();
    renderUsers();
  });

  tbodyUsers?.addEventListener("change", (e)=>{
    if (e.target.classList.contains("edit-role")){
      const i = +e.target.dataset.i;
      if (users[i]) users[i].papel = e.target.value;
    }
  });
  tbodyUsers?.addEventListener("click", (e)=>{
    if (e.target.classList.contains("remove")){
      const i = +e.target.dataset.i;
      users.splice(i,1);
      renderUsers();
    }
  });

  btnUsersSave?.addEventListener("click", async ()=>{
    await api.put("/users", users);
    toast("Usuários atualizados.");
  });
  btnUsersReload?.addEventListener("click", loadUsers);

  // ================== REGRAS ==================
  const formRegras = $("#form-regras");
  const btnRegrasReload = $("#regras-recarregar");

  async function loadRegras(){
    const d = await api.get("/rules") || {};
    const data = {
      rule_rejeitado_zero:      d.rule_rejeitado_zero ?? true,
      rule_motivo_cliente_zero: d.rule_motivo_cliente_zero ?? true,
      rule_cd_somente_frete:    d.rule_cd_somente_frete ?? true,
      label_aprovada:           d.label_aprovada       ?? "Aprovada",
      label_rejeitada:          d.label_rejeitada      ?? "Rejeitada",
      label_recebido_cd:        d.label_recebido_cd    ?? "Recebido no CD",
      label_em_inspecao:        d.label_em_inspecao    ?? "Em inspeção",
    };
    Object.entries(data).forEach(([k,v])=>{
      if (!formRegras?.[k]) return;
      if (formRegras[k].type === "checkbox") formRegras[k].checked = !!v;
      else formRegras[k].value = v;
    });
  }

  formRegras?.addEventListener("submit", async (e)=>{
    e.preventDefault();
    const fd = new FormData(formRegras);
    const payload = Object.fromEntries(fd.entries());
    ["rule_rejeitado_zero","rule_motivo_cliente_zero","rule_cd_somente_frete"]
      .forEach(k => payload[k] = !!formRegras[k].checked);
    await api.put("/rules", payload);
    toast("Regras salvas.");
  });
  btnRegrasReload?.addEventListener("click", loadRegras);

  // ------- carregar tudo na primeira entrada -------
  loadEmpresa();
  loadUsers();
  loadRegras();

  // ================== INTEGRAÇÃO: Mercado Livre (status/conectar/desconectar) ==================
  (async () => {
    const card      = document.querySelector('[data-integration="ml"]');
    if (!card) return;

    const statusEl  = document.getElementById('ml-status');
    const badgeEl   = document.getElementById('ml-badge');
    const btnConn   = document.getElementById('ml-connect');
    const btnDisc   = document.getElementById('ml-disconnect');

    function setLoading(on) {
      if (on && statusEl)  statusEl.textContent = 'Verificando status…';
    }

    function applyUiDisconnected() {
      card.classList.remove('is-connected');
      if (statusEl) statusEl.textContent = 'Não conectado';
      if (badgeEl)  badgeEl.textContent  = 'E-commerce';
      if (btnConn)  btnConn.hidden = false;
      if (btnDisc)  btnDisc.hidden = true;
    }

    function applyUiConnected(nickname, expiresAt) {
      card.classList.add('is-connected');
      if (statusEl) statusEl.innerHTML = `Conectado como <b>@${nickname}</b>${expiresAt ? ` (expira: ${new Date(expiresAt).toLocaleString('pt-BR')})` : ''}`;
      if (badgeEl)  badgeEl.textContent = 'Conectado';
      if (btnConn)  btnConn.hidden = true;
      if (btnDisc)  btnDisc.hidden = false;
    }

    async function refreshMlStatus() {
      try {
        setLoading(true);
        const r = await fetch('/api/ml/status', { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();

        if (j.connected) {
          applyUiConnected(j.nickname || 'conta', j.expires_at);
        } else {
          applyUiDisconnected();
        }
      } catch (e) {
        console.warn('[ML] status falhou:', e);
        applyUiDisconnected();
      }
    }

    btnDisc?.addEventListener('click', async () => {
      try {
        const r = await fetch('/api/ml/disconnect', { method: 'POST' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        await refreshMlStatus();
        // reaproveita o toast global se houver
        const t = document.getElementById('toast');
        if (t) { t.textContent = 'Desconectado do Mercado Livre.'; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'), 2000); }
      } catch (e) {
        alert('Falha ao desconectar.');
      }
    });

    // Status da integração Mercado Livre
    (async () => {
      const s = document.getElementById('ml-status');
      const btnDisc = document.getElementById('ml-disconnect');
      if (!s) return;
      try {
        const r = await fetch('/api/ml/me');
        const j = await r.json();
        if (j.ok) {
          s.textContent = `Conectado: ${j.account.nickname}`;
          if (btnDisc) btnDisc.hidden = false; // (a rota de desconectar é opcional)
        } else {
          s.textContent = 'Não conectado';
        }
      } catch {
        s.textContent = 'Não conectado';
      }
    })();
    
    // primeira checagem ao abrir a página/aba
    refreshMlStatus();
  })();
});