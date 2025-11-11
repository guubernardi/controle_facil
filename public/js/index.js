// /public/js/index.js — Feed Geral com resolução de fluxo por card (com guardas p/ 401/403)
// Anti-"F5": debounce de refresh + throttle por pedido + lock de sync + limite por tick
class DevolucoesFeed {
  constructor() {
    this.items = [];
    this.filtros = { pesquisa: "", status: "todos" };
    this.RANGE_DIAS = 30;

    this.pageSize = 15;
    this.page = 1;

    // "Nova"
    this.NEW_WINDOW_MS = 12 * 60 * 60 * 1000; // 12h
    this.MAX_NEW_AGE_MS = 48 * 60 * 60 * 1000; // 48h
    this.NEW_KEY_PREFIX = "rf:firstSeen:";

    // auto-sync
    this.SYNC_MS = 5 * 60 * 1000;
    this._lastSyncErrShown = false;

    // circuit breaker do claims/import (400)
    this.CLAIMS_BLOCK_MS  = 6 * 60 * 60 * 1000;
    this.CLAIMS_BLOCK_KEY = "rf:claimsImport:blockUntil";

    // cache de fluxo (evita bater no backend em loop)
    this.FLOW_TTL_MS = 30 * 60 * 1000;
    this.FLOW_CACHE_PREFIX = "rf:flowCache:"; // por order_id

    // bloqueios específicos de ML/shipping
    this.ML_SHIP_BLOCK_KEY  = "rf:mlShipping:blockUntil";
    this.ML_SHIP_BLOCK_MS   = 2 * 60 * 1000 * 60;  // 2h
    this.ML_NOACCESS_TTL_MS = 24 * 60 * 60 * 1000; // 24h (cache negativo por pedido)
    this._ml403BurstCount   = 0;
    this._ml403BurstTimer   = null;

    // sync de mensagens (desligado por enquanto)
    this._messagesSyncDisabled = true;

    // seller headers p/ /api/ml/*
    this.sellerId   = document.querySelector('meta[name="ml-seller-id"]')?.content?.trim()
                   || localStorage.getItem('rf:sellerId') || '';
    this.sellerNick = document.querySelector('meta[name="ml-seller-nick"]')?.content?.trim()
                   || localStorage.getItem('rf:sellerNick') || '';

    this.STATUS_GRUPOS = {
      aprovado: new Set(["aprovado","autorizado","autorizada"]),
      rejeitado: new Set(["rejeitado","rejeitada","negado","negada"]),
      finalizado: new Set(["concluido","concluida","finalizado","finalizada","fechado","fechada","encerrado","encerrada"]),
      pendente: new Set(["pendente","em_analise","em-analise","aberto"]),
    };

    // ===== Anti-"F5": debounce/throttle/locks =====
    this._refreshTimer = null;
    this.REFRESH_COOLDOWN_MS = 800;                // junta múltiplos reloads
    this.TRY_FLOW_PREFIX = "rf:flowTry:";          // throttle por order_id
    this.TRY_FLOW_MS = 10 * 60 * 1000;             // 10 minutos
    this._syncInFlight = false;                    // lock para atualizarDados()
    this.MAX_FLOW_RES_PER_TICK = 2;                // resolve no máx. 2 cards por render
    this._flowResolvesThisTick = 0;

    this.inicializar();
  }

  // Debounce de refresh (carregar+renderizar)
  queueRefresh(delay = this.REFRESH_COOLDOWN_MS) {
    if (this._refreshTimer) return;
    this._refreshTimer = setTimeout(async () => {
      this._refreshTimer = null;
      await this.carregar();
      this.renderizar();
    }, delay);
  }

  // Throttle por pedido
  shouldTryFlow(orderId) {
    try {
      const k = this.TRY_FLOW_PREFIX + orderId;
      const last = Number(localStorage.getItem(k) || 0);
      if (Date.now() - last < this.TRY_FLOW_MS) return false;
      localStorage.setItem(k, String(Date.now()));
      return true;
    } catch { return true; }
  }

  async inicializar() {
    this.configurarUI();
    await this.carregar();
    this.purgeOldSeen();
    this.renderizar();
    this.startAutoSync();
  }

  // ===== rede/util =====
  safeJson(res){ if(!res.ok) throw new Error("HTTP "+res.status); return res.status===204?{}:res.json(); }

