// /public/js/index.js — Feed com fallback ao vivo das “devoluções abertas” do ML
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

    // circuit breaker claims/import
    this.CLAIMS_BLOCK_MS  = 6 * 60 * 60 * 1000; // padrão (pode ser reduzido caso "invalid_claim_id")
    this.CLAIMS_BLOCK_KEY = "rf:claimsImport:blockUntil";

    // fluxo cache (shipping)
    this.FLOW_TTL_MS = 30 * 60 * 1000;
    this.FLOW_CACHE_PREFIX = "rf:flowCache:";

    // cache de return status (para claim_id)
    this.RETURN_TTL_MS = 30 * 60 * 1000;
    this.RETURN_CACHE_PREFIX = "rf:returnCache:";

    // ML shipping guard
    this.ML_SHIP_BLOCK_KEY  = "rf:mlShipping:blockUntil";
    this.ML_SHIP_BLOCK_MS   = 2 * 60 * 60 * 1000;
    this.ML_NOACCESS_TTL_MS = 24 * 60 * 60 * 1000;
    this._ml403BurstCount   = 0;
    this._ml403BurstTimer   = null;

    // mensagens (off por enquanto)
    this._messagesSyncDisabled = true;

    // seller headers
    this.sellerId   = document.querySelector('meta[name="ml-seller-id"]')?.content?.trim()
                   || localStorage.getItem('rf:sellerId') || '';
    this.sellerNick = document.querySelector('meta[name="ml-seller-nick"]')?.content?.trim()
                   || localStorage.getItem('rf:sellerNick') || '';
    // token opcional (dev)
    this.sellerToken = document.querySelector('meta[name="ml-seller-token"]')?.content?.trim()
                    || localStorage.getItem('rf:sellerToken') || '';

    // grupos internos (para filtro e badgeStatus)
    this.STATUS_GRUPOS = {
      aprovado:   new Set(["aprovado","autorizado","autorizada"]),
      rejeitado:  new Set(["rejeitado","rejeitada","negado","negada"]),
      finalizado: new Set(["concluido","concluida","finalizado","finalizada","fechado","fechada","encerrado","encerrada"]),
      pendente:   new Set(["pendente","em_analise","em-analise","aberto"]),
    };

    // ATIVADO: permitimos buscas por claims/returns no ML
    this.HAS_CLAIMS_SEARCH = true;

    // anti-F5
    this._refreshTimer = null;
    this.REFRESH_COOLDOWN_MS = 800;
    this.TRY_FLOW_PREFIX = "rf:flowTry:";
    this.TRY_FLOW_MS = 10 * 60 * 1000;
    this._syncInFlight = false;
    this.MAX_FLOW_RES_PER_TICK = 10;
    this._flowResolvesThisTick = 0;

    // mensagem de erro genérica
    this.GENERIC_ERR = "Erro ao importar. Tente novamente";

    this.inicializar();
  }

  // ===== infra util =====
  queueRefresh(delay = this.REFRESH_COOLDOWN_MS) {
    if (this._refreshTimer) return;
    this._refreshTimer = setTimeout(async () => {
      this._refreshTimer = null;
      await this.carregar();
      this.renderizar();
    }, delay);
  }
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

    // → puxa devoluções abertas do ML logo no boot
    await this.syncClaimsWithFallback();
    await this.carregar();
    this.renderizar();

    this.startAutoSync();
  }

  safeJson(res){
    if(!res.ok) throw new Error("HTTP "+res.status);
    return res.status===204?{}:res.json();
  }
  mlShipAllowed(){
    try{
      const until=Number(localStorage.getItem(this.ML_SHIP_BLOCK_KEY)||0);
      return Date.now()>until;
    }catch{ return true; }
  }
  blockMlShip(ms=this.ML_SHIP_BLOCK_MS){
    try{ localStorage.setItem(this.ML_SHIP_BLOCK_KEY, String(Date.now()+ms)); }catch{}
  }
  _headersFor(url){
    const h = { Accept:"application/json" };
    if (/^\/api\/ml\//.test(url) || /^\/api\/meli\//.test(url)) {
      if (this.sellerId)     h['x-seller-id']     = this.sellerId;
      if (this.sellerNick)   h['x-seller-nick']   = this.sellerNick;
      if (this.sellerToken)  h['x-seller-token']  = this.sellerToken; // dev override opcional
    }
    return h;
  }
  async fetchQuiet(url){
    try{
      const headers = this._headersFor(url);
      const r = await fetch(url,{ headers, credentials:"include" });
      const ct = r.headers.get("content-type")||"";
      let body=null;
      if (ct.includes("application/json")) { try{ body = await r.json(); }catch{} }
      else { try{ body = await r.text(); }catch{} }

      // Trata payloads { ok:false } como erro lógico, mesmo em HTTP 200
      if (r.ok && body && typeof body === "object" && body.ok === false) {
        const detail = (body.error || body.message || "").toString();
        console.info("[sync]", url, "→ 200 (app-error)", detail.slice(0,160));
        return { ok:false, status:r.status, detail, data:body };
      }

      if(!r.ok){
        const detail = body && (body.error||body.message) ? (body.error||body.message) : (typeof body==="string" ? body : "");
        console.info("[sync]", url, "→", r.status, (detail||"").toString().slice(0,160));

        // 401 sem token do ML (qualquer endpoint ML)
        if (r.status === 401 && (detail||"").toLowerCase().includes('missing_access_token')) {
          if (!this._lastSyncErrShown){ this._lastSyncErrShown = true; this.toast("Conectar Mercado Livre", "Faça login para sincronizar as devoluções.", "erro"); }
          return { ok:false, status:r.status, detail, data:body };
        }

        // Guardas específicos de shipping
        if (url.includes('/api/ml/shipping')) {
          if (r.status===401) {
            this.blockMlShip(30*60*1000);
            if (!this._lastSyncErrShown){
              this._lastSyncErrShown = true;
              this.toast("Erro", this.GENERIC_ERR, "erro");
            }
          } else if (r.status===403) {
            this._ml403BurstCount++;
            if (!this._ml403BurstTimer) {
              this._ml403BurstTimer = setTimeout(()=>{
                this._ml403BurstCount = 0; this._ml403BurstTimer=null;
              }, 60*1000);
            }
            if (this._ml403BurstCount >= 3) {
              this.blockMlShip();
              this._ml403BurstCount = 0;
              clearTimeout(this._ml403BurstTimer); this._ml403BurstTimer=null;
              this.toast("Erro", this.GENERIC_ERR, "erro");
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

  // ===== “Nova” =====
  stableKey(d){ return d?.id_venda || d?.ml_claim_id || d?.order_id || d?.resource_id || d?.id; }
  firstSeenTs(key){
    try{
      const k=this.NEW_KEY_PREFIX+key;
      const v=localStorage.getItem(k);
      if(v) return Number(v)||0;
      const now=Date.now();
      localStorage.setItem(k,String(now));
      return now;
    }catch{ return 0; }
  }
  isNova(d){
    const key=this.stableKey(d); if(!key) return false;
    const created=this.getDateMs(d);
    if (created && Date.now()-created > this.MAX_NEW_AGE_MS) return false;
    return Date.now()-this.firstSeenTs(key) <= this.NEW_WINDOW_MS;
  }
  purgeOldSeen(){
    try{
      const now=Date.now();
      for(let i=localStorage.length-1;i>=0;i--){
        const k=localStorage.key(i);
        if(!k||!k.startsWith(this.NEW_KEY_PREFIX)) continue;
        const ts=Number(localStorage.getItem(k))||0;
        if(now-ts>20*this.MAX_NEW_AGE_MS) localStorage.removeItem(k);
      }
    }catch{}
  }

  // ===== carregar =====
  getMockData(){ return []; } // sem mock p/ não confundir datas
  async carregar(){
    this.toggleSkeleton(true);
    try{
      // 1) banco
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
      this.items = Array.isArray(list) ? list : [];

      // 2) (opcional) mesclar open returns do ML aqui — DESLIGADO
      if(!list && !this.items.length && last) throw last;
    }catch(e){
      console.warn("[index] Falha ao carregar", e?.message);
      this.toast("Erro", this.GENERIC_ERR, "erro");
    }finally{ this.toggleSkeleton(false); }
  }

  // ===== Circuit breaker claims/import =====
  claimsImportAllowed(){ try{ const until=Number(localStorage.getItem(this.CLAIMS_BLOCK_KEY)||0); return Date.now()>until; }catch{ return true; } }
  blockClaimsImport(ms=this.CLAIMS_BLOCK_MS){ try{ localStorage.setItem(this.CLAIMS_BLOCK_KEY, String(Date.now()+ms)); }catch{} }

  // ===== caches =====
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

  getCachedReturn(claimId){
    try{
      const raw = localStorage.getItem(this.RETURN_CACHE_PREFIX+claimId);
      if(!raw) return null;
      const { ts, status, flow } = JSON.parse(raw);
      if (!ts || Date.now()-ts > this.RETURN_TTL_MS) return null;
      return { status, flow };
    }catch{ return null; }
  }
  setCachedReturn(claimId, status, flow){
    try{ localStorage.setItem(this.RETURN_CACHE_PREFIX+claimId, JSON.stringify({ ts: Date.now(), status, flow })); }catch{}
  }

  // tenta descobrir o claim_id se não veio no card
  async ensureClaimIdOnItem(item){
    if (item.ml_claim_id) return item.ml_claim_id;

    // 1) tenta buscar o registro completo no back
    try{
      const r = await this.fetchQuiet(`/api/returns/${encodeURIComponent(item.id)}`);
      if (r.ok && r.data){
        const tryKeys = ["ml_claim_id","claim_id","ml_claim","claimId","ml_claimId"];
        for (const k of tryKeys){
          const v = r.data[k];
          if (v){ item.ml_claim_id = String(v); return item.ml_claim_id; }
        }
      }
    }catch{}

    // 2) (mantém desligado se o back não tiver endpoints de claims)
    if (!this.HAS_CLAIMS_SEARCH) return null;
    return null;
  }

  // ===== Syncs curtos =====
  async syncClaimsWithFallback(){
    // 1) TENTAR returns/sync (preferível): inclui status da devolução (v2)
    for (const d of [3,7,30]){
      const qs = new URLSearchParams({
        silent: "1",
        days: String(d),
        status: "opened,in_progress,shipped,pending_delivered,delivered"
      });
      if (this.sellerId)   qs.set('seller_id', this.sellerId);
      if (this.sellerNick) qs.set('seller_nick', this.sellerNick);
      console.info("[sync] returns/sync:", `${d}d`);
      const r = await this.fetchQuiet(`/api/ml/returns/sync?${qs.toString()}`);
      if (r.ok) {
        try { localStorage.removeItem(this.CLAIMS_BLOCK_KEY); } catch {}
        return true;
      }
    }

    // 2) Fallback: claims/import (se permitido)
    if (!this.claimsImportAllowed()) return false;
    for (const d of [3,7,30]){
      const qs = new URLSearchParams({
        silent:"1",
        all:"1",
        days:String(d),
        statuses:"opened,in_progress"
      });
      if (this.sellerId)   qs.set('seller_id', this.sellerId);
      if (this.sellerNick) qs.set('seller_nick', this.sellerNick);

      console.info("[sync] claims/import:", `${d}d opened,in_progress`);
      const r = await this.fetchQuiet(`/api/ml/claims/import?${qs.toString()}`);
      if (r.ok) return true;

      const detail = (r.detail||"").toString().toLowerCase();
      const bad = (r.status===400) || detail.includes("invalid_claim_id");
      if (bad){
        // reduz punição p/ 30 min para não travar operação
        try{ localStorage.setItem(this.CLAIMS_BLOCK_KEY, String(Date.now()+30*60*1000)); }catch{}
        if (!this._lastSyncErrShown){
          this._lastSyncErrShown=true;
          this.toast("Erro", this.GENERIC_ERR, "erro");
        }
        return false;
      }
    }
    return false;
  }

  async atualizarDados(){
    if (this._syncInFlight) return;
    this._syncInFlight = true;
    try{
      const before=new Set(this.items.map(d=>String(d.id)));
      await this.syncClaimsWithFallback();
      await this.carregar();
      const novos=this.items.filter(d=>!before.has(String(d.id))).length;
      if(novos>0) this.toast("Atualizado", `${novos} novas devoluções sincronizadas.`, "sucesso");
      this.renderizar();
    } finally {
      this._syncInFlight = false;
    }
  }

  // ===== Shipping flow (backend retorna .flow/.suggested_log_status) =====
  async fetchShippingFlow(orderId){
    if (!orderId) return "";
    if (!this.mlShipAllowed()) return "";
    const r = await this.fetchQuiet(`/api/ml/shipping/status?order_id=${encodeURIComponent(orderId)}&silent=1`);
    if (!r.ok) { if (r.status===403) this.setNoAccess(orderId); return ""; }
    const s = r.data || {};
    return String(s.flow || s.suggested_log_status || s.ml_substatus || s.ml_status || "").toLowerCase();
  }

  // ===== Quick enrich por card =====
  async quickEnrich(id, orderId, claimId){
    if (!id) return;

    // tenta descobrir claim_id se não veio
    const it = this.items.find(x => String(x.id) === String(id));
    if (it && !claimId) claimId = await this.ensureClaimIdOnItem(it);

    // 1) Returns state
    if (claimId){
      const r = await this.fetchQuiet(`/api/ml/returns/state?claim_id=${encodeURIComponent(claimId)}${orderId?`&order_id=${encodeURIComponent(orderId)}`:""}&silent=1`);
      if (r.ok) {
        const flow = String(r.data?.flow || "").toLowerCase();
        const raw  = String(r.data?.raw_status || "").toLowerCase();
        if (it){
          if (flow) it.log_status = flow;
          if (raw)  it.ml_return_status = raw;
        }
        this.setCachedReturn(claimId, raw || "", flow || "");
      }
    }

    // 2) Shipping state (usa /status com update=1 para também persistir no back)
    if (orderId && this.mlShipAllowed()) {
      const r = await this.fetchQuiet(`/api/ml/shipping/status?order_id=${encodeURIComponent(orderId)}&update=1&silent=1`);
      if (r.ok) {
        const flow = String(r.data?.suggested_log_status || r.data?.ml_substatus || r.data?.ml_status || r.data?.flow || "").toLowerCase();
        if (flow) {
          if (it) it.log_status = this.normalizeFlow(flow);
          this.setCachedFlow(orderId, flow);
        }
      } else if (r.status===403) {
        this.setNoAccess(orderId);
      }
    }

    this.queueRefresh(250);
    this.toast("Sucesso","Devolução atualizada com o Mercado Livre.","sucesso");
  }

  // ===== Fluxo =====
  extractFlowString(d){
    const pick=(o,ks)=>{ for(const k of ks){ if(o&&o[k]!=null) return String(o[k]); } return ""; };
    let s = pick(d,[
      "log_status","status_log","flow","flow_status","ml_flow",
      "shipping_status","ship_status","ml_shipping_status","return_shipping_status","current_shipping_status","tracking_status",
      "claim_status","claim_stage","ml_return_status"
    ]) || "";
    if (!s && d.shipping) s = pick(d.shipping,["status","substatus"]);
    if (!s && d.return)   s = pick(d.return,["status"]);
    if (!s && d.claim)    s = pick(d.claim, ["stage","status"]);
    return String(s||"").toLowerCase().trim();
  }
  computeFlow(d){
    const lower = v => String(v||"").toLowerCase();

    // claim stage
    const cStage = lower(d.claim?.stage || d.claim_stage || d.claim?.status || d.claim_status || d.claim_state);
    if (/(mediat|media[cç]ao)/.test(cStage)) return "mediacao";
    if (/(open|opened|pending|dispute|reclama|claim)/.test(cStage)) return "disputa";

    // shipping (NÃO promove delivered para recebido_cd)
    const sStat = lower(
      d.ml_shipping_status || d.shipping_status || d.return_shipping_status ||
      d.current_shipping_status || d.tracking_status ||
      d.shipping?.status || d.ml_shipping?.status
    );
    const sSub  = lower(d.ml_substatus || d.shipping?.substatus || d.ml_shipping?.substatus);
    const ship = [sStat, sSub].join("_");
    if (/ready_to_ship|handling|aguardando_postagem|label|etiq|prepar/.test(ship)) return "em_preparacao";
    if (/(in_transit|on_the_way|transit|a_caminho|posted|shipped|out_for_delivery|returning_to_sender|em_transito)/.test(ship)) return "em_transporte";
    if (/delivered|entreg|arrived|recebid/.test(ship)) return "pendente"; // não marcamos recebido via shipping
    if (/not_delivered|cancel/.test(ship)) return "pendente";

    // returns status (v2) — AQUI sim “delivered” vira Recebido no CD
    const rStat = lower(d.ml_return_status || d.return?.status || d.return_status || d.status_devolucao || d.status_log);
    if (/^label_generated$|ready_to_ship|etiqueta/.test(rStat)) return "pronto_envio";
    if (/^pending(_.*)?$|pending_cancel|pending_failure|pending_expiration/.test(rStat)) return "pendente";
    if (/^shipped$|pending_delivered$/.test(rStat)) return "em_transporte";
    if (/^delivered$/.test(rStat)) return "recebido_cd";
    if (/^not_delivered$/.test(rStat)) return "pendente";
    if (/^return_to_buyer$/.test(rStat)) return "retorno_comprador";
    if (/^scheduled$/.test(rStat)) return "agendado";
    if (/^expired$/.test(rStat)) return "expirado";
    if (/^failed$/.test(rStat)) return "pendente";
    if (/^cancelled$|canceled$/.test(rStat)) return "cancelado";

    // interno
    const log = lower(d.log_status || d.flow || d.flow_status || d.ml_flow);
    return this.normalizeFlow(log);
  }
  normalizeFlow(t){
    if(!t) return "pendente";
    const s = String(t).toLowerCase().replace(/\s+/g,"_");
    if (/(mediat|media[cç]ao)/.test(s)) return "mediacao";
    if (/(disputa|reclama|claim_open|claim)/.test(s)) return "disputa";
    if (s.includes("preparacao")) return "em_preparacao";
    if (s === "transporte" || s === "em_transito" || s.includes("a_caminho")) return "em_transporte";
    if (s.includes("recebido_cd")) return "recebido_cd";
    if (s.includes("aguardando_postagem")) return "em_preparacao";
    if (s.includes("postado")) return "em_transporte";
    if (/(em_transito|on_the_way|in_transit|a_caminho)/.test(s)) return "em_transporte";
    if (s.includes("em_inspecao")) return "em_preparacao";
    if (/(devolvido|fechado|closed)/.test(s)) return "fechado";
    if (/(prepar|prep|ready_to_ship)/.test(s)) return "em_preparacao";
    if (/(pronto|label|etiq|ready)/.test(s)) return "pronto_envio";
    if (/(transit|transito|transporte|shipped|out_for_delivery|returning_to_sender)/.test(s)) return "em_transporte";
    if (/(delivered|entreg|arrived|recebid)/.test(s)) return "pendente"; // não promovemos aqui
    return "pendente";
  }

  // ===== Resolve de fluxo/returns por card =====
  async resolveAndPatchFlow(d){
    const id = d?.id;
    const orderId = d?.id_venda || d?.order_id;
    let claimId = d?.ml_claim_id;
    if (!id || !orderId) return;
    if (this._flowResolvesThisTick >= this.MAX_FLOW_RES_PER_TICK) return;
    if (!this.shouldTryFlow(orderId)) return;
    this._flowResolvesThisTick++;

    // 1) ensure claim_id e tenta returns/state primeiro (se existir)
    if (!claimId) claimId = await this.ensureClaimIdOnItem(d);
    if (claimId){
      const cached = this.getCachedReturn(claimId);
      if (cached){
        if (cached.status) d.ml_return_status = cached.status;
        if (cached.flow)   d.log_status = cached.flow;
      } else {
        const r = await this.fetchQuiet(`/api/ml/returns/state?claim_id=${encodeURIComponent(claimId)}&order_id=${encodeURIComponent(orderId)}&silent=1`);
        if (r.ok){
          const flow = String(r.data?.flow || "").toLowerCase();
          const raw  = String(r.data?.raw_status || "").toLowerCase();
          if (flow) d.log_status = flow;
          if (raw)  d.ml_return_status = raw;
          this.setCachedReturn(claimId, raw || "", flow || "");
        }
      }
    }

    // 2) shipping para complementar
    const cachedFlow = this.getCachedFlow(orderId);
    if (cachedFlow && cachedFlow !== "__NO_ACCESS__"){
      const canon = this.normalizeFlow(cachedFlow);
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

  // ===== UI =====
  toggleSkeleton(show){
    const $=id=>document.getElementById(id);
    const sk=$("loading-skeleton"), listWrap=$("lista-devolucoes"), list=$("container-devolucoes"), vazio=$("mensagem-vazia");
    if (sk) sk.hidden=!show;
    if (listWrap) listWrap.setAttribute("aria-busy", show?"true":"false");
    if (list){ if (show) list.innerHTML=""; list.style.display = show ? "none" : "grid"; }
    if (vazio && !show) vazio.hidden=true;
  }
  configurarUI(){
    document.getElementById("campo-pesquisa")?.addEventListener("input", e=>{ this.filtros.pesquisa=String(e.target.value||"").trim(); this.page=1; this.renderizar(); });
    document.getElementById("filtro-status")?.addEventListener("change", e=>{ this.filtros.status=(e.target.value||"todos").toLowerCase(); this.page=1; this.renderizar(); });
    document.getElementById("botao-exportar")?.addEventListener("click",()=>this.exportar());

    // grid
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
  startAutoSync(){
    const fire=()=>{ const b=document.getElementById("auto-refresh-hidden"); if(!b) return; if(document.hidden||!navigator.onLine) return; b.click(); };
    setTimeout(fire,2000);
    setInterval(fire,this.SYNC_MS);
    document.addEventListener("visibilitychange",()=>{ if(!document.hidden) setTimeout(fire,500); });
    window.addEventListener("online",()=>setTimeout(fire,500));
  }

  // ===== helpers de status interno =====
  grupoStatus(st){
    const s=String(st||"").toLowerCase();
    for (const [g,set] of Object.entries(this.STATUS_GRUPOS)) if (set.has(s)) return g;
    if (s==="em_analise"||s==="em-analise") return "em_analise";
    return "pendente";
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
      const textoMatch=[d.cliente_nome,d.id_venda,d.sku,d.loja_nome,d.status,d.log_status,d.shipping_status,d.ml_shipping_status,d.ml_return_status]
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
    this._flowResolvesThisTick = 0;

    pageItems.forEach((d,i)=>{
      const card=this.card(d,i);
      card.setAttribute("role","listitem");
      container.appendChild(card);

      const flowNow = this.computeFlow(d);
      const oid = d.id_venda || d.order_id;
      if ((flowNow==="pendente" || !d.ml_return_status) && oid) this.resolveAndPatchFlow(d);
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

  // ===== badges =====
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
    const labels = {
      disputa:"Em Disputa", mediacao:"Mediação", em_preparacao:"Em Preparação",
      pronto_envio:"Pronto p/ Envio", em_transporte:"A caminho",
      recebido_cd:"Recebido no CD", fechado:"Fechado", agendado:"Agendado",
      expirar:"Expirar", retorno_comprador:"Retorno ao Comprador",
      cancelado:"Cancelado", pendente:"Fluxo Pendente"
    };
    const css    = {
      disputa:"badge-info", mediacao:"badge-info", em_preparacao:"badge-pendente",
      pronto_envio:"badge-aprovado", em_transporte:"badge-info",
      recebido_cd:"badge-aprovado", fechado:"badge-rejeitado",
      agendado:"badge-info", expirar:"badge-info", retorno_comprador:"badge-info",
      cancelado:"badge-rejeitado", pendente:"badge"
    };
    const key = flow || "pendente";
    return `<div class="badge ${css[key]||"badge"}" title="Fluxo da devolução">${labels[key]||"Fluxo"}</div>`;
  }
  badgeReturnStatus(d){
    const raw = String(d.ml_return_status || "").toLowerCase();
    if (!raw) return "";
    const label = this.humanReturnStatus(raw);
    const cls = this.returnStatusClass(raw);
    return `<div class="badge ${cls}" title="Status da devolução (ML)">${this.esc(label)}</div>`;
  }
  humanReturnStatus(s){
    switch (s){
      case "label_generated":
      case "ready_to_ship":        return "Etiqueta pronta";
      case "pending":
      case "pending_cancel":
      case "pending_failure":
      case "pending_expiration":   return "Pendente";
      case "scheduled":            return "Agendada p/ retirada";
      case "shipped":              return "Devolução enviada";
      case "pending_delivered":    return "A caminho";
      case "delivered":            return "Recebida pelo vendedor";
      case "not_delivered":        return "Não entregue";
      case "return_to_buyer":      return "Retorno ao comprador";
      case "expired":              return "Expirada";
      case "failed":               return "Falhou";
      case "cancelled":
      case "canceled":             return "Cancelada";
      default:                     return s;
    }
  }
  returnStatusClass(s){
    if (/^delivered$/.test(s))          return "badge-aprovado";
    if (/^shipped$|pending_delivered$/.test(s)) return "badge-info";
    if (/^ready_to_ship$|label_generated$/.test(s)) return "badge-pendente";
    if (/^cancel/.test(s))              return "badge-rejeitado";
    if (/^not_delivered$|failed$/.test(s)) return "badge-rejeitado";
    if (/^scheduled$|return_to_buyer$/.test(s)) return "badge-info";
    if (/^expired$/.test(s))            return "badge-rejeitado";
    return "badge";
  }

  // ===== Card =====
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
          ${this.badgeReturnStatus(d)}
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
          <svg class="icone" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1a2.5 2.5 0 0 1 2.5 2.5V4h-5v-.5A2.5 2.5 0 0 1 8 1zm3.5 3v-.5a3.5 3.5 0  1 0-7 0V4H1v10a2 2 0  0 0 2 2h10a2 2 0  0 0 2-2V4h-3.5z"/></svg>
          <span class="campo-label">Produto</span>
          <span class="campo-valor valor-destaque">${this.formatBRL(valorProduto)}</span>
        </div>
        <div class="campo-info">
          <svg class="icone" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M0 3.5A1.5 1.5 0  0 1 1.5 2h9A1.5 1.5 0  0 1 12 3.5V5h1.02a1.5 1.5 0  0 1 1.17.563l1.481 1.85a1.5 1.5 0  0 1 .329.938V10.5a1.5 1.5 0  0 1-1.5 1.5H14a2 2 0  1 1-4 0H5a2 2 0  1 1-3.998-.085A1.5 1.5 0  0 1 0 10.5v-7z"/></svg>
          <span class="campo-label">Frete</span>
          <span class="campo-valor valor-destaque">${this.formatBRL(Number(d.valor_frete||0))}</span>
        </div>
      </div>

      <div class="devolucao-footer">
        <a href="../devolucao-editar.html?id=${encodeURIComponent(d.id)}" class="link-sem-estilo" target="_blank" rel="noopener">
          <button class="botao botao-outline botao-detalhes" data-action="open">
            <svg class="icone" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M16 8s-3-5.5-8-5.5S0 8 0 8s3 5.5 8 5.5S16 8 16 8zM1.173 8a13.133 13.133 0  0 1 1.66-2.043C4.12 4.668 5.88 3.5 8 3.5c2.12 0  3.879 1.168 5.168 2.457A13.133 13.133 0  0 1 14.828 8c-.58.87-3.828 5-6.828 5S2.58 8.87 1.173 8z"/><path d="M8 5.5a2.5 2.5 0  1 0 0 5 2.5 2.5 0  0 0 0-5z"/></svg>
            Ver Detalhes
          </button>
        </a>
      </div>
    `;
    return el;
  }

  // ações
  abrirDetalhes(id){
    const modal=document.getElementById("modal-detalhe");
    if (modal && modal.showModal) modal.showModal();
    else this.toast("Info",`Abrindo detalhes da devolução #${id}`,"info");
  }
  exportar(){
    const cols=["id","id_venda","cliente_nome","loja_nome","sku","status","log_status","ml_return_status","valor_produto","valor_frete","created_at"];
    const linhas=[cols.join(",")].concat(this.items.map(d=>cols.map(c=>`"${String(d[c]??"").replace(/"/g,'""')}"`).join(",")));
    const blob=new Blob([linhas.join("\n")],{type:"text/csv;charset=utf-8"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a"); a.href=url; a.download="devolucoes.csv"; a.click();
    URL.revokeObjectURL(url);
    this.toast("Sucesso","Relatório exportado.","sucesso");
  }
  toast(titulo,descricao,_tipo="info"){
    const t=document.getElementById("toast"), ti=document.getElementById("toast-titulo"), de=document.getElementById("toast-descricao");
    if(!t||!ti||!de) return; ti.textContent=titulo; de.textContent=descricao; t.classList.add("show"); setTimeout(()=>t.classList.remove("show"),3000);
  }
}

if (document.readyState==="loading") document.addEventListener("DOMContentLoaded",()=>new DevolucoesFeed());
else new DevolucoesFeed();
