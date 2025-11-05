(function () {
  // ===== Helpers =====
  var $  = function (id) { return document.getElementById(id); };
  var qs = new URLSearchParams(location.search);
  var returnId = qs.get('id') || qs.get('return_id') || (location.pathname.split('/').pop() || '').replace(/\D+/g,'');

  // ---- DOM helpers (fallbacks para diferenças no HTML) ----
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
  function toast(msg, type){
    type = type || 'info';
    var t = $('toast'); if (!t) { alert(msg); return; }
    t.className = 'toast ' + type; t.textContent = msg;
    requestAnimationFrame(function(){ t.classList.add('show'); setTimeout(function(){ t.classList.remove('show'); }, 3000); });
  }
  function setAutoHint(txt){ var el=$('auto-hint'); if(el) el.textContent = txt || ''; }

  // ====== "Sticky fields" ======
  function bindDirty(el){
    if (!el || el.__dirtyBound) return;
    el.addEventListener('input', function(){ el.dataset.dirty = '1'; });
    el.__dirtyBound = true;
  }
  function setSafe(el, value, opts){
    if (!el) return;
    if (el.dataset.dirty === '1') return;            // não sobrescreve o que o usuário digitou
    if (value === null || value === undefined || String(value).trim() === '') return;
    var v = String(value).trim();
    if (opts && opts.upper) v = v.toUpperCase();
    el.value = v;
  }
  function upperSKUInstant(){
    var s = $('sku');
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

  function updateSummary(d){
    var rs=$('resumo-status'), rl=$('resumo-log'), rc=$('resumo-cd'), rp=$('resumo-prod'), rf=$('resumo-frete'), rt=$('resumo-total');
    if (rs) rs.textContent = (d.status || '—').toLowerCase();
    if (rl) rl.textContent = (d.log_status || '—').toLowerCase();
    if (rc) rc.textContent = d.cd_recebido_em ? 'recebido' : 'não recebido';
    if (rp) rp.textContent = moneyBRL(d.valor_produto || 0);
    if (rf) rf.textContent = moneyBRL(d.valor_frete || 0);
    if (rt) rt.textContent = moneyBRL(calcTotalByRules(d));
  }

  function capture(){
    var selMot = getMotivoSelect();
    return {
      id_venda:        $('id_venda') ? $('id_venda').value.trim() : null,
      cliente_nome:    $('cliente_nome') ? $('cliente_nome').value.trim() : null,
      loja_nome:       $('loja_nome') ? $('loja_nome').value.trim() : null,
      data_compra:     $('data_compra') ? $('data_compra').value : null,
      status:          $('status') ? $('status').value : null,
      sku:             $('sku') ? $('sku').value.trim().toUpperCase() : null, // sempre MAIÚSCULO
      tipo_reclamacao: selMot ? selMot.value : null,
      nfe_numero:      $('nfe_numero') ? $('nfe_numero').value.trim() : null,
      nfe_chave:       $('nfe_chave') ? $('nfe_chave').value.trim() : null,
      reclamacao:      $('reclamacao') ? $('reclamacao').value.trim() : null,
      valor_produto:   toNum($('valor_produto') ? $('valor_produto').value : 0),
      valor_frete:     toNum($('valor_frete') ? $('valor_frete').value : 0),
      log_status:      current.log_status || null,
      cd_recebido_em:  current.cd_recebido_em || null
    };
  }

  function recalc(){
    var d = capture();
    var eProd=$('ml-product-sum'), eFrete=$('ml-freight');
    if (eProd)  eProd.textContent  = moneyBRL(d.valor_produto);
    if (eFrete) eFrete.textContent = moneyBRL(d.valor_frete);
    var eTotal = $('valor_total');
    if (eTotal) eTotal.value = moneyBRL(calcTotalByRules(d));
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
    bindDirty($('cliente_nome'));
    bindDirty($('loja_nome'));
    bindDirty($('id_venda'));
    upperSKUInstant();

    setSafe($('id_venda'),     d.id_venda);
    setSafe($('cliente_nome'), d.cliente_nome);
    setSafe($('loja_nome'),    d.loja_nome);
    if ($('data_compra')) $('data_compra').value = d.data_compra ? String(d.data_compra).slice(0,10) : '';
    if ($('status'))      $('status').value      = d.status || '';
    setSafe($('sku'), d.sku, { upper:true });

    if ($('nfe_numero'))    $('nfe_numero').value = d.nfe_numero || '';
    if ($('nfe_chave'))     $('nfe_chave').value  = d.nfe_chave || '';
    if ($('reclamacao'))    $('reclamacao').value = d.reclamacao || '';
    if ($('valor_produto')) $('valor_produto').value = (d.valor_produto == null ? '' : String(toNum(d.valor_produto)));
    if ($('valor_frete'))   $('valor_frete').value   = (d.valor_frete  == null ? '' : String(toNum(d.valor_frete)));

    if ($('order_id')) {
      var rawOrderId = firstNonEmpty(d.raw && d.raw.order_id, d.raw && d.raw.id_venda, d.id_venda);
      setSafe($('order_id'), rawOrderId);
    }
    if ($('ml_claim_id')) {
      var rawClaimId = firstNonEmpty(d.raw && (d.raw.ml_claim_id || d.raw.claim_id), d.raw && d.raw.claim && d.raw.claim.id);
      setSafe($('ml_claim_id'), rawClaimId);
    }

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
    sumMlCostsAndRender(); // inicializa total custos ML, caso já existam valores digitados
  }

  // === ML summary UI (igual) ===
  function fillMlSummary(payload){
    var order = payload && (payload.order || payload.order_info);
    var amounts = payload && payload.amounts;
    var retCost = payload && payload.return_cost;

    var orderDisplay = $('ml-order-display');
    if (orderDisplay) {
      var ordId = (order && (order.id || order.order_id)) || (function(){ var x=$('order_id'); return x ? x.value : null; })();
      orderDisplay.textContent = ordId || '—';
    }
    if ($('ml-nick-display')) {
      var nick = (order && order.seller && (order.seller.nickname || order.seller.nick_name)) || null;
      $('ml-nick-display').textContent = nick ? ('Mercado Livre · ' + nick) : (current.loja_nome || '—');
    }
    if ($('ml-date-display')) {
      var dt = (order && (order.date_created || order.paid_at || order.created_at)) || current.data_compra || '';
      $('ml-date-display').textContent = dt ? new Date(dt).toLocaleDateString('pt-BR') : '—';
    }

    var prodSum = null, freight = null;
    if (amounts) {
      if ('product' in amounts) prodSum = toNum(amounts.product);
      if ('freight' in amounts) freight = toNum(amounts.freight);
      if ('shipping' in amounts) freight = toNum(amounts.shipping);
      if ('shipping_cost' in amounts) freight = toNum(amounts.shipping_cost);
    }
    if (retCost && retCost.amount != null) freight = toNum(retCost.amount);

    if ($('ml-product-sum')) $('ml-product-sum').textContent = prodSum != null ? moneyBRL(prodSum) : moneyBRL(current.valor_produto || 0);
    if ($('ml-freight'))     $('ml-freight').textContent     = freight != null ? moneyBRL(freight) : moneyBRL(current.valor_frete || 0);

    var claimId = (payload && payload.sources && payload.sources.claim_id) || (function(){ var x=$('ml_claim_id'); return x ? x.value : null; })();
    var a = $('claim-open-link');
    if (a) { a.setAttribute('title', claimId ? ('Claim ID: ' + claimId) : 'Sem Claim ID'); a.href = '#'; }
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

    // Preferência de motivo
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

    // ---- NOVO: Situação ML e Mediação ----
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
  }

  function tryFetchClaimDetails(claimId){
    if (!claimId) return Promise.resolve();
    return fetch('/api/ml/claims/' + encodeURIComponent(claimId), { headers: { 'Accept': 'application/json' } })
      .then(function(r){ if(!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function(j){ var c = j && (j.data || j.claim || j); if (c && typeof c==='object') fillClaimUI(c); })
      .catch(function(){ /* silencioso */ });
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

  // ===== Inspeção (mantida, mas secundária na UI) =====
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

  // ===== ENRIQUECIMENTO (ML) =====
  var ENRICH_TTL_MS = 10 * 60 * 1000;
  function lojaEhML(nome){ var s=String(nome||'').toLowerCase(); return s.indexOf('mercado')>=0 || s.indexOf('meli')>=0 || s.indexOf('ml')>=0; }
  function parecePedidoML(pedido){ return /^\d{6,}$/.test(String(pedido || '')); }
  function needsEnrichment(d){
    var faltamValores = !d || toNum(d.valor_produto) === 0 || toNum(d.valor_frete) === 0;
    var faltamMetadados = !d || !d.id_venda || !d.sku || !d.cliente_nome || !d.loja_nome || !d.data_compra || !d.log_status;
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

  // persistimos meta (id_venda, cliente, loja, data, sku) ANTES do reload => evita “some depois de 1s”
  function persistMetaPatch(patch){
    var idp = current.id || returnId;
    if (!idp || !Object.keys(patch).length) return Promise.resolve();
    return fetch('/api/returns/' + encodeURIComponent(idp), {
      method: 'PATCH',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify(Object.assign({}, patch, { updated_by:'frontend-auto-enrich-meta' }))
    }).catch(function(){});
  }

  function enrichFromML(reason){
    reason = reason || 'auto';
    if (!current || !current.id) return Promise.resolve(false);

    disableHead(true);
    setAutoHint('(buscando valores no ML…)');

    var id = current.id;

    var typedOrderId = $('id_venda') && $('id_venda').value ? $('id_venda').value.trim() : '';
    var typedClaimId = $('ml_claim_id') && $('ml_claim_id').value ? $('ml_claim_id').value.trim() : '';
    var params = [];
    if (typedOrderId) params.push('order_id=' + encodeURIComponent(typedOrderId));
    if (typedClaimId) params.push('claim_id=' + encodeURIComponent(typedClaimId));
    var qsOverride = params.length ? ('?' + params.join('&')) : '';

    var previewUrl = '/api/ml/returns/' + encodeURIComponent(id) + '/fetch-amounts' + qsOverride;
    var persistUrl = '/api/ml/returns/' + encodeURIComponent(id) + '/enrich';

    return fetch(previewUrl, { headers: { 'Accept': 'application/json' } })
      .then(function (r) {
        return r.text().then(function (txt) {
          var j = {}; try { j = txt ? JSON.parse(txt) : {}; } catch (_e) {}
          if (!r.ok) { var err = new Error((j && (j.error || j.message)) || ('HTTP ' + r.status)); err.status = r.status; throw err; }
          return j;
        });
      })
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

        var ip=$('valor_produto'), ifr=$('valor_frete');
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

        // ---- Dados do pedido (vazios) -> patch + persist
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

          var sellerNick = (ord.seller && (ord.seller.nickname || ord.seller.nick_name)) || ord.store_nickname || null;
          var lojaNome   = sellerNick ? ('Mercado Livre · ' + sellerNick) : (ord.site_id ? (siteIdToName(ord.site_id)) : null);
          applyIfEmpty(patch, 'loja_nome', lojaNome);

          var dt = ord.date_created || ord.paid_at || ord.created_at || null;
          applyIfEmpty(patch, 'data_compra', dt ? String(dt).slice(0, 10) : null);

          var sku = pickSkuFromOrder(ord);
          applyIfEmpty(patch, 'sku', sku);
        }

        // ---- Motivo (pega canônico) ----
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

        // ---- Log sugerido ----
        var logHint = j.log_status_suggested || null;
        if (logHint) {
          var lsNow = String(current.log_status || '').toLowerCase();
          if (!lsNow || lsNow === 'nao_recebido' || lsNow === 'não_recebido') {
            current.log_status = logHint; setLogPill(logHint);
          }
        }

        // aplica patch no front imediatamente
        if (Object.keys(patch).length) {
          if (patch.id_venda && $('id_venda')) setSafe($('id_venda'), patch.id_venda);
          if (patch.cliente_nome && $('cliente_nome')) setSafe($('cliente_nome'), patch.cliente_nome);
          if (patch.loja_nome && $('loja_nome')) setSafe($('loja_nome'), patch.loja_nome);
          if (patch.data_compra && $('data_compra')) $('data_compra').value = patch.data_compra;
          if (patch.sku && $('sku')) setSafe($('sku'), patch.sku, { upper:true });
          current = Object.assign({}, current, patch);
          recalc();
        }

        // >>> PERSISTE META (id_venda/cliente/loja/data/SKU) ANTES DO reload <<<
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

        return Promise.all([persistMeta, persistEvent, persistMoney, persistPatch]);
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
      .then(safeJson)
      .then(function (j) { var arr = coerceEventsPayload(j); return Array.isArray(arr) ? arr : []; }).catch(function(){ return []; });
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

  // ===== NOVO: Custos do ML (UI + persistência best-effort) =====
  function sumMlCostsAndRender(){
    var v1 = toNum(($('ml_tarifa_venda')||{}).value || 0);
    var v2 = toNum(($('ml_envio_ida')||{}).value || 0);
    var v3 = toNum(($('ml_tarifa_devolucao')||{}).value || 0);
    var v4 = toNum(($('ml_outros')||{}).value || 0);
    var total = v1 + v2 + v3 + v4;
    var out = $('ml_total_custos');
    if (out) out.value = moneyBRL(total);
    return { v1:v1, v2:v2, v3:v3, v4:v4, total: total };
  }
  ['ml_tarifa_venda','ml_envio_ida','ml_tarifa_devolucao','ml_outros'].forEach(function(id){
    var el=$(id); if (!el) return;
    el.addEventListener('input', sumMlCostsAndRender);
  });

  function saveMlCosts(){
    var id = current.id || returnId;
    if (!id) { toast('ID inválido.', 'error'); return; }
    var c = sumMlCostsAndRender();
    var body = {
      ml_tarifa_venda: c.v1,
      ml_envio_ida: c.v2,
      ml_tarifa_devolucao: c.v3,
      ml_outros: c.v4,
      updated_by: 'frontend-ml-costs'
    };
    return fetch('/api/returns/' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    .then(function(r){
      // Se o backend não tiver as colunas, ele simplesmente ignorará — tratamos como OK
      if (!r.ok) throw new Error('Falha ao salvar custos');
    })
    .then(function(){ toast('Custos do ML salvos (quando suportado).', 'success'); })
    .catch(function(){ toast('Não foi possível salvar os custos no backend. (Campos podem não existir ainda.)', 'warning'); });
  }
  var btnMlCosts=$('btn-ml-costs-save'); if (btnMlCosts) btnMlCosts.addEventListener('click', saveMlCosts);

  // ===== NOVO: Marcação operacional =====
  function applyMark(){
    var id = current.id || returnId; if (!id) return;
    var sel = $('mark-op'); var obsEl = $('mark-obs');
    var op = sel ? sel.value : 'em_espera';
    var obs = obsEl ? obsEl.value.trim() : '';

    // Mapa para um status interno existente (seguro para o backend atual)
    var patch = {};
    if (op === 'concluida') patch.status = 'aprovado';
    else if (op === 'em_espera') patch.status = 'pendente';
    else if (op === 'troca') patch.status = 'aprovado';
    else if (op === 'reembolso_parcial') patch.status = 'aprovado';

    // Se sinalizou defeituosa, reforçamos o motivo canônico
    if (op === 'defeituosa') patch.tipo_reclamacao = 'produto_defeituoso';

    // Observação: anexamos sem sobrescrever o que já existe
    var atual = $('reclamacao') ? $('reclamacao').value.trim() : '';
    var append = obs ? ((atual ? (atual + '\n') : '') + '[Marcação] ' + op.replace(/_/g,' ') + (obs ? (': ' + obs) : '')) : null;
    if (append) patch.reclamacao = append;

    patch.updated_by = 'frontend-mark';

    disableHead(true);
    fetch('/api/returns/' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    })
    .then(function(r){ if(!r.ok) throw new Error('Falha ao aplicar marcação'); })
    .then(function(){ return reloadCurrent(); })
    .then(function(){ toast('Marcação aplicada.', 'success'); return refreshTimeline(id); })
    .catch(function(e){ toast(e.message || 'Erro ao marcar', 'error'); })
    .then(function(){ disableHead(false); });
  }
  var btnMark=$('btn-mark'); if (btnMark) btnMark.addEventListener('click', applyMark);

  // ===== Atalhos =====
  document.addEventListener('keydown', function (e) { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); } });

  // ===== Listeners básicos =====
  ['valor_produto','valor_frete','status'].forEach(function(id){
    var el=$(id); if (!el) return; el.addEventListener('input', recalc); if (el.tagName === 'SELECT') el.addEventListener('change', recalc);
  });
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
    ['btn-salvar','btn-enrich','btn-insp-aprova','btn-insp-reprova','rq-receber','rq-aprovar','rq-reprovar','btn-cd','btn-mark','btn-ml-costs-save']
      .forEach(function(id){ var el=$(id); if (el) el.disabled = !!disabled; });
  }

  // ===== Load inicial =====
  function load(){
    if (!returnId) {
      var cont=document.querySelector('.page-wrap'); if (cont) cont.innerHTML='<div class="card"><b>ID não informado.</b></div>'; return;
    }
    reloadCurrent()
      .then(function(){
        upperSKUInstant(); // garante uppercase sempre
        var needMotivoConvert = !!current.tipo_reclamacao && !/_/.test(String(current.tipo_reclamacao)) && current.tipo_reclamacao !== 'nao_corresponde';
        var podeML = lojaEhML(current.loja_nome) || parecePedidoML(current.id_venda);

        if (needMotivoConvert) {
          return enrichFromML('motivo');
        }
        if (podeML && canEnrichNow() && needsEnrichment(current)) {
          return enrichFromML('auto');
        }
      })
      .then(function(){
        var ls = String(current.log_status || '').toLowerCase();
        if (ls === 'aprovado_cd' || ls === 'reprovado_cd') {
          var btnA=$('btn-insp-aprova'), btnR=$('btn-insp-reprova'); if (btnA && btnA.style) btnA.style.display='none'; if (btnR && btnR.style) btnR.style.display='none';
          var rqA2=$('rq-aprovar'), rqR2=$('rq-reprovar'); if (rqA2) rqA2.setAttribute('disabled','true'); if (rqR2) rqR2.setAttribute('disabled','true');
        }

        var cid = ($('ml_claim_id') && $('ml_claim_id').value) || (current.raw && (current.raw.claim_id || current.raw.ml_claim_id));
        if (cid && !(current.raw && current.raw.claim)) tryFetchClaimDetails(cid);

        return current.id ? refreshTimeline(current.id) : null;
      })
      .catch(function (e) {
        var cont=document.querySelector('.page-wrap'); if (cont) cont.innerHTML='<div class="card"><b>'+(e.message || 'Falha ao carregar.')+'</b></div>';
      });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load); else load();
})();