  mlShipAllowed(){
    try{ const until=Number(localStorage.getItem(this.ML_SHIP_BLOCK_KEY)||0); return Date.now()>until; }catch{ return true; }
  }
  blockMlShip(ms=this.ML_SHIP_BLOCK_MS){
    try{ localStorage.setItem(this.ML_SHIP_BLOCK_KEY, String(Date.now()+ms)); }catch{}
  }

  async fetchQuiet(url){
    try{
      const headers = { Accept:"application/json" };
      if (url.startsWith('/api/ml')) {
        if (this.sellerId)   headers['x-seller-id']   = this.sellerId;
        if (this.sellerNick) headers['x-seller-nick'] = this.sellerNick;
      }
      const r = await fetch(url,{ headers, credentials:"include" });
      const ct = r.headers.get("content-type")||""; let body=null;
      if (ct.includes("application/json")) { try{ body = await r.json(); }catch{} } else { try{ body = await r.text(); }catch{} }

      if(!r.ok){
        const detail = body && (body.error||body.message) ? (body.error||body.message) : (typeof body==="string" ? body : "");
        console.info("[sync]", url, "→", r.status, (detail||"").toString().slice(0,160));

        // Guardas específicas
        if (url.includes('/api/ml/messages/')) this._messagesSyncDisabled = true;

        if (url.includes('/api/ml/shipping/status')) {
          if (r.status===401) {
            this.blockMlShip(30*60*1000); // 30min
            if (!this._lastSyncErrShown){
              this._lastSyncErrShown = true;
              this.toast("Conectar Mercado Livre","Sua sessão do ML não está ativa para esse pedido. Vou pausar por 30min.","erro");
            }
          } else if (r.status===403) {
            this._ml403BurstCount++;
            if (!this._ml403BurstTimer) {
              this._ml403BurstTimer = setTimeout(()=>{
                this._ml403BurstCount = 0; this._ml403BurstTimer=null;
              }, 60*1000);
            }
            if (this._ml403BurstCount >= 3) { // 3 em 60s → pausa 2h
              this.blockMlShip(); // 2h
              this._ml403BurstCount = 0;
              clearTimeout(this._ml403BurstTimer); this._ml403BurstTimer=null;
              this.toast("Pausado por 2h","Muitos 403 do ML (pedido de outra conta). Pausei as consultas de shipping.","erro");
            }
          }
        }

        return { ok:false, status:r.status, detail, data:body };
      }
      return { ok:true, status:r.status, data:body };
    }catch(e){
      console.info("[sync]", url, "→ falhou", e?.message||String(e));
      return { ok:false, error:e?.message||String(e) };
    }
  }

  coerceReturnsPayload(j){ if(Array.isArray(j)) return j; if(!j||typeof j!=="object") return []; return j.items||j.data||j.returns||j.list||[]; }
  formatBRL(n){ return Number(n||0).toLocaleString("pt-BR",{style:"currency",currency:"BRL"}); }
  dataBr(iso){ if(!iso) return "—"; try{ return new Date(iso).toLocaleDateString("pt-BR",{day:"2-digit",month:"short",year:"numeric"});}catch{ return "—"; } }
  esc(s){ const d=document.createElement("div"); d.textContent=s; return d.innerHTML; }

  getDateMs(d){
    const keys = ["created_at","createdAt","created","inserted_at","updated_at","data_compra","order_date","date_created","paid_at","ml_created_at","ml_updated_at","dt","data"];
    for(const k of keys){ const v=d?.[k]; if(!v) continue; const t=Date.parse(v); if(!Number.isNaN(t)) return t; }
    return 0;
  }

  // ===== "Nova" =====
  stableKey(d){ return d?.id_venda || d?.ml_claim_id || d?.order_id || d?.resource_id || d?.id; }
  firstSeenTs(key){ try{ const k=this.NEW_KEY_PREFIX+key; const v=localStorage.getItem(k); if(v) return Number(v)||0; const now=Date.now(); localStorage.setItem(k,String(now)); return now; }catch{ return 0; } }
  isNova(d){
    const key=this.stableKey(d); if(!key) return false;
    const created=this.getDateMs(d);
    if (created && Date.now()-created > this.MAX_NEW_AGE_MS) return false;
    return Date.now()-this.firstSeenTs(key) <= this.NEW_WINDOW_MS;
  }
  purgeOldSeen(){ try{ const now=Date.now(); for(let i=localStorage.length-1;i>=0;i--){ const k=localStorage.key(i); if(!k||!k.startsWith(this.NEW_KEY_PREFIX)) continue; const ts=Number(localStorage.getItem(k))||0; if(now-ts>20*this.MAX_NEW_AGE_MS) localStorage.removeItem(k); } }catch{} }

