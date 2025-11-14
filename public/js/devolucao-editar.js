// /public/js/devolucao-editar.js — ML return-cost integrado + hidratação robusta (+nick)
(function () {
  // ===== Helpers =====
  var $  = function (id) { return document.getElementById(id); };
  var qs = new URLSearchParams(location.search);
  var returnId = qs.get('id') || qs.get('return_id') || (location.pathname.split('/').pop() || '').replace(/\D+/g,'');

  // ---- DOM helpers (fallbacks para diferenças no HTML) ----
  function pickEl(sel) {
    if (!sel) return null;
    if (sel[0] === '#' || sel[0] === '.' || /\[.+\]/.test(sel)) return document.querySelector(sel);
    return $(sel);
  }
  function getFirst(selectors) {
    for (var i=0;i<selectors.length;i++) {
      var el = pickEl(selectors[i]);
      if (el) return el;
    }
    return null;
  }
  function setFirst(selectors, value, opts) {
    var el = getFirst(selectors); if (!el) return false;
    if ('value' in el) {
      if (el.dataset && el.dataset.dirty === '1') return false; // não pisa em edição
      var v = (value == null ? '' : String(value));
      if (opts && opts.upper) v = v.toUpperCase();
      el.value = v;
    } else {
      el.textContent = (value == null ? '' : String(value));
    }
    return true;
  }
  function readFirst(selectors, toNumFlag) {
    var el = getFirst(selectors); if (!el) return null;
    var v = ('value' in el) ? el.value : el.textContent;
    return toNumFlag ? toNum(v) : (v == null ? null : String(v).trim());
  }
  function bindDirty(el){
    if (!el || el.__dirtyBound) return;
    el.addEventListener('input', function(){ el.dataset.dirty = '1'; });
    el.__dirtyBound = true;
  }

  function getMotivoSelect() {
    return $('tipo_reclamacao')
        || $('motivo')
        || document.querySelector('#tipo_reclamacao, #motivo, select[name="tipo_reclamacao"], select[name="motivo"]');
  }

  function toNum(v) {
    if (v === null || v === undefined || v === '') return 0;
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    v = String(v).trim().replace(/[^\d.,-]/g, '');
    var parts = v.split(',');
    if (parts.length > 2) v = v.replace(/\./g, '');
    else if (v.indexOf(',') >= 0) v = v.replace(/\./g, '');
    v = v.replace(',', '.');
    var n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  }
  function moneyBRL(v){ return Number(v || 0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'}); }
  function moneyUSD(v){ return Number(v || 0).toLocaleString('en-US',{style:'currency',currency:'USD'}); }
  function toast(msg, type){
    type = type || 'info';
    var t = $('toast'); if (!t) { try{ console.warn('[toast]', type, msg);}catch(_){alert(msg);} return; }
    t.className = 'toast ' + type; t.textContent = msg;
    requestAnimationFrame(function(){ t.classList.add('show'); setTimeout(function(){ t.classList.remove('show'); }, 3000); });
  }
  function setAutoHint(txt){ var el=$('auto-hint'); if(el) el.textContent = txt || ''; }

  // ====== "Sticky fields" ======
  function setSafe(el, value, opts){
    if (!el) return;
    if (el.dataset && el.dataset.dirty === '1') return; // não sobrescreve o que o usuário digitou
    if (value === null || value === undefined || String(value).trim() === '') return;
    var v = String(value).trim();
    if (opts && opts.upper) v = v.toUpperCase();
    el.value = v;
  }
  function upperSKUInstant(){
    var s = getFirst(['#sku','input[name="sku"]','.js-sku']);
    if (!s) return;
    bindDirty(s);
    s.addEventListener('input', function(){
      var cur = s.selectionStart;
      s.value = s.value.toUpperCase();
      try { s.setSelectionRange(cur, cur); } catch(_){}
    });
  }

  function getLogPillEl() { return $('pill-log') || $('log_status_pill'); }
  function setLogPill(text) {
    var el = getLogPillEl(); if (!el) return;
    var s = String(text || '').toLowerCase();
    var cls = 'pill -neutro';
    if (!text) cls = 'pill -neutro';
    else if (s.includes('pend') || s.includes('caminho')) cls = 'pill -pendente';
    else if (s.includes('aprov') || s.includes('recebido')) cls = 'pill -aprovado';
    else if (s.includes('rej') || s.includes('neg') || s.includes('reprov')) cls = 'pill -rejeitado';
    el.className = cls;
    el.textContent = text || '—';
  }
  function setCdInfo(opts){
    opts = opts || {};
    var receivedAt = opts.receivedAt || null;
    var responsavel = opts.responsavel || null;
    var pill=$('pill-cd'), resp=$('cd-resp'), when=$('cd-when'), sep=$('cd-sep');
    if (!pill) return;
    if (!receivedAt){
      pill.className = 'pill -neutro'; pill.textContent = 'Não recebido';
      if (resp) resp.hidden = true; if (when) when.hidden = true; if (sep) sep.hidden = true; return;
    }
    pill.className = 'pill -aprovado'; pill.textContent = 'Recebido no CD';
    if (resp) { resp.textContent = 'Resp.: ' + (responsavel || 'cd'); resp.hidden = false; }
    if (when) {
      var dt = new Date(receivedAt);
      when.textContent = 'Quando: ' + (isNaN(dt) ? receivedAt : dt.toLocaleString('pt-BR')); when.hidden = false;
    }
    if (sep) sep.hidden = false;
  }

  // ===== Regras de cálculo (frente) =====
  function calcTotalByRules(d){
    var st = String(d.status || '').toLowerCase();
    var mot= String(d.tipo_reclamacao || d.reclamacao || '').toLowerCase();
    var lgs= String(d.log_status || '').toLowerCase();
    var vp = Number(d.valor_produto || 0);
    var vf = Number(d.valor_frete || 0);
    if (st.includes('rej') || st.includes('neg')) return 0;
    if (mot.includes('arrependimento') || mot === 'arrependimento_cliente') return 0;
    if (lgs === 'recebido_cd' || lgs === 'em_inspecao') return vf;
    return vp + vf;
  }

  // ===== Normalização de payload =====
  function siteIdToName(siteId){ var map={MLB:'Mercado Livre', MLA:'Mercado Livre', MLM:'Mercado Libre', MCO:'Mercado Libre', MPE:'Mercado Libre', MLC:'Mercado Libre', MLU:'Mercado Libre'}; return map[siteId] || 'Mercado Livre'; }
  function firstNonEmpty(){ for (var i=0;i<arguments.length;i++){ var v=arguments[i]; if(v!==undefined && v!==null && String(v).trim()!=='') return v; } return null; }
  function findWarehouseReceivedAt(j){
    try {
      var sh = j.shipments || j.shipping || [];
      for (var i=0;i<sh.length;i++){
        var s = sh[i] || {};
        var dest = (s.destination && s.destination.name) || '';
        if (String(dest).toLowerCase() === 'warehouse' && (s.status === 'delivered' || s.status === 'not_delivered')) {
          return s.date_delivered || s.last_updated || j.last_updated || null;
        }
      }
    } catch(e){}
    return null;
  }

  function normalize(j){
    var sellerName =
      (j.seller && (j.seller.nickname || j.seller.name || j.seller.nick_name)) ||
      j.seller_nickname || j.sellerNick || j.seller_nick || j.nickname ||
      j.seller_name || j.store_name || j.shop_name || null;

    var buyerName  =
      (j.buyer && (
        (j.buyer.first_name && j.buyer.last_name ? (j.buyer.first_name + ' ' + j.buyer.last_name) : (j.buyer.name || j.buyer.first_name)) ||
        j.buyer.nickname
      )) ||
      (j.shipping && j.shipping.receiver_address && j.shipping.receiver_address.receiver_name) ||
      j.cliente || j.cliente_nome || j.buyer_name || null;

    var dataCompra = firstNonEmpty(j.data_compra, j.order_date, j.date_created, j.paid_at, j.created_at);
    var motivo     = firstNonEmpty(j.tipo_reclamacao, j.reclamacao, j.reason_name, j.reason, j.reason_id, j.motivo, j.motivo_cliente);
    var logAtual   = firstNonEmpty(j.log_status, j.log, j.current_log, j.log_atual, j.status_log, j.status);

    var lojaNome   = firstNonEmpty(
      j.loja_nome, j.loja, sellerName, j.store_nickname, j.store_nick, j.seller_nickname, j.nickname,
      (j.site_id ? siteIdToName(j.site_id) : null)
    );

    var recebCdEm  = firstNonEmpty(j.cd_recebido_em, j.recebido_em, j.warehouse_received_at, findWarehouseReceivedAt(j));
    var recebResp  = firstNonEmpty(j.cd_responsavel, j.warehouse_responsavel, j.recebido_por);

    var totals = j.totals || j.amounts || j.summary || {};
    var vpFromTotals = firstNonEmpty(totals.product, totals.products, totals.items, totals.item_total, totals.valor_produto, totals.valor_produtos, totals.produto, totals.subtotal_items);
    var vfFromTotals = firstNonEmpty(totals.freight, totals.frete, totals.shipping, totals.shipping_cost, totals.logistics, totals.logistic_cost);

    var vpRaw = firstNonEmpty(
      j.valor_produto, j.valor_produtos, j.valor_item, j.produto_valor, j.valor, j.valor_total, j.total_produto,
      j.product_value, j.item_value, j.price, j.unit_price, j.amount_item, j.item_amount, j.amount, j.subtotal,
      j.refund_value, j.refund_amount, vpFromTotals
    );
    var vfRaw = firstNonEmpty(
      j.valor_frete, j.frete, j.shipping_value, j.shipping_cost, j.valor_envio, j.valorFrete, j.custo_envio,
      j.frete_valor, j.logistics_cost, j.logistic_cost, j.shipping_amount, j.amount_shipping, vfFromTotals
    );

    return {
      raw: j,
      id:           firstNonEmpty(j.id, j.return_id, j._id),
      id_venda:     firstNonEmpty(j.id_venda, j.order_id, j.resource_id, j.mco_order_id),
      cliente_nome: buyerName,
      loja_nome:    lojaNome,
      data_compra:  dataCompra,
      status:       firstNonEmpty(j.status, j.situacao),
      sku:          firstNonEmpty(j.sku, j.item_sku, j.item_id),
      tipo_reclamacao: motivo,
      nfe_numero:   firstNonEmpty(j.nfe_numero, j.invoice_number),
      nfe_chave:    firstNonEmpty(j.nfe_chave, j.invoice_key),
      reclamacao:   firstNonEmpty(j.reclamacao, j.obs, j.observacoes, j.observacao),
      valor_produto: toNum(vpRaw),
      valor_frete:   toNum(vfRaw),
      log_status:    logAtual,
      cd_recebido_em: receivedAtFrom(j),
      cd_responsavel: recebResp
    };
    function receivedAtFrom(_j){ return recebCdEm; }
  }

  var current = {};

  // ==== Seller nick helper (usa loja_nome ou label do resumo)
  function sellerNick(){
    var ln = (current && current.loja_nome) ? String(current.loja_nome) : '';
    if (ln.includes('·')) ln = ln.split('·')[1];
    ln = (ln || '').trim();
    if (!ln) {
      var el = $('ml-nick-display');
      if (el) ln = String(el.textContent || '').replace(/^Mercado Livre\s*·\s*/,'').trim();
    }
    return ln || null;
  }

  function updateSummary(d){
    var rs=$('resumo-status'), rl=$('resumo-log'), rc=$('resumo-cd'), rp=$('resumo-prod'), rf=$('resumo-frete'), rt=$('resumo-total');
    if (rs) rs.textContent = (d.status || '—').toLowerCase();
    if (rl) rl.textContent = (d.log_status || '—').toLowerCase();
    if (rc) rc.textContent = d.cd_recebido_em ? 'recebido' : 'não recebido';
    if (rp) rp.textContent = moneyBRL(d.valor_produto || 0);
    if (rf) rp && (rf.textContent = moneyBRL(d.valor_frete || 0));
    if (rt) rt.textContent = moneyBRL(calcTotalByRules(d));
  }

  function capture(){
    var selMot = getMotivoSelect();
    return {
      id_venda:        readFirst(['#id_venda','input[name="id_venda"]','.js-order-id']),
      cliente_nome:    readFirst(['#cliente_nome','#cliente','input[name="cliente_nome"]','.js-cliente','.js-cliente-nome']),
      loja_nome:       readFirst(['#loja_nome','input[name="loja_nome"]','.js-loja']),
      data_compra:     readFirst(['#data_compra','input[name="data_compra"]','.js-data']),
      status:          readFirst(['#status','select[name="status"]']),
      sku:             (readFirst(['#sku','input[name="sku"]','.js-sku']) || '').toUpperCase(),
      tipo_reclamacao: selMot ? selMot.value : null,
      nfe_numero:      readFirst(['#nfe_numero','input[name="nfe_numero"]']),
      nfe_chave:       readFirst(['#nfe_chave','input[name="nfe_chave"]']),
      reclamacao:      readFirst(['#reclamacao','textarea[name="reclamacao"]']),
      valor_produto:   readFirst(['#valor_produto','#produto_valor','input[name="valor_produto"]','.js-valor-produto'], true),
      valor_frete:     readFirst(['#valor_frete','#frete_valor','input[name="valor_frete"]','.js-valor-frete'], true),
      log_status:      current.log_status || null,
      cd_recebido_em:  current.cd_recebido_em || null
    };
  }

  function recalc(){
    var d = capture();
    setFirst(['#ml-product-sum','.js-ml-produto'], moneyBRL(d.valor_produto));
    setFirst(['#ml-freight','.js-ml-frete'], moneyBRL(d.valor_frete));
    setFirst(['#valor_total','input[name="valor_total"]','.js-total'], moneyBRL(calcTotalByRules(d)));
    updateSummary(Object.assign({}, current, d));
  }

  // ===== Motivo (select) — normalização =====
  function stripAcc(s){ try { return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,''); } catch(_) { return String(s||''); } }
  function norm(s){
    s = stripAcc(String(s||'').toLowerCase());
    s = s.replace(/[_\-]+/g,' ');
    s = s.replace(/[^\w\s]/g,' ');
    return s.replace(/\s+/g,' ').trim();
  }

  var MOTIVO_CANON = {
    'produto defeituoso': 'produto_defeituoso',
    'produto danificado': 'produto_danificado',
    'nao corresponde a descricao': 'nao_corresponde',
    'não corresponde à descrição': 'nao_corresponde',
    'arrependimento do cliente': 'arrependimento_cliente',
    'entrega atrasada': 'entrega_atrasada'
  };
  var CANON_LABELS = {
    produto_defeituoso: ['produto defeituoso','defeituoso','não funciona','nao funciona','not working','broken'],
    produto_danificado: ['produto danificado','danificado','avariado'],
    nao_corresponde: ['não corresponde à descrição','nao corresponde a descricao','produto diferente do anunciado','item errado','produto trocado','incompleto','faltam partes','faltando peças','faltam peças','faltam partes ou acessórios do produto','faltam acessórios','faltam pecas ou acessorios'],
    arrependimento_cliente: ['arrependimento do cliente','mudou de ideia','não quer mais','nao quer mais','não serviu','nao serviu'],
    entrega_atrasada: ['entrega atrasada','não entregue','nao entregue','not delivered','shipment delayed']
  };
  var REASONKEY_TO_CANON = {
    product_defective:'produto_defeituoso',not_working:'produto_defeituoso',broken:'produto_defeituoso',
    damaged:'produto_danificado',damaged_in_transit:'produto_danificado',
    different_from_publication:'nao_corresponde',not_as_described:'nao_corresponde',wrong_item:'nao_corresponde',different_from_listing:'nao_corresponde',different_from_ad:'nao_corresponde',different_item:'nao_corresponde',missing_parts:'nao_corresponde',parts_missing:'nao_corresponde',incomplete:'nao_corresponde',incomplete_product:'nao_corresponde',
    buyer_remorse:'arrependimento_cliente',changed_mind:'arrependimento_cliente',change_of_mind:'arrependimento_cliente',buyer_changed_mind:'arrependimento_cliente',doesnt_fit:'arrependimento_cliente',size_issue:'arrependimento_cliente',buyer_doesnt_want:'arrependimento_cliente',doesnt_want:'arrependimento_cliente',buyer_no_longer_wants:'arrependimento_cliente',no_longer_wants:'arrependimento_cliente',no_longer_needed:'arrependimento_cliente',not_needed_anymore:'arrependimento_cliente',not_needed:'arrependimento_cliente',unwanted:'arrependimento_cliente',repentant_buyer:'arrependimento_cliente',
    not_delivered:'entrega_atrasada',shipment_delayed:'entrega_atrasada'
  };
  var REASONNAME_TO_CANON = {
    repentant_buyer:'arrependimento_cliente',defective:'produto_defeituoso',damaged:'produto_danificado',
    not_working:'produto_defeituoso',different_from_publication:'nao_corresponde',not_as_described:'nao_corresponde',
    wrong_item:'nao_corresponde',missing_parts:'nao_corresponde',incomplete:'nao_corresponde',
    undelivered:'entrega_atrasada',not_delivered:'entrega_atrasada'
  };
  function canonFromCode(code){
    var c = String(code||'').toUpperCase();
    if (!c) return null;
    var SPEC = { PDD9939:'arrependimento_cliente', PDD9904:'produto_defeituoso', PDD9905:'produto_danificado', PDD9906:'arrependimento_cliente', PDD9907:'entrega_atrasada', PDD9944:'produto_defeituoso' };
    if (SPEC[c]) return SPEC[c];
    if (c === 'PNR') return 'entrega_atrasada';
    if (c === 'CS')  return 'arrependimento_cliente';
    return null;
  }
  function canonFromText(text){
    var t = norm(text);
    if (!t) return null;
    if (/faltam\s+partes\s+ou\s+acess[oó]rios\s+do\s+produto/.test(t)) return 'nao_corresponde';
    if (/(nao\s*(o\s*)?quer\s*mais|não\s*(o\s*)?quer\s*mais|nao\s*quero\s*mais|não\s*quero\s*mais|mudou\s*de\s*ideia|changed\s*mind|buyer\s*remorse|repentant|no\s*longer\s*wants?|no\s*longer\s*need(?:ed)?|doesn.?t\s*want)/.test(t)) return 'arrependimento_cliente';
    if (/(nao\s*serv|não\s*serv|tamanho|size|doesn.?t\s*fit|size\s*issue)/.test(t)) return 'arrependimento_cliente';
    if (/(defeit|nao\s*funciona|não\s*funciona|not\s*working|doesn.?t\s*work|broken|quebrad|queimad|parad)/.test(t)) return 'produto_defeituoso';
    if (/(danific|avariad|amassad|shipping\s*damage|carrier\s*damage|in\s*transit)/.test(t)) return 'produto_danificado';
    if (/(diferent[ea]|anunciad|publicad|descri[cç][aã]o|nao\s*correspond|não\s*correspond|wrong\s*item|not\s*as\s*described|different\s*from\s*(?:publication|ad|listing)|trocad|produto\s*errad|item\s*errad|modelo\s*diferent|tamanho\s*diferent|cor\s*diferent|incomplet[oa]|falt(?:a|am)\s*(?:pecas|pe[cç]as|partes|acess[oó]rios)|sem\s*(?:pecas|pe[cç]as|partes|acess[oó]rios)|faltando)/.test(t)) return 'nao_corresponde';
    if (/(nao\s*entreg|não\s*entreg|delayed|not\s*delivered|undelivered|shipment\s*delay)/.test(t)) return 'entrega_atrasada';
    var fromDict = MOTIVO_CANON[t]; if (fromDict) return fromDict;
    return null;
  }
  function canonFromReasonDetails(info){
    try{
      var name = String((info && info.name) || '').toLowerCase();
      var detail = String((info && info.detail) || '').toLowerCase();
      var tri = ((info && info.settings && info.settings.rules_engine_triage) || []).map(function(s){return String(s).toLowerCase();});
      if (tri.includes('repentant')) return 'arrependimento_cliente';
      if (tri.includes('defective') || tri.includes('not_working')) return 'produto_defeituoso';
      if (tri.includes('different') || tri.includes('incomplete')) return 'nao_corresponde';
      if (REASONKEY_TO_CANON[name]) return REASONKEY_TO_CANON[name];
      if (REASONNAME_TO_CANON[name]) return REASONNAME_TO_CANON[name];
      return canonFromText(name + ' ' + detail);
    }catch(_){ return null; }
  }
  function fetchJsonOk(url){
    return fetch(url, { headers: { 'Accept':'application/json' } })
      .then(function(r){ return r.ok ? r.json() : Promise.reject(new Error('HTTP '+r.status)); });
  }
  function fetchReasonCanonById(reasonId){
    if (!reasonId) return Promise.resolve(null);
    var rid = encodeURIComponent(reasonId);
    var candidates = ['/api/ml/claims/reasons/' + rid, '/api/ml/reasons/' + rid, '/api/ml/claim-reasons/' + rid];
    var idx = 0;
    function next(){
      if (idx >= candidates.length) return Promise.resolve(null);
      var url = candidates[idx++]; 
      return fetchJsonOk(url).then(function(info){
        var obj = (info && (info.data || info)) || info;
        var canon = canonFromReasonDetails(obj);
        return (canon ? canon : next());
      }).catch(next);
    }
    return next();
  }
  function setMotivoCanon(canon, lock){
    var sel = getMotivoSelect(); if (!sel || !canon) return false;
    for (var i=0;i<sel.options.length;i++){
      if (sel.options[i].value === canon) {
        sel.value = canon; sel.dispatchEvent(new Event('change'));
        if (lock) lockMotivo(true,'(ML)'); return true;
      }
    }
    var wanted = (CANON_LABELS[canon] || []).map(norm);
    for (var j=0;j<sel.options.length;j++){
      var opt = sel.options[j];
      var labelN = norm(opt.text || opt.label || '');
      if (labelN && (labelN === norm(canon) || wanted.indexOf(labelN) >= 0)) {
        sel.value = opt.value; sel.dispatchEvent(new Event('change'));
        if (lock) lockMotivo(true,'(ML)'); return true;
      }
    }
    return false;
  }
  function lockMotivo(lock, hint){
    var sel = getMotivoSelect(); if (!sel) return;
    sel.disabled = !!lock;
    var id = 'motivo-hint';
    var hintEl = document.getElementById(id);
    if (lock) {
      if (!hintEl){
        hintEl = document.createElement('small');
        hintEl.id = id;
        hintEl.style.marginLeft = '8px';
        hintEl.style.opacity = '0.8';
        sel.insertAdjacentElement('afterend', hintEl);
      }
      hintEl.textContent = hint || '(automático)';
      hintEl.hidden = false;
    } else {
      if (hintEl) hintEl.hidden = true;
    }
  }
  function reasonCanonFromPayload(root){
    if (!root || typeof root !== 'object') return null;
    function scanProblem(obj){
      if (!obj || typeof obj !== 'object') return null;
      var cand =
        obj.problem || obj.problem_title || obj.problem_description || obj.problem_detail ||
        obj.sale_problem || obj.issue || obj.issue_title || obj.issue_description || obj.detail ||
        obj.problem_text || obj.sale && (obj.sale.problem || obj.sale.problem_description);
      if (cand){ var t = canonFromText(cand); if (t) return t; }
      return null;
    }
    if (root.reason_key && REASONKEY_TO_CANON[root.reason_key]) return REASONKEY_TO_CANON[root.reason_key];
    if (root.reason_name && REASONNAME_TO_CANON[root.reason_name]) return REASONNAME_TO_CANON[root.reason_name];
    if (root.reason_name) { var t = canonFromText(root.reason_name); if (t) return t; }
    if (root.reason_detail) { var td = canonFromText(root.reason_detail); if (td) return td; }
    if (root.reason_id) { var c = canonFromCode(root.reason_id); if (c) return c; }
    var pr = scanProblem(root); if (pr) return pr;
    var ord = root.order || root.order_info || root.sale || root.purchase || null;
    var pr2 = scanProblem(ord); if (pr2) return pr2;
    var cl = root.claim || root.ml_claim || null;
    if (cl){
      if (cl.reason_key && REASONKEY_TO_CANON[cl.reason_key]) return REASONKEY_TO_CANON[cl.reason_key];
      if (cl.reason_name && REASONNAME_TO_CANON[cl.reason_name]) return REASONNAME_TO_CANON[cl.reason_name];
      if (cl.reason_name) { var t2 = canonFromText(cl.reason_name); if (t2) return t2; }
      if (cl.reason_detail) { var t2d = canonFromText(cl.reason_detail); if (t2d) return t2d; }
      if (cl.reason_id) { var c2 = canonFromCode(cl.reason_id); if (c2) return c2; }
      if (cl.reason && (cl.reason.key || cl.reason.id || cl.reason.name || cl.reason.detail)){
        if (cl.reason.key && REASONKEY_TO_CANON[cl.reason.key]) return REASONKEY_TO_CANON[cl.reason.key];
        if (cl.reason.name && REASONNAME_TO_CANON[cl.reason.name]) return REASONNAME_TO_CANON[cl.reason.name];
        if (cl.reason.id)   { var c3 = canonFromCode(cl.reason.id); if (c3) return c3; }
        if (cl.reason.detail){ var t3 = canonFromText(cl.reason.detail); if (t3) return t3; }
        if (cl.reason.name) { var t4 = canonFromText(cl.reason.name);   if (t4) return t4; }
      }
      var pr3 = scanProblem(cl); if (pr3) return pr3;
    }
    var any = root.reason || root.substatus || root.sub_status || root.code || root.detail || null;
    if (any){
      var c4 = canonFromCode(any); if (c4) return c4;
      var t5 = canonFromText(any); if (t5) return t5;
    }
    return null;
  }

  function fill(d){
    var dvId=$('dv-id'); if (dvId) dvId.textContent = d.id ? ('#' + d.id) : '';

    // sticky + MAIÚSCULO p/ SKU
    [getFirst(['#cliente_nome','#cliente','input[name="cliente_nome"]','.js-cliente','.js-cliente-nome']),
     getFirst(['#loja_nome','input[name="loja_nome"]','.js-loja']),
     getFirst(['#id_venda','input[name="id_venda"]','.js-order-id']),
     getFirst(['#valor_produto','#produto_valor','input[name="valor_produto"]','.js-valor-produto']),
     getFirst(['#valor_frete','#frete_valor','input[name="valor_frete"]','.js-valor-frete'])
    ].forEach(bindDirty);
    upperSKUInstant();

    setFirst(['#id_venda','input[name="id_venda"]','.js-order-id'], d.id_venda);
    setFirst(['#cliente_nome','#cliente','input[name="cliente_nome"]','.js-cliente','.js-cliente-nome'], d.cliente_nome);
    setFirst(['#loja_nome','input[name="loja_nome"]','.js-loja'], d.loja_nome);
    var dataStr = d.data_compra ? String(d.data_compra).slice(0,10) : '';
    setFirst(['#data_compra','input[name="data_compra"]','.js-data'], dataStr);
    setFirst(['#status','select[name="status"]'], d.status);
    setFirst(['#sku','input[name="sku"]','.js-sku'], d.sku, { upper:true });

    setFirst(['#nfe_numero','input[name="nfe_numero"]'], d.nfe_numero || '');
    setFirst(['#nfe_chave','input[name="nfe_chave"]'],   d.nfe_chave  || '');
    setFirst(['#reclamacao','textarea[name="reclamacao"]'], d.reclamacao || '');
    setFirst(['#valor_produto','#produto_valor','input[name="valor_produto"]','.js-valor-produto'], (d.valor_produto == null ? '' : String(toNum(d.valor_produto))));
    setFirst(['#valor_frete','#frete_valor','input[name="valor_frete"]','.js-valor-frete'], (d.valor_frete == null ? '' : String(toNum(d.valor_frete))));

    var rawOrderId = firstNonEmpty(d.raw && d.raw.order_id, d.raw && d.raw.id_venda, d.id_venda);
    setFirst(['#order_id','input[name="order_id"]','.js-order-id-raw'], rawOrderId);
    var rawClaimId = firstNonEmpty(d.raw && (d.raw.ml_claim_id || d.raw.claim_id), d.raw && d.raw.claim && d.raw.claim.id);
    setFirst(['#ml_claim_id','input[name="ml_claim_id"]','.js-claim-id'], rawClaimId);

    var sel = getMotivoSelect();
    if (sel) {
      var mot = d.tipo_reclamacao || '';
      var wasSet = false;
      if (/_/.test(mot) || mot === 'nao_corresponde') wasSet = setMotivoCanon(mot, false);
      if (!wasSet && mot)         wasSet = setMotivoCanon(canonFromText(mot), false);
      if (!wasSet && d.reclamacao)wasSet = setMotivoCanon(canonFromText(d.reclamacao), false);
      if (!wasSet) lockMotivo(false);
    }

    setLogPill(d.log_status || '—');
    setCdInfo({ receivedAt: d.cd_recebido_em || null, responsavel: d.cd_responsavel || null });

    fillMlSummaryFromCurrent();
    if (d.raw && d.raw.claim) fillClaimUI(d.raw.claim);

    updateSummary(d); recalc();
  }

  // === ML summary UI (informativo) ===
  function fillMlSummary(payload){
    var order = payload && (payload.order || payload.order_info);
    var amounts = payload && payload.amounts;
    var retCost = payload && payload.return_cost;

    var ordId = (order && (order.id || order.order_id)) || readFirst(['#order_id','input[name="order_id"]','.js-order-id-raw']);
    setFirst(['#ml-order-display','.js-ml-order'], ordId || '—');
    var nick = (order && order.seller && (order.seller.nickname || order.seller.nick_name)) || null;
    setFirst(['#ml-nick-display','.js-ml-nick'], nick ? ('Mercado Livre · ' + nick) : (current.loja_nome || '—'));
    var dt = (order && (order.date_created || order.paid_at || order.created_at)) || current.data_compra || '';
    setFirst(['#ml-date-display','.js-ml-date'], dt ? new Date(dt).toLocaleDateString('pt-BR') : '—');

    var prodSum = null, freight = null;
    if (amounts) {
      if ('product' in amounts) prodSum = toNum(amounts.product);
      if ('freight' in amounts) freight = toNum(amounts.freight);
      if ('shipping' in amounts) freight = toNum(amounts.shipping);
      if ('shipping_cost' in amounts) freight = toNum(amounts.shipping_cost);
    }
    if (retCost && retCost.amount != null) freight = toNum(retCost.amount);

    setFirst(['#ml-product-sum','.js-ml-produto'], prodSum != null ? moneyBRL(prodSum) : moneyBRL(current.valor_produto || 0));
    setFirst(['#ml-freight','.js-ml-frete'],     freight != null ? moneyBRL(freight) : moneyBRL(current.valor_frete || 0));

    var claimId = (payload && payload.sources && payload.sources.claim_id) || readFirst(['#ml_claim_id','input[name="ml_claim_id"]','.js-claim-id']);
    var a = $('claim-open-link'); if (a) { a.setAttribute('title', claimId ? ('Claim ID: ' + claimId) : 'Sem Claim ID'); a.href = '#'; }

    if ($('ml-return-cost')) {
      if (retCost && retCost.amount != null) { $('ml-return-cost').textContent = moneyBRL(retCost.amount); $('ml-return-cost').dataset.value = String(toNum(retCost.amount)); }
      else { $('ml-return-cost').textContent = '—'; $('ml-return-cost').dataset.value = ''; }
    }
    if ($('ml-return-cost-usd')) $('ml-return-cost-usd').textContent = (retCost && retCost.amount_usd != null) ? moneyUSD(retCost.amount_usd) : '—';
  }
  function fillMlSummaryFromCurrent(){
    fillMlSummary({ order: current.raw && (current.raw.order || current.raw.order_info) || null,
                    amounts: current.raw && current.raw.amounts || null,
                    return_cost: current.raw && current.raw.return_cost || null,
                    sources: { claim_id: (current.raw && (current.raw.ml_claim_id || current.raw.claim_id)) || null } });
  }

  // === Claim UI + Mediação/Status ML ===
  function setTxt(id, v){ var el=$(id); if (el) el.textContent = (v===undefined||v===null||v==='') ? '—' : String(v); }
  function clearList(id){ var el=$(id); if (el) el.innerHTML=''; }
  function pushLi(id, html){ var el=$(id); if (el){ var li=document.createElement('li'); li.innerHTML=html; el.appendChild(li);} }
  function setPillState(id, label, state){
    var el=$(id); if(!el) return;
    var map = { neutro:'-neutro', pendente:'-pendente', aprovado:'-aprovado', rejeitado:'-rejeitado' };
    el.className = 'pill ' + (map[state] || '-neutro');
    el.textContent = label;
  }

  function fillClaimUI(claim){
    if (!claim || typeof claim !== 'object') return;

    setTxt('claim-id',         claim.id);
    setTxt('claim-status',     claim.status);
    setTxt('claim-type',       claim.type);
    setTxt('claim-stage',      claim.stage || claim.stage_name);
    setTxt('claim-version',    claim.claim_version);
    setTxt('claim-reason',     claim.reason_id || (claim.reason && (claim.reason.id || claim.reason.name)) || claim.reason_name);
    setTxt('claim-fulfilled',  String(claim.fulfilled ?? '—'));
    setTxt('claim-qtytype',    claim.quantity_type);
    setTxt('claim-created',    claim.created_date ? new Date(claim.created_date).toLocaleString('pt-BR') : '—');
    setTxt('claim-updated',    claim.last_updated ? new Date(claim.last_updated).toLocaleString('pt-BR') : '—');
    setTxt('claim-resource',   claim.resource);
    setTxt('claim-resource-id',claim.resource_id);
    setTxt('claim-parent-id',  claim.parent_id);
    setTxt('claim-has-return', claim.return ? 'sim' : 'não');

    clearList('claim-players');
    var players = Array.isArray(claim.players) ? claim.players : [];
    players.forEach(function(p){
      var role = p.role || '-';
      var type = p.type || '-';
      var uid  = p.user_id || '-';
      pushLi('claim-players', `<b>${role}</b> • ${type} • #${uid}`);
    });

    clearList('claim-actions');
    var actions = Array.isArray(claim.available_actions) ? claim.available_actions : [];
    actions.forEach(function(a){
      var due = a.due_date ? (' · até ' + new Date(a.due_date).toLocaleString('pt-BR')) : '';
      pushLi('claim-actions', `<code>${a.action || '-'}</code>${a.mandatory ? ' (obrigatória)' : ''}${due}`);
    });

    var res = claim.resolution || {};
    setTxt('claim-res-reason',    res.reason || res.reason_id || res.reason_name);
    setTxt('claim-res-benefited', res.benefited);
    setTxt('claim-res-closed-by', res.closed_by);
    setTxt('claim-res-applied',   String(res.applied_coverage ?? '—'));
    setTxt('claim-res-date',      res.data_created ? new Date(res.data_created).toLocaleString('pt-BR') : '—');

    clearList('claim-related');
    var related = Array.isArray(claim.related_entities) ? claim.related_entities : [];
    related.forEach(function(r){ pushLi('claim-related', `<b>${r.type || '-'}</b> • ${r.id || '-'}`); });

    var prefer =
      reasonCanonFromPayload({ claim: claim }) ||
      canonFromCode(claim.reason_id);

    if (prefer) {
      setMotivoCanon(prefer, true);
    } else {
      var rid = claim.reason_id || (claim.reason && claim.reason.id) || null;
      if (rid) {
        fetchReasonCanonById(rid).then(function(canon){
          if (canon && setMotivoCanon(canon, true)) {
            var id = current.id || returnId;
            if (id) {
              fetch('/api/returns/' + encodeURIComponent(id), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tipo_reclamacao: canon, updated_by: 'frontend-reason-lookup' })
              }).catch(function(){});
            }
          }
        }).catch(function(){});
      }
    }

    try {
      var stage = (claim.stage || claim.stage_name || '').toString().toLowerCase();
      var status = (claim.status || '').toString().toLowerCase();
      var inMediation = stage.includes('mediation') || status.includes('mediation');
      setPillState('pill-mediacao', inMediation ? 'Em mediação' : 'Sem mediação', inMediation ? 'pendente' : 'neutro');

      var statusDesc =
        (claim.return && claim.return.status) ||
        (claim.return && claim.return.shipping && claim.return.shipping.status) ||
        status || '—';
      var human = String(statusDesc).replace(/_/g,' ');
      setTxt('ml-status-desc', human);
    } catch(_){}

    if (claim.id) {
      fetchAndApplyReturnCost(String(claim.id), { persist: true });
    }
  }

  function tryFetchClaimDetails(claimId){
    if (!claimId) return Promise.resolve();
    var q = sellerNick() ? ('?nick=' + encodeURIComponent(sellerNick())) : '';
    return fetch('/api/ml/claims/' + encodeURIComponent(claimId) + q, { headers: { 'Accept': 'application/json' } })
      .then(function(r){ if(!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function(j){ var c = j && (j.data || j.claim || j); if (c && typeof c==='object') fillClaimUI(c); })
      .catch(function(){ /* silencioso */ });
  }

  // ===== Return-cost (frete de devolução do ML)
  function showReturnCostInUi(data){
    if (!data) return;
    var brl = toNum(data.amount);
    var usd = (data.amount_usd != null) ? toNum(data.amount_usd) : null;
    var slotBrl = $('ml-return-cost');
    var slotUsd = $('ml-return-cost-usd');
    if (slotBrl) { slotBrl.textContent = moneyBRL(brl); slotBrl.dataset.value = String(brl); }
    if (slotUsd) { slotUsd.textContent = (usd != null ? moneyUSD(usd) : '—'); }
  }
  function applyReturnCostToFreight(brlAmount, opts){
    opts = opts || {};
    var inputFrete = getFirst(['#valor_frete','#frete_valor','input[name="valor_frete"]','.js-valor-frete']);
    var wasDirty = inputFrete && inputFrete.dataset.dirty === '1';
    var curFrete = inputFrete ? toNum(inputFrete.value) : toNum(current.valor_frete);
    if (!wasDirty && toNum(curFrete) === 0 && toNum(brlAmount) > 0) {
      if (inputFrete) { inputFrete.value = String(toNum(brlAmount)); }
      current.valor_frete = toNum(brlAmount);
      recalc();
      if (opts.persist && (current.id || returnId)) {
        fetch('/api/returns/' + encodeURIComponent(current.id || returnId), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ valor_frete: toNum(brlAmount), updated_by: 'frontend-ml-return-cost' })
        }).catch(function(){});
      }
      toast('Frete de devolução (ML) aplicado: ' + moneyBRL(brlAmount), 'success');
      return true;
    }
    return false;
  }
  function fetchAndApplyReturnCost(claimId, opts){
    opts = opts || {};
    var q = ['usd=true'];
    var nick = sellerNick(); if (nick) q.push('nick=' + encodeURIComponent(nick));
    var url = '/api/ml/claims/' + encodeURIComponent(claimId) + '/charges/return-cost?' + q.join('&');
    return fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function(r){ return r.json().then(function(j){ return { ok:r.ok, body:j }; }); })
      .then(function(res){
        if (!res.ok) { if (qs.has('debug')) console.warn('[return-cost] erro', res.body); return; }
        var data = (res.body && res.body.data) || res.body || {};
        showReturnCostInUi(data);
        applyReturnCostToFreight(toNum(data.amount), { persist: opts.persist });
      })
      .catch(function(){});
  }

  // Debug opcional (?debug=1)
  function showDebug(raw, normd){
    if (!qs.has('debug')) return;
    var pre = document.createElement('details');
    pre.open = true; pre.style.margin = '12px 0';
    pre.innerHTML = '<summary style="cursor:pointer">Debug: payload recebido / normalizado</summary>' +
      '<pre style="white-space:pre-wrap;font-size:12px;background:#f7f7f8;border:1px solid #e6e6eb;padding:10px;border-radius:8px;overflow:auto;max-height:320px"></pre>';
    var main = document.querySelector('.page-wrap');
    if (main) main.insertBefore(pre, main.firstChild);
    try { pre.querySelector('pre').textContent = JSON.stringify({raw: raw, normalized: normd}, null, 2); } catch(e){}
  }
  function normalizeAndSet(j){ var n = normalize(j); current = n; try{ console.debug('[devolucao-editar] raw->norm', j, n);}catch(e){} fill(n); showDebug(j,n); }

  // ===== API =====
  function safeJson(res){ if (!res.ok) return Promise.reject(new Error('HTTP ' + res.status)); if (res.status === 204) return {}; return res.json(); }
  function reloadCurrent(){
    if (!returnId) return Promise.resolve();
    return fetch('/api/returns/' + encodeURIComponent(returnId), { headers: { 'Accept': 'application/json' } })
      .then(safeJson)
      .then(function (j) { var data = (j && (j.data || j.item || j.return || j)) || j || {}; normalizeAndSet(data); });
  }

  // ===== Save handler =====
  function save(){
    var body = capture();
    var id = current.id || returnId;
    if (!id) { toast('ID inválido.', 'error'); return; }
    fetch('/api/returns/' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(Object.assign({}, body, { updated_by: 'frontend' }))
    })
    .then(function (r) {
      if(!r.ok) return r.json().catch(function(){}).then(function(e){ throw new Error((e && e.error) || 'Falha ao salvar'); });
    })
    .then(function(){ return reloadCurrent(); })
    .then(function(){ toast('Salvo!', 'success'); return refreshTimeline(id); })
    .catch(function(e){ toast(e.message || 'Erro ao salvar', 'error'); });
  }

  // ===== Recebimento no CD =====
  function runReceive(responsavel, whenIso){
    var id = current.id || returnId;
    if (!id) return;
    var when = whenIso || new Date().toISOString();
    disableHead(true);
    return fetch('/api/returns/' + encodeURIComponent(id) + '/cd/receive', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'receive-' + id + '-' + when },
      body: JSON.stringify({ responsavel: responsavel || '', when: when, updated_by: 'frontend' })
    })
    .then(function(r){ if(!r.ok) return r.json().catch(function(){}) .then(function(e){ throw new Error((e && e.error) || 'Falha ao marcar recebido');}); })
    .then(function(){ return reloadCurrent(); })
    .then(function(){ toast('Recebido no CD registrado!', 'success'); return refreshTimeline(id); })
    .catch(function(e){ toast(e.message || 'Erro ao marcar recebido', 'error'); })
    .then(function(){ disableHead(false); });
  }

  function openReceiveDialog(){
    var dlg     = $('dlg-recebido') || $('dlg-receber');
    if (dlg && (dlg.showModal || dlg.removeAttribute)) {
      var inputNome   = $('rcd-resp') || $('rcv-name');
      var inputQuando = $('rcd-when') || $('rcv-when');
      var btnNo       = $('rcd-cancel') || $('rcv-cancel');
      var form        = $('rcd-form')   || $('rcv-form');

      if (inputNome) inputNome.value = '';
      if (inputQuando){
        var tzFix = new Date(Date.now() - new Date().getTimezoneOffset()*60000).toISOString().slice(0,16);
        inputQuando.value = tzFix;
      }

      function submit(ev){
        ev && ev.preventDefault();
        var nome = (inputNome && inputNome.value || '').trim();
        var whenLocal = inputQuando && inputQuando.value;
        if (dlg.close) dlg.close(); else dlg.setAttribute('hidden','');
        runReceive(nome, whenLocal ? new Date(whenLocal).toISOString() : null);
        cleanup();
      }
      function cancel(){
        if (dlg.close) dlg.close(); else dlg.setAttribute('hidden','');
        cleanup();
      }
      function cleanup(){
        if (form)  form.removeEventListener('submit', submit);
        if (btnNo) btnNo.removeEventListener('click', cancel);
      }
      if (form)  form.addEventListener('submit', submit);
      if (btnNo) btnNo.addEventListener('click', cancel);

      if (dlg.showModal) dlg.showModal(); else dlg.removeAttribute('hidden');
      setTimeout(function(){ inputNome && inputNome.focus(); }, 0);
      return;
    }
    var nome = prompt('Quem recebeu no CD? (nome/assinatura)');
    if (nome !== null) runReceive(String(nome).trim());
  }

  // ===== Inspeção =====
  function openInspectDialog(targetStatus){
    var dlg = $('dlg-inspecao'); if (!dlg) return performInspectFallback(targetStatus, '');
    var sub = $('insp-sub'), txt = $('insp-text');
    var btnCancel = $('insp-cancel'), form = $('insp-form');

    if (sub) sub.textContent = targetStatus === 'aprovado' ? 'Você vai APROVAR a inspeção.' : 'Você vai REPROVAR a inspeção.';
    if (txt) txt.value = '';

    function submit(ev){
      ev && ev.preventDefault();
      var note = (txt && txt.value || '').trim();
      if (dlg.close) dlg.close();
      performInspect(targetStatus, note);
      cleanup();
    }
    function cancel(){ if (dlg.close) dlg.close(); cleanup(); }
    function cleanup(){ if (form) form.removeEventListener('submit', submit); if (btnCancel) btnCancel.removeEventListener('click', cancel); }

    if (form) form.addEventListener('submit', submit);
    if (btnCancel) btnCancel.addEventListener('click', cancel);
    if (dlg.showModal) dlg.showModal(); else dlg.removeAttribute('hidden');
  }
  function performInspectFallback(targetStatus, note){
    var id = current.id || returnId;
    if (!id) return;
    var log = (targetStatus === 'aprovado') ? 'aprovado_cd' : 'reprovado_cd';
    disableHead(true);
    return fetch('/api/returns/' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ log_status: log, insp_note: note, updated_by: 'frontend-inspecao' })
    })
    .then(function(r){ if(!r.ok) throw new Error('Falha ao atualizar inspeção'); })
    .then(function(){ return reloadCurrent(); })
    .then(function(){ toast('Inspeção registrada.', 'success'); return refreshTimeline(id); })
    .catch(function(e){ toast(e.message || 'Erro ao registrar inspeção', 'error'); })
    .then(function(){ disableHead(false); });
  }
  function performInspect(targetStatus, note){
    var id = current.id || returnId; if (!id) return;
    disableHead(true);
    return fetch('/api/returns/' + encodeURIComponent(id) + '/cd/inspect', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: (targetStatus === 'aprovado' ? 'approve' : 'reject'), note: note || '', updated_by: 'frontend-inspecao' })
    })
    .then(function(r){ if (r.ok) return; return performInspectFallback(targetStatus, note); })
    .then(function(){ return reloadCurrent(); })
    .then(function(){ toast('Inspeção registrada.', 'success'); return refreshTimeline(id); })
    .catch(function(){})
    .then(function(){ disableHead(false); });
  }

  // ===== ENRIQUECIMENTO (ML)
  var ENRICH_TTL_MS = 10 * 60 * 1000;
  function lojaEhML(nome){ var s=String(nome||'').toLowerCase(); return s.indexOf('mercado')>=0 || s.indexOf('meli')>=0 || s.indexOf('ml')>=0; }
  function parecePedidoML(pedido){ return /^\d{6,}$/.test(String(pedido || '')); }
  function needsEnrichment(d){
    var faltamValores = !d || toNum(d.valor_produto) === 0 || toNum(d.valor_frete) === 0;
    var faltamMetadados = !d || !d.id_venda || !d.cliente_nome || !d.loja_nome || !d.data_compra;
    return faltamValores || faltamMetadados;
  }
  function canEnrichNow(){ var key='rf_enrich_'+returnId; var last=Number(localStorage.getItem(key) || 0); var ok=!last || (Date.now()-last)>ENRICH_TTL_MS; if(ok) localStorage.setItem(key,String(Date.now())); return ok; }

  function pickSkuFromOrder(ord){
    if (!ord) return null;
    var arr = ord.order_items || ord.items || [];
    var first = arr[0] || {};
    var it = first.item || first;
    var sku = (first.seller_sku || first.variation_sku || it.seller_sku || it.sku || it.id || null);
    return sku ? String(sku).toUpperCase() : null;
  }
  function applyIfEmpty(acc, field, value){
    if (value == null || value === '') return acc;
    var cur=current[field];
    if (cur == null || String(cur).trim() === '') acc[field] = (field==='sku' ? String(value).toUpperCase() : value);
    return acc;
  }

  function persistMetaPatch(patch){
    var idp = current.id || returnId;
    if (!idp || !Object.keys(patch).length) return Promise.resolve();
    return fetch('/api/returns/' + encodeURIComponent(idp), {
      method: 'PATCH',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify(Object.assign({}, patch, { updated_by:'frontend-auto-enrich-meta' }))}
    ).catch(function(){});
  }

  function enrichFromML(reason){
    reason = reason || 'auto';
    if (!current || !current.id) return Promise.resolve(false);

    disableHead(true);
    setAutoHint('(buscando valores no ML…)');

    var id = current.id;

    var typedOrderId = readFirst(['#id_venda','input[name="id_venda"]','.js-order-id']);
    var typedClaimId = readFirst(['#ml_claim_id','input[name="ml_claim_id"]','.js-claim-id']);
    var params = [];
    if (typedOrderId) params.push('order_id=' + encodeURIComponent(typedOrderId));
    if (typedClaimId) params.push('claim_id=' + encodeURIComponent(typedClaimId));
    var nk = sellerNick(); if (nk) params.push('nick=' + encodeURIComponent(nk));
    var qsOverride = params.length ? ('?' + params.join('&')) : '';

    var previewUrl = '/api/ml/returns/' + encodeURIComponent(id) + '/fetch-amounts' + qsOverride;
    var persistUrl = '/api/ml/returns/' + encodeURIComponent(id) + '/enrich' + (nk ? ('?nick=' + encodeURIComponent(nk)) : '');

    return fetch(previewUrl, { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.text().then(function (txt) { var j = {}; try { j = txt ? JSON.parse(txt) : {}; } catch (_e) {} if (!r.ok) { var err = new Error((j && (j.error || j.message)) || ('HTTP ' + r.status)); err.status = r.status; throw err; } return j; }); })
      .then(function (raw) {
        var j = raw && (raw.data || raw) || {};

        try { fillMlSummary(j); } catch(_){}

        function numFrom(obj, keys){
          if (!obj) return null;
          for (var i = 0; i < keys.length; i++){
            var k = keys[i];
            if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null && obj[k] !== '') return toNum(obj[k]);
          }
          return null;
        }
        var product = numFrom(j, ['product','product_amount','amount_product','items_total','item_total','subtotal','total_items']);
        if (product === null) product = numFrom(j.amounts || {}, ['product','items','item_total','amount_product']);
        if (product === null) product = numFrom(j.order   || {}, ['items_total','subtotal','product','amount_product']);

        var freight = numFrom(j, ['freight','shipping','shipping_cost','amount_shipping','return_cost','return_amount']);
        if (freight === null) freight = numFrom((j.return_cost || {}), ['amount','value']);
        if (freight === null) freight = numFrom(j.amounts || {}, ['freight','shipping','shipping_cost','logistics','logistic_cost']);

        var ip = getFirst(['#valor_produto','#produto_valor','input[name="valor_produto"]','.js-valor-produto']);
        var ifr = getFirst(['#valor_frete','#frete_valor','input[name="valor_frete"]','.js-valor-frete']);
        var changed = false;
        if (product !== null && toNum(product) !== toNum(current.valor_produto)) { current.valor_produto = toNum(product); if (ip)  ip.value  = String(current.valor_produto); changed = true; }
        if (freight !== null && toNum(freight) !== toNum(current.valor_frete))   { current.valor_frete   = toNum(freight); if (ifr) ifr.value = String(current.valor_frete);   changed = true; }

        if (changed) {
          recalc(); updateSummary(Object.assign({}, current, capture()));
          toast('Valores do ML ' + (reason === 'auto' ? '(auto) ' : '') + 'aplicados' +
               ((product !== null) ? ' · produto ' + moneyBRL(product) : '') +
               ((freight !== null) ? ' · frete '   + moneyBRL(freight) : ''), 'success');
        } else {
          toast('Valores do ML já estavam corretos.', 'info');
        }

        var ord = j.order || j.order_info || null;
        var patch = {};
        if (ord) {
          applyIfEmpty(patch, 'id_venda', ord.id || ord.order_id);
          var buyer =
            (ord.buyer && (
              (ord.buyer.first_name && ord.buyer.last_name ? (ord.buyer.first_name + ' ' + ord.buyer.last_name) : (ord.buyer.first_name || ord.buyer.name)) ||
              ord.buyer.nickname
            )) ||
            (ord.shipping && ord.shipping.receiver_address && ord.shipping.receiver_address.receiver_name);
          applyIfEmpty(patch, 'cliente_nome', buyer);

          var sellerNickVal = (ord.seller && (ord.seller.nickname || ord.seller.nick_name)) || ord.store_nickname || null;
          var lojaNome   = sellerNickVal ? ('Mercado Livre · ' + sellerNickVal) : (ord.site_id ? (siteIdToName(ord.site_id)) : null);
          applyIfEmpty(patch, 'loja_nome', lojaNome);

          var dt = ord.date_created || ord.paid_at || ord.created_at || null;
          applyIfEmpty(patch, 'data_compra', dt ? String(dt).slice(0, 10) : null);

          var sku = pickSkuFromOrder(ord);
          applyIfEmpty(patch, 'sku', sku);
        }

        var canon =
          reasonCanonFromPayload(j) ||
          (j.reason_key && REASONKEY_TO_CANON[j.reason_key]) ||
          canonFromCode(j.reason_code) ||
          canonFromText(j.reason_label);

        var persistPatch = Promise.resolve();
        function persistTipo(c){
          if (!c) return Promise.resolve();
          setMotivoCanon(c, true);
          return fetch('/api/returns/' + encodeURIComponent(current.id || returnId), {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tipo_reclamacao: c, updated_by: 'frontend-auto-enrich' })
          }).catch(function(){});
        }
        if (canon) {
          persistPatch = persistTipo(canon);
        } else {
          var rid =
            j.reason_id ||
            (j.claim && (j.claim.reason_id || (j.claim.reason && j.claim.reason.id))) ||
            null;
          if (rid) persistPatch = fetchReasonCanonById(rid).then(persistTipo);
        }

        var logHint = j.log_status_suggested || null;
        if (logHint) {
          var lsNow = String(current.log_status || '').toLowerCase();
          if (!lsNow || lsNow === 'nao_recebido' || lsNow === 'não_recebido') {
            current.log_status = logHint; setLogPill(logHint);
          }
        }

        if (Object.keys(patch).length) {
          setFirst(['#id_venda','input[name="id_venda"]','.js-order-id'], patch.id_venda);
          setFirst(['#cliente_nome','#cliente','input[name="cliente_nome"]','.js-cliente','.js-cliente-nome'], patch.cliente_nome);
          setFirst(['#loja_nome','input[name="loja_nome"]','.js-loja'], patch.loja_nome);
          setFirst(['#data_compra','input[name="data_compra"]','.js-data'], patch.data_compra);
          setFirst(['#sku','input[name="sku"]','.js-sku'], patch.sku, { upper:true });
          current = Object.assign({}, current, patch);
          recalc();
        }

        var persistMeta = persistMetaPatch(patch);
        var persistEvent = fetch(persistUrl, { method: 'POST' }).catch(function(){});
        var amountsPatch = {};
        if (product !== null) amountsPatch.valor_produto = toNum(product);
        if (freight !== null) amountsPatch.valor_frete   = toNum(freight);

        var persistMoney = Promise.resolve();
        if (Object.keys(amountsPatch).length || logHint) {
          var body = Object.assign({}, amountsPatch, (logHint ? { log_status: current.log_status } : {}), { updated_by: 'frontend-auto-enrich' });
          persistMoney = fetch('/api/returns/' + encodeURIComponent(current.id || returnId), {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
          }).catch(function(){});
        }

        if (j.claim) fillClaimUI(j.claim);
        var claimed = (j.sources && j.sources.claim_id) || null;
        if (!j.claim && claimed) tryFetchClaimDetails(claimed);

        var needReturnCost = !(j && j.return_cost && j.return_cost.amount != null);
        var claimId = claimed || (j.claim && j.claim.id) || readFirst(['#ml_claim_id','input[name="ml_claim_id"]','.js-claim-id']);
        var rcPull = needReturnCost && claimId ? fetchAndApplyReturnCost(String(claimId), { persist: true }) : Promise.resolve();

        return Promise.all([persistMeta, persistEvent, persistMoney, persistPatch, rcPull]);
      })
      .then(function(){ return reloadCurrent(); })
      .catch(function (e) {
        if (e && e.status === 404) toast('Sem dados do Mercado Livre para esta devolução.', 'warning');
        else toast(e.message || 'Não foi possível obter valores/dados do ML', 'error');
      })
      .then(function(){ setAutoHint(''); disableHead(false); });
  }

  // ===== TIMELINE =====
  function coerceEventsPayload(j){ if (Array.isArray(j)) return j; if (!j || typeof j !== 'object') return []; return j.items || j.events || j.data || []; }
  function fetchEvents(id, limit, offset){
    limit = limit || 100; offset = offset || 0;
    var url = '/api/returns/' + encodeURIComponent(id) + '/events?limit=' + limit + '&offset=' + offset;
    return fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function(r){ if(!r.ok) return []; return r.json(); })
      .then(function (j) { var arr = coerceEventsPayload(j); return Array.isArray(arr) ? arr : []; })
      .catch(function(){ return []; });
  }
  function fmtRel(iso){
    var d = new Date(iso); if (isNaN(d)) return '';
    var diffMs = Date.now() - d.getTime(); var abs = Math.abs(diffMs);
    var min = 60*1000, hr = 60*min, day = 24*hr;
    function s(n,u){ return n + ' ' + u + (n>1?'s':''); }
    if (abs < hr)  return s(Math.round(abs/min)||0,'min') + (diffMs>=0?' atrás':' depois');
    if (abs < day) return s(Math.round(abs/hr),'hora') + (diffMs>=0?'s atrás':'s depois');
    return d.toLocaleString('pt-BR');
  }
  function iconFor(type){ if (type==='status') return '🛈'; if (type==='note') return '📝'; if (type==='warn') return '⚠️'; if (type==='error') return '⛔'; return '•'; }

  function renderEvents(items){
    var wrap=$('events-list'), elLoad=$('events-loading'), elEmpty=$('events-empty');
    if (!wrap) return; wrap.innerHTML=''; if (elLoad) elLoad.hidden=true;
    if (!items.length){ if (elEmpty) elEmpty.hidden=false; return; } if (elEmpty) elEmpty.hidden=true;

    function reasonFromMeta(meta){
      if (!meta) return null;
      return meta.reason_name || meta.reason || meta.tipo_reclamacao ||
             (meta.claim && (meta.claim.reason_name || (meta.claim.reason && (meta.claim.reason.name || meta.claim.reason.description)))) || null;
    }

    var frag=document.createDocumentFragment();
    items.forEach(function (ev) {
      var type=String(ev.type || 'status').toLowerCase();
      var meta=ev.meta && typeof ev.meta === 'object' ? ev.meta : null;
      var item=document.createElement('article'); item.className='tl-item -'+type; item.setAttribute('role','article');

      var created=ev.createdAt || ev.created_at || ev.created; var rel=created ? fmtRel(created) : '';
      item.innerHTML =
        '<span class="tl-dot" aria-hidden="true"></span>' +
        '<div class="tl-head">' +
          '<span class="tl-title">' + iconFor(type) + ' ' + (ev.title || (type === 'status' ? 'Status' : 'Evento')) + '</span>' +
          '<span class="tl-time" title="' + (created || '') + '">' + rel + '</span>' +
        '</div>' +
        (ev.message ? ('<div class="tl-msg">' + ev.message + '</div>') : '') +
        '<div class="tl-meta"></div>';

      var metaBox=item.querySelector('.tl-meta');
      if (meta && meta.status)           metaBox.insertAdjacentHTML('beforeend','<span class="tl-badge">status: <b>'+ meta.status +'</b></span>');
      if (meta && meta.log_status)       metaBox.insertAdjacentHTML('beforeend','<span class="tl-badge">log: <b>'+ meta.log_status +'</b></span>');
      if (meta && meta.cd && meta.cd.responsavel)  metaBox.insertAdjacentHTML('beforeend','<span class="tl-badge">CD: '+ meta.cd.responsavel +'</span>');
      if (meta && meta.cd && meta.cd.receivedAt)   metaBox.insertAdjacentHTML('beforeend','<span class="tl-badge">recebido: '+ new Date(meta.cd.receivedAt).toLocaleString('pt-BR') +'</span>');
      if (meta && meta.cd && meta.cd.unreceivedAt) metaBox.insertAdjacentHTML('beforeend','<span class="tl-badge">removido: '+ new Date(meta.cd.unreceivedAt).toLocaleString('pt-BR') +'</span>');
      if (meta && meta.cd && meta.cd.inspectedAt)  metaBox.insertAdjacentHTML('beforeend','<span class="tl-badge">inspecionado: '+ new Date(meta.cd.inspectedAt).toLocaleString('pt-BR') +'</span>');

      var reasonTxt = reasonFromMeta(meta);
      if (reasonTxt) metaBox.insertAdjacentHTML('beforeend','<span class="tl-badge">motivo: <b>'+ reasonTxt +'</b></span>');

      frag.appendChild(item);
    });
    wrap.appendChild(frag);
  }

  function refreshTimeline(id){
    var elLoad=$('events-loading'), elList=$('events-list');
    if (elLoad) elLoad.hidden=false; if (elList) elList.setAttribute('aria-busy','true');
    return fetchEvents(id, 100, 0)
      .then(renderEvents)
      .catch(function(){ renderEvents([]); })
      .then(function(){ if (elLoad) elLoad.hidden=true; if (elList) elList.setAttribute('aria-busy','false'); });
  }

  // ===== Atalhos =====
  document.addEventListener('keydown', function (e) { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); } });

  // ===== Listeners básicos =====
  ['#valor_produto','#produto_valor','input[name="valor_produto"]','.js-valor-produto',
   '#valor_frete','#frete_valor','input[name="valor_frete"]','.js-valor-frete',
   '#status','select[name="status"]'
  ].forEach(function(sel){ var el=pickEl(sel); if (!el) return; el.addEventListener('input', recalc); if (el.tagName === 'SELECT') el.addEventListener('change', recalc); });
  (function(){ var sel=getMotivoSelect(); if (sel){ sel.addEventListener('change', recalc); } })();

  var btnIA=$('btn-insp-aprova'), btnIR=$('btn-insp-reprova');
  if (btnIA) btnIA.addEventListener('click', function(){ openInspectDialog('aprovado'); });
  if (btnIR) btnIR.addEventListener('click', function(){ openInspectDialog('rejeitado'); });

  var rqA=$('rq-aprovar'), rqR=$('rq-reprovar');
  if (rqA) rqA.addEventListener('click', function(){ openInspectDialog('aprovado'); });
  if (rqR) rqR.addEventListener('click', function(){ openInspectDialog('rejeitado'); });

  var rqRec=$('rq-receber'); if (rqRec) rqRec.addEventListener('click', openReceiveDialog);
  var btnCd = $('btn-cd');   if (btnCd) btnCd.addEventListener('click', openReceiveDialog);

  var btnSalvar=$('btn-salvar'); if (btnSalvar) btnSalvar.addEventListener('click', save);
  var btnEnrich=$('btn-enrich'); if (btnEnrich) btnEnrich.addEventListener('click', function(){ enrichFromML('manual'); });

  function disableHead(disabled){
    ['btn-salvar','btn-enrich','btn-insp-aprova','btn-insp-reprova','rq-receber','rq-aprovar','rq-reprovar','btn-cd','btn-mark']
      .forEach(function(id){ var el=$(id); if (el) el.disabled = !!disabled; });
  }

  // ===== Load inicial =====
  function load(){
    if (!returnId) {
      var cont=document.querySelector('.page-wrap'); if (cont) cont.innerHTML='<div class="card"><b>ID não informado.</b></div>'; return;
    }
    reloadCurrent()
      .then(function(){
        upperSKUInstant();
        [getFirst(['#valor_produto','#produto_valor','input[name="valor_produto"]','.js-valor-produto']),
         getFirst(['#valor_frete','#frete_valor','input[name="valor_frete"]','.js-valor-frete'])
        ].forEach(bindDirty);

        var needMotivoConvert = !!current.tipo_reclamacao && !/_/.test(String(current.tipo_reclamacao)) && current.tipo_reclamacao !== 'nao_corresponde';
        var podeML = lojaEhML(current.loja_nome) || parecePedidoML(current.id_venda) || !!readFirst(['#ml_claim_id','input[name="ml_claim_id"]','.js-claim-id']);

        if (needMotivoConvert) return enrichFromML('motivo');
        if (podeML && canEnrichNow() && needsEnrichment(current)) return enrichFromML('auto');
      })
      .then(function(){
        var ls = String(current.log_status || '').toLowerCase();
        if (ls === 'aprovado_cd' || ls === 'reprovado_cd') {
          var btnA=$('btn-insp-aprova'), btnR=$('btn-insp-reprova'); if (btnA && btnA.style) btnA.style.display='none'; if (btnR && btnR.style) btnR.style.display='none';
          var rqA2=$('rq-aprovar'), rqR2=$('rq-reprovar'); if (rqA2) rqA2.setAttribute('disabled','true'); if (rqR2) rqR2.setAttribute('disabled','true');
        }

        var cid = readFirst(['#ml_claim_id','input[name="ml_claim_id"]','.js-claim-id']) || (current.raw && (current.raw.claim_id || current.raw.ml_claim_id));
        if (cid && !(current.raw && current.raw.claim)) tryFetchClaimDetails(cid);
        if (cid) fetchAndApplyReturnCost(String(cid), { persist: true });

        return current.id ? refreshTimeline(current.id) : null;
      })
      .catch(function (e) {
        var cont=document.querySelector('.page-wrap'); if (cont) cont.innerHTML='<div class="card"><b>'+(e.message || 'Falha ao carregar.')+'</b></div>';
      });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load); else load();
})();