  async carregar(){
    this.toggleSkeleton(true);
    try{
      const urls=[
        `/api/returns?limit=200&range_days=${this.RANGE_DIAS}`,
        `/api/returns?page=1&pageSize=200&orderBy=created_at&orderDir=desc`,
        `/api/returns`
      ];
      let list=null, last=null;
      for(const url of urls){
        try{
          const j = await fetch(url,{headers:{Accept:"application/json"}, credentials:"include"}).then(r=>this.safeJson(r));
          const arr = this.coerceReturnsPayload(j);
          if (Array.isArray(arr)) { list=arr; break; }
        }catch(e){ last=e; }
      }
      this.items = Array.isArray(list)&&list.length ? list : this.getMockData();
      if(!list && last) throw last;
    }catch(e){
      console.warn("[index] Falha ao carregar; usando mock.", e?.message);
      this.items=this.getMockData();
      this.toast("Aviso","API indisponível. Exibindo dados de exemplo.","erro");
    }finally{ this.toggleSkeleton(false); }
  }
  toggleSkeleton(show){
    const $=id=>document.getElementById(id);
    const sk=$("loading-skeleton"), listWrap=$("lista-devolucoes"), list=$("container-devolucoes"), vazio=$("mensagem-vazia");
    if (sk) sk.hidden=!show;
    if (listWrap) listWrap.setAttribute("aria-busy", show?"true":"false");
    if (list){ if (show) list.innerHTML=""; list.style.display = show ? "none" : "grid"; }
    if (vazio && !show) vazio.hidden=true;
  }

  // ===== UI =====
  configurarUI(){
    document.getElementById("campo-pesquisa")?.addEventListener("input", e=>{ this.filtros.pesquisa=String(e.target.value||"").trim(); this.page=1; this.renderizar(); });
    document.getElementById("filtro-status")?.addEventListener("change", e=>{ this.filtros.status=(e.target.value||"todos").toLowerCase(); this.page=1; this.renderizar(); });
    document.getElementById("botao-exportar")?.addEventListener("click",()=>this.exportar());

    // grid: open/enrich
    document.getElementById("container-devolucoes")?.addEventListener("click",(e)=>{
      const card = e.target.closest?.("[data-return-id]"); if(!card) return;
      const id   = card.getAttribute("data-return-id");
      if (e.target.closest?.('[data-action="open"]') || e.target.closest?.(".botao-detalhes")) return this.abrirDetalhes(id);
      if (e.target.closest?.('[data-action="enrich"]')) {
        const orderId = card.getAttribute("data-order-id") || "";
        const claimId = card.getAttribute("data-claim-id") || "";
        return this.quickEnrich(id, orderId, claimId);
      }
    });

    document.getElementById("paginacao")?.addEventListener("click",(e)=>{
      const a=e.target.closest("button[data-page]"); if(!a) return;
      const p=Number(a.getAttribute("data-page")); if(!Number.isFinite(p)||p===this.page) return;
      this.page=p; this.renderizar();
    });

    // auto-refresh invisível
    const btn=document.createElement("button");
    btn.id="auto-refresh-hidden"; btn.type="button"; btn.style.display="none"; btn.setAttribute("aria-hidden","true");
    btn.addEventListener("click",()=>this.atualizarDados());
    document.body.appendChild(btn);
  }

  // ===== Auto-sync =====
  startAutoSync(){
    const fire=()=>{ const b=document.getElementById("auto-refresh-hidden"); if(!b) return; if(document.hidden||!navigator.onLine) return; b.click(); };
    setTimeout(fire,2000);
    setInterval(fire,this.SYNC_MS);
    document.addEventListener("visibilitychange",()=>{ if(!document.hidden) setTimeout(fire,500); });
    window.addEventListener("online",()=>setTimeout(fire,500));
  }

  // ===== Circuit breaker claims/import =====
  claimsImportAllowed(){ try{ const until=Number(localStorage.getItem(this.CLAIMS_BLOCK_KEY)||0); return Date.now()>until; }catch{ return true; } }
  blockClaimsImport(){ try{ localStorage.setItem(this.CLAIMS_BLOCK_KEY, String(Date.now()+this.CLAIMS_BLOCK_MS)); }catch{} }

  // ===== Sync de devoluções (novo) =====
  async syncReturnsWithFallback(){
    const daysList = [3,7,30];
    for (const d of daysList){
      const qs = new URLSearchParams({ silent:"1", all:"1", days:String(d) });

      // 1) endpoint principal
      for (const url of [
        `/api/ml/returns/import?${qs.toString()}`,
        `/api/ml/returns/sync?${qs.toString()}`,
        `/api/returns/sync?${qs.toString()}`
      ]) {
        console.info("[sync] returns:", url);
        const r = await this.fetchQuiet(url);
        if (r.ok) return true;

        if (r.status === 401) {
          this.toast("Conectar Mercado Livre","Sua sessão do ML expirou. Entre novamente para sincronizar devoluções.","erro");
          return false;
        }
        // 404: endpoint não existe — tenta próximo fallback
        // 429/5xx: só sai do loop desse d e tenta outro d
        if ([429,500,502,503,504].includes(r.status)) break;
      }
    }
    return false;
  }

  // ===== Sync principal (curto) =====
  async syncClaimsWithFallback(){
    if (!this.claimsImportAllowed()) return false;
    for (const d of [3,7,30]){
      console.info("[sync] claims/import:", `${d}d in_progress`);
      const qs = new URLSearchParams({ silent:"1", all:"1", days:String(d), status:"in_progress" });
      const r = await this.fetchQuiet(`/api/ml/claims/import?${qs.toString()}`);
      if (r.ok) return true;
      const bad = (r.status===400) || (r.detail||"").toString().toLowerCase().includes("invalid_claim_id");
      if (bad){
        this.blockClaimsImport();
        if (!this._lastSyncErrShown){ this._lastSyncErrShown=true; this.toast("Aviso","ML recusou o import (400 invalid_claim_id). Vou pausar por 6h e seguir com envio.","erro"); }
        return false;
      }
    }
    return false;
  }

  async atualizarDados(){
    if (this._syncInFlight) return;            // lock anti-dobro
    this._syncInFlight = true;
    try{
      const before=new Set(this.items.map(d=>String(d.id)));

      // 1) puxa novas devoluções do ML (urgente)
      await this.syncReturnsWithFallback();

      // 2) tenta também claims (movimenta estágios/fluxo)
      await this.syncClaimsWithFallback();

      // 3) recarrega lista e renderiza
      await this.carregar();
      const novos=this.items.filter(d=>!before.has(String(d.id))).length;
      if(novos>0) this.toast("Atualizado", `${novos} novas devoluções sincronizadas.`, "sucesso");
      this.renderizar();
    } finally {
      this._syncInFlight = false;
    }
  }

  // ===== Quick enrich por card =====
  async quickEnrich(id, orderId, claimId){
    if (!id) return;
    await this.fetchQuiet(`/api/ml/returns/${encodeURIComponent(id)}/enrich`); // best-effort

    // força leitura de status logístico por order_id (se permitido)
    let sug = null;
    if (orderId && this.mlShipAllowed()) {
      const r = await this.fetchQuiet(`/api/ml/shipping/sync?order_id=${encodeURIComponent(orderId)}&silent=1`);
      if (r.ok) {
        sug = r.data?.suggested_log_status || null;
      } else if (r.status===403) {
        this.setNoAccess(orderId);
      }
    }
    if (claimId) await this.fetchQuiet(`/api/ml/claims/${encodeURIComponent(claimId)}`);

    if (sug) {
      const it = this.items.find(x => String(x.id) === String(id));
      if (it) it.log_status = sug;
    }
    this.queueRefresh(250);
    this.toast("Sucesso","Devolução atualizada com o Mercado Livre.","sucesso");
  }

  // ===== Fluxo (resolver via shipping/claim) =====
  extractFlowString(d){
    const pick=(o,ks)=>{ for(const k of ks){ if(o&&o[k]!=null) return String(o[k]); } return ""; };
    let s = pick(d,[
      "log_status","status_log","flow","flow_status","ml_flow",
      "shipping_status","ship_status","ml_shipping_status","return_shipping_status","current_shipping_status","tracking_status",
      "claim_status","claim_stage"
    ]) || "";
    if (!s && d.shipping) s = pick(d.shipping,["status","substatus"]);
    if (!s && d.return)   s = pick(d.return,["status"]);
    if (!s && d.claim)    s = pick(d.claim, ["stage","status"]);
    return String(s||"").toLowerCase().trim();
  }

  // CLAIM > SHIPPING > RETURN > LOG_STATUS
  computeFlow(d){
    const lower = v => String(v||"").toLowerCase();

    // CLAIM
    const cStage = lower(d.claim?.stage || d.claim_stage || d.claim?.status || d.claim_status || d.claim_state);
    if (/(mediat|media[cç]ao)/.test(cStage)) return "mediacao";
    if (/(open|opened|pending|dispute|reclama|claim)/.test(cStage)) return "disputa";

    // SHIPPING
    const sStat = lower(
      d.ml_shipping_status || d.shipping_status || d.return_shipping_status ||
      d.current_shipping_status || d.tracking_status ||
      d.shipping?.status || d.ml_shipping?.status
    );
    const sSub  = lower(d.ml_substatus || d.shipping?.substatus || d.ml_shipping?.substatus);
    const ship = [sStat, sSub].join("_");

    if (/ready_to_ship|handling|aguardando_postagem|label|etiq|prepar/.test(ship)) return "em_preparacao";
    if (/in_transit|on_the_way|transit|a_caminho|posted|shipped|out_for_delivery|returning_to_sender|em_transito/.test(ship)) return "em_transporte";
    if (/delivered|entreg|arrived|recebid/.test(ship)) return "recebido_cd";
    if (/not_delivered|cancel/.test(ship)) return "pendente";

    // RETURN
    const rStat = lower(d.return?.status || d.return_status || d.status_devolucao || d.status_log);
    if (/closed|fechado|devolvido|finaliz/.test(rStat)) return "fechado";

    // Fallback
    const log = lower(d.log_status || d.flow || d.flow_status || d.ml_flow);
    return this.normalizeFlow(log);
  }

  normalizeFlow(s){
    if(!s) return "pendente";
    const t = String(s).toLowerCase().replace(/\s+/g,"_");

    if (/(mediat|media[cç]ao)/.test(t)) return "mediacao";
    if (/(disputa|reclama|claim_open|claim)/.test(t)) return "disputa";

    if (t.includes("preparacao")) return "em_preparacao";
    if (t === "transporte")       return "em_transporte";
    if (t.includes("recebido_cd")) return "recebido_cd";
    if (t.includes("aguardando_postagem")) return "em_preparacao";
    if (t.includes("postado")) return "em_transporte";
    if (t.includes("em_transito")) return "em_transporte";
    if (t.includes("a_caminho") || /(on_the_way|in_transit)/.test(t)) return "em_transporte";
    if (t.includes("em_inspecao")) return "em_preparacao";
    if (t.includes("nao_recebido")) return "pendente";
    if (t.includes("devolvido") || t.includes("fechado") || /(closed)/.test(t)) return "fechado";
    if (/(prepar|prep|ready_to_ship)/.test(t)) return "em_preparacao";
    if (/(pronto|label|etiq|ready)/.test(t)) return "pronto_envio";
    if (/(transit|transito|transporte|enviado|shipped|out_for_delivery|returning_to_sender)/.test(t)) return "em_transporte";
    if (/(delivered|entreg|arrived|recebid)/.test(t)) return "recebido_cd";
    return "pendente";
  }

  getCachedFlow(orderId){
    try{
      const raw = localStorage.getItem(this.FLOW_CACHE_PREFIX+orderId);
      if(!raw) return null;
      const { ts, flow, neg } = JSON.parse(raw);
      const ttl = neg ? this.ML_NOACCESS_TTL_MS : this.FLOW_TTL_MS;
      if (!ts || Date.now()-ts > ttl) return null;
      return flow || null;
    }catch{ return null; }
  }
  setCachedFlow(orderId, flow){
    try{ localStorage.setItem(this.FLOW_CACHE_PREFIX+orderId, JSON.stringify({ ts: Date.now(), flow, neg:false })); }catch{}
  }
  setNoAccess(orderId){
    try{ localStorage.setItem(this.FLOW_CACHE_PREFIX+orderId, JSON.stringify({ ts: Date.now(), flow:"__NO_ACCESS__", neg:true })); }catch{}
  }

  // pega status logístico diretamente do resumo do backend
  async fetchShippingFlow(orderId){
    if (!orderId) return "";
    if (!this.mlShipAllowed()) return "";            // respeita bloqueio
    const r = await this.fetchQuiet(`/api/ml/shipping/status?order_id=${encodeURIComponent(orderId)}&silent=1`);
    if (!r.ok) {
      if (r.status===403) this.setNoAccess(orderId);
      return "";
    }
    const s = r.data || {};
    return String(s.suggested_log_status || s.ml_substatus || s.ml_status || "").toLowerCase();
  }

  async resolveAndPatchFlow(d){
    const id = d?.id;
    const orderId = d?.id_venda || d?.order_id;
    if (!id || !orderId) return;

    // limite por ciclo de render — conta a tentativa antes do fetch
    if (this._flowResolvesThisTick >= this.MAX_FLOW_RES_PER_TICK) return;

    // throttle
    if (!this.shouldTryFlow(orderId)) return;

    // conta esta tentativa
    this._flowResolvesThisTick++;

    // cache
    const cached = this.getCachedFlow(orderId);
    if (cached){
      if (cached === "__NO_ACCESS__") return; // não re-tenta por 24h
      const canon = this.normalizeFlow(cached);
      if (canon && canon !== this.computeFlow(d)){
        await this.patchFlow(id, canon);
        this.queueRefresh(250);
      }
      return;
    }

    if (!this.mlShipAllowed()) return;

    const found = await this.fetchShippingFlow(orderId);
    if (!found) return;

    this.setCachedFlow(orderId, found);
    const canon = this.normalizeFlow(found);
    if (!canon) return;

    const curCanon = this.computeFlow(d);
    if (canon !== curCanon){
      await this.patchFlow(id, canon);
      this.queueRefresh(300);
    }
  }

  async patchFlow(id, canon){
    await this.fetchQuiet(`/api/returns/${encodeURIComponent(id)}`); // aquece
    await fetch(`/api/returns/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type":"application/json" },
      credentials: "include",
      body: JSON.stringify({ log_status: canon, updated_by: "frontend-flow-resolver" })
    }).catch(()=>{});
  }

  // ===== Render =====
  renderizar(){
    const container=document.getElementById("container-devolucoes");
    const vazio=document.getElementById("mensagem-vazia");
    const descVazio=document.getElementById("descricao-vazia");
    const countEl=document.getElementById("lista-count");
    const pag=document.getElementById("paginacao");
    if(!container) return;

    const q=(this.filtros.pesquisa||"").toLowerCase();
    const st=(this.filtros.status||"todos").toLowerCase();

    const filtrados=(this.items||[]).filter(d=>{
      const textoMatch=[d.cliente_nome,d.id_venda,d.sku,d.loja_nome,d.status,d.log_status,d.shipping_status,d.ml_shipping_status]
        .map(x=>String(x||"").toLowerCase()).some(s=>s.includes(q));
      const statusMatch = st==="todos" || this.grupoStatus(d.status)===st;
      return textoMatch && statusMatch;
    });

    filtrados.sort((a,b)=>this.getDateMs(b)-this.getDateMs(a));
    if(countEl) countEl.textContent=String(filtrados.length);

    if (!filtrados.length){
      container.style.display="none";
      if (vazio){ vazio.hidden=false; if(descVazio) descVazio.textContent = q || (st!=="todos" ? "Tente ajustar os filtros" : "Ajuste os filtros de pesquisa"); }
      if (pag) pag.innerHTML="";
      return;
    }

    const total=filtrados.length;
    const totalPages=Math.max(1, Math.ceil(total/this.pageSize));
    if (this.page>totalPages) this.page=totalPages;
    const start=(this.page-1)*this.pageSize, end=start+this.pageSize;
    const pageItems=filtrados.slice(start,end);

    container.style.display="grid";
    if (vazio) vazio.hidden=true;
    container.innerHTML="";
    this._flowResolvesThisTick = 0; // reset do limite por render

    pageItems.forEach((d,i)=>{
      const card=this.card(d,i);
      card.setAttribute("role","listitem");
      container.appendChild(card);

      // Se o fluxo ainda é "pendente", tenta resolver com throttle
      const flowNow = this.computeFlow(d);
      const oid = d.id_venda || d.order_id;
      if (flowNow==="pendente" && oid) {
        this.resolveAndPatchFlow(d); // assíncrono
      }
    });

    this.renderPaginacao(totalPages);
  }

  renderPaginacao(totalPages){
    const nav=document.getElementById("paginacao"); if(!nav) return;
    if (totalPages<=1){ nav.innerHTML=""; return; }
    const cur=this.page;
    const btn=(p,label=p,dis=false,act=false)=>`<button class="page-btn${act?" is-active":""}" data-page="${p}" ${dis?"disabled aria-disabled='true'":""} aria-label="Página ${p}">${label}</button>`;
    const win=5; let start=Math.max(1, cur-Math.floor(win/2)); let end=start+win-1;
    if (end>totalPages){ end=totalPages; start=Math.max(1, end-win+1); }
    let html="";
    html+=btn(Math.max(1,cur-1),"‹",cur===1,false);
    if (start>1){ html+=btn(1,"1",false,cur===1); if(start>2) html+='<span class="page-ellipsis" aria-hidden="true">…</span>'; }
    for(let p=start;p<=end;p++) html+=btn(p,String(p),false,p===cur);
    if (end<totalPages){ if(end<totalPages-1) html+='<span class="page-ellipsis" aria-hidden="true">…</span>'; html+=btn(totalPages,String(totalPages),false,cur===totalPages); }
    html+=btn(Math.min(totalPages,cur+1),"›",cur===totalPages,false);
    nav.innerHTML=html;
  }

  // ===== Cards/Badges =====
  card(d, index=0){
    const el=document.createElement("div");
    el.className="card-devolucao slide-up";
    el.style.animationDelay = `${index * 0.08}s`;
    el.setAttribute("data-return-id", String(d.id));
    if (d.id_venda) el.setAttribute("data-order-id", String(d.id_venda));
    if (d.ml_claim_id) el.setAttribute("data-claim-id", String(d.ml_claim_id));

    const data = this.dataBr(d.created_at || d.data_compra || d.order_date);
    const valorProduto = Number(d.valor_produto||0);
    const valorFrete   = Number(d.valor_frete||0);

    el.innerHTML = `
      <div class="devolucao-header">
        <div class="devolucao-titulo-area">
          <h3 class="devolucao-titulo">
            <svg class="icone" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1a2.5 2.5 0 0 1 2.5 2.5V4h-5v-.5A2.5 2.5 0 0 1 8 1zm3.5 3v-.5a3.5 3.5 0 1 0-7 0V4H1v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V4h-3.5z"/></svg>
            #${this.esc(d.id_venda || "-")}
          </h3>
          <p class="devolucao-subtitulo">${this.esc(d.cliente_nome || "—")}</p>
        </div>
        <div class="devolucao-acoes">
          ${this.badgeNova(d)}
          ${this.badgeFluxo(d)}
          ${this.badgeStatus(d)}
          <button class="botao botao-link" data-action="enrich" title="Forçar atualização no ML">Atualizar ML</button>
        </div>
      </div>

      <div class="devolucao-conteudo">
        <div class="campo-info">
          <svg class="icone" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M0 1.5A.5.5 0 0 1 .5 1H2a.5.5 0 0 1 .485.379L2.89 3H14.5a.5.5 0 0 1 .491.592l-1.5 8A.5.5 0 0 1 13 12H4a.5.5 0 0 1-.491-.408L2.01 3.607 1.61 2H.5a.5.5 0 0 1-.5-.5z"/></svg>
          <span class="campo-label">Loja</span>
          <span class="campo-valor">${this.esc(d.loja_nome || "—")}</span>
        </div>
        <div class="campo-info">
          <svg class="icone" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3.5 0a.5.5 0 0 1 .5.5V1h8V.5a.5.5 0 0 1 1 0V1h1a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2h1V.5a.5.5 0 0 1 .5-.5z"/></svg>
          <span class="campo-label">Data</span>
          <span class="campo-valor">${data}</span>
        </div>
        <div class="campo-info">
          <svg class="icone" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1a2.5 2.5 0 0 1 2.5 2.5V4h-5v-.5A2.5 2.5 0  0 1 8 1zm3.5 3v-.5a3.5 3.5 0 1 0-7 0V4H1v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V4h-3.5z"/></svg>
          <span class="campo-label">Produto</span>
          <span class="campo-valor valor-destaque">${this.formatBRL(valorProduto)}</span>
        </div>
        <div class="campo-info">
          <svg class="icone" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M0 3.5A1.5 1.5 0 0 1 1.5 2h9A1.5 1.5 0 0 1 12 3.5V5h1.02a1.5 1.5 0 0 1 1.17.563l1.481 1.85a1.5 1.5 0 0 1 .329.938V10.5a1.5 1.5 0 0 1-1.5 1.5H14a2 2 0 1 1-4 0H5a2 2 0 1 1-3.998-.085A1.5 1.5 0 0 1 0 10.5v-7z"/></svg>
          <span class="campo-label">Frete</span>
          <span class="campo-valor valor-destaque">${this.formatBRL(valorFrete)}</span>
        </div>
      </div>

      <div class="devolucao-footer">
        <a href="../devolucao-editar.html?id=${encodeURIComponent(d.id)}" class="link-sem-estilo" target="_blank" rel="noopener">
          <button class="botao botao-outline botao-detalhes" data-action="open">
            <svg class="icone" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M16 8s-3-5.5-8-5.5S0 8 0 8s3 5.5 8 5.5S16 8 16 8zM1.173 8a13.133 13.133 0 0 1 1.66-2.043C4.12 4.668 5.88 3.5 8 3.5c2.12 0 3.879 1.168 5.168 2.457A13.133 13.133 0 0 1 14.828 8c-.58.87-3.828 5-6.828 5S2.58 8.87 1.173 8z"/><path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/></svg>
            Ver Detalhes
          </button>
        </a>
      </div>
    `;
    return el;
  }

  badgeNova(d){ return this.isNova(d) ? '<div class="badge badge-new" title="Criada recentemente">Nova devolução</div>' : ""; }
  badgeStatus(d){
    const grp=this.grupoStatus(d.status);
    const map={
      pendente:'<div class="badge badge-pendente" title="Status interno">Pendente</div>',
      aprovado:'<div class="badge badge-aprovado" title="Status interno">Aprovado</div>',
      rejeitado:'<div class="badge badge-rejeitado" title="Status interno">Rejeitado</div>',
      em_analise:'<div class="badge badge-info" title="Status interno">Em Análise</div>',
      finalizado:'<div class="badge badge-aprovado" title="Status interno">Finalizado</div>',
    };
    return map[grp] || `<div class="badge" title="Status interno">${this.esc(d.status||"—")}</div>`;
  }
  badgeFluxo(d){
    const flow = this.computeFlow(d);
    const labels = { disputa:"Em Disputa", mediacao:"Mediação", em_preparacao:"Em Preparação", pronto_envio:"Pronto p/ Envio", em_transporte:"A caminho", recebido_cd:"Recebido no CD", fechado:"Fechado", pendente:"Fluxo Pendente" };
    const css    = { disputa:"badge-info", mediacao:"badge-info", em_preparacao:"badge-pendente", pronto_envio:"badge-aprovado", em_transporte:"badge-info", recebido_cd:"badge-aprovado", fechado:"badge-rejeitado", pendente:"badge" };
    const key = flow || "pendente";
    return `<div class="badge ${css[key]||"badge"}" title="Fluxo da devolução">${labels[key]||"Fluxo"}</div>`;
  }
  grupoStatus(st){
    const s=String(st||"").toLowerCase();
    for (const [g,set] of Object.entries(this.STATUS_GRUPOS)) if (set.has(s)) return g;
    if (s==="em_analise"||s==="em-analise") return "em_analise";
    return "pendente";
  }

  // ===== ações =====
  abrirDetalhes(id){
    const modal=document.getElementById("modal-detalhe");
    if (modal && modal.showModal) modal.showModal();
    else this.toast("Info",`Abrindo detalhes da devolução #${id}`,"info");
  }
  exportar(){
    const cols=["id","id_venda","cliente_nome","loja_nome","sku","status","log_status","valor_produto","valor_frete","created_at"];
    const linhas=[cols.join(",")].concat(this.items.map(d=>cols.map(c=>`"${String(d[c]??"").replace(/"/g,'""')}"`).join(",")));
    const blob=new Blob([linhas.join("\n")],{type:"text/csv;charset=utf-8"});
    const url=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download="devolucoes.csv"; a.click(); URL.revokeObjectURL(url);
    this.toast("Sucesso","Relatório exportado.","sucesso");
  }
  toast(titulo,descricao,_tipo="info"){
    const t=document.getElementById("toast"), ti=document.getElementById("toast-titulo"), de=document.getElementById("toast-descricao");
    if(!t||!ti||!de) return; ti.textContent=titulo; de.textContent=descricao; t.classList.add("show"); setTimeout(()=>t.classList.remove("show"),3000);
  }
}

// boot
if (document.readyState==="loading") document.addEventListener("DOMContentLoaded",()=>new DevolucoesFeed());
else new DevolucoesFeed();
