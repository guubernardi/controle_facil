// /public/js/devolucao-editar.js — ML enriched + FALLBACK via ORDER + buyer/users fallback + persistente
(function () {
  /* =============== Helpers =============== */
  var $  = function (id) { return document.getElementById(id); };
  var qs = new URLSearchParams(location.search);

  // --- util para evitar submit implícito de botões dentro de <form> ---
  function neutralizeSubmit(id) {
    var el = $(id);
    if (!el) return;
    if (el.tagName && el.tagName.toLowerCase() === 'button') {
      try { if ((el.type || '').toLowerCase() !== 'button') el.type = 'button'; } catch(_) {}
    }
  }
  function safeOnClick(el, fn) {
    if (!el || el.__safeBound) return;
    el.addEventListener('click', function(e){
      try { e.preventDefault(); e.stopPropagation(); } catch(_) {}
      fn(e);
    });
    el.__safeBound = true;
  }

  var returnId = (function () {
    var qid = qs.get('id') || qs.get('return_id');
    if (qid) return String(qid).replace(/\D+/g,'');
    var m = location.pathname.match(/\/(?:devolucoes|returns)\/(\d+)/i);
    if (m) return m[1];
    var tail = (location.pathname.split('/').pop() || '').replace(/\D+/g,'');
    return tail || '';
  })();

  var ORDER_ID_SELECTORS = ['#id_venda','input[name="id_venda"]','.js-order-id','#numero_pedido','input[name="numero_pedido"]','#order_id','input[name="order_id"]'];
  var CLAIM_ID_SELECTORS = ['#ml_claim_id','input[name="ml_claim_id"]','.js-claim-id','#claim_id','input[name="claim_id"]'];
  var CLIENTE_SELECTORS  = ['#cliente_nome','#cliente','input[name="cliente_nome"]','.js-cliente','.js-cliente-nome'];

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
    var incomingEmpty = (value === undefined || value === null || (typeof value === 'string' && value.trim() === ''));
    if ('value' in el) {
      if (el.dataset && el.dataset.dirty === '1') return false;
      var hasCurrent = String(el.value || '').trim() !== '';
      if (incomingEmpty && hasCurrent) return false;
      var v = (value == null ? '' : String(value));
      if (opts && opts.upper) v = v.toUpperCase();
      el.value = v;
    } else {
      var hasCurrentT = String(el.textContent || '').trim() !== '';
      if (incomingEmpty && hasCurrentT) return false;
      el.textContent = (value == null ? '' : String(value));
    }
    return true;
  }
  function readFirst(selectors, toNumFlag) {
    var el = getFirst(selectors); if (!el) return null;
    var v = ('value' in el) ? el.value : el.textContent;
    v = (v == null ? '' : String(v).trim());
    // trata placeholder "—" como vazio
    if (v === '—') v = '';
    return toNumFlag ? toNum(v) : v;
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
    requestAnimationFrame(function(){ t.classList.add('show'); setTimeout(function(){ t.classList.remove('show'); }, 3500); });
  }
  function setAutoHint(txt){ var el=$('auto-hint'); if(el) el.textContent = txt || ''; }

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

  // ==== LOCK do "Status da Logística" (evita piscar/voltar para 'disputa') ====
  var LOG_LOCKED = false;
  function setLogPill(text, opts) {
    opts = opts || {};
    if (LOG_LOCKED && !opts.force) return;

    var el = getLogPillEl(); if (!el) return;
    var s = String(text || '').toLowerCase();
    var cls = 'pill -neutro';
    if (!text) cls = 'pill -neutro';
    else if (s === 'em_transporte' || s === 'pronto_envio' || s.includes('pend') || s.includes('caminho')) cls = 'pill -pendente';
    else if (s === 'recebido_cd' || s.includes('aprov') || s.includes('recebido')) cls = 'pill -aprovado';
    else if (s === 'reprovado_cd' || s.includes('rej') || s.includes('neg') || s.includes('reprov')) cls = 'pill -rejeitado';

    el.className = cls;
    el.textContent = text || '—';

    if (opts.lock) LOG_LOCKED = true;
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

  /* =============== Regras =============== */
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

  /* =============== Normalização =============== */
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
      j.seller_nickname || j.nickname || j.seller_name || j.store_name || null;

    var buyerName  =
      (j.buyer && (
        (j.buyer.first_name && j.buyer.last_name ? (j.buyer.first_name + ' ' + j.buyer.last_name) : (j.buyer.name || j.buyer.first_name)) ||
        j.buyer.nickname
      )) ||
      (j.shipping && j.shipping.receiver_address && j.shipping.receiver_address.receiver_name) ||
      j.cliente || j.cliente_nome || j.buyer_name || null;

    var dataCompra = firstNonEmpty(j.data_compra, j.order_date, j.date_created, j.paid_at, j.created_at);
    var motivo     = firstNonEmpty(j.tipo_reclamacao, j.reclamacao, j.reason_name, j.reason, j.reason_id, j.motivo, j.motivo_cliente);

    // ---- log_status seguro: não herda 'status' genérico (ex.: 'disputa')
    function pickLogStatus(_j){
      var direct = firstNonEmpty(_j.log_status, _j.log, _j.current_log, _j.log_atual, _j.status_log);
      if (direct) return direct;
      var st = String(_j.status || '').toLowerCase();
      var ok = /^(pendente|em_transporte|pronto_envio|retorno_comprador|cancelado|expirado|falha|agendado|recebido_cd|aprovado_cd|reprovado_cd)$/.test(st);
      return ok ? st : null;
    }
    var logAtual   = pickLogStatus(j);

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
      cd_recebido_em: recebidoDe(j),
      cd_responsavel: recebResp
    };
    function recebidoDe(_j){ return recebCdEm; }
  }

  var current = {};
  var hasLocalRow = false;

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
    var logTxt = LOG_LOCKED ? (current.log_status || d.log_status) : d.log_status;
    if (rl) rl.textContent = (logTxt || '—').toLowerCase();
    if (rc) rc.textContent = d.cd_recebido_em ? 'recebido' : 'não recebido';
    if (rp) rp.textContent = moneyBRL(d.valor_produto || 0);
    if (rf) rf.textContent = moneyBRL(d.valor_frete || 0);
    if (rt) rt.textContent = moneyBRL(calcTotalByRules(d));
  }

  function capture(){
    var selMot = getMotivoSelect();
    return {
      id_venda:        readFirst(ORDER_ID_SELECTORS),
      cliente_nome:    readFirst(CLIENTE_SELECTORS),
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

  /* =============== Motivo (canon) =============== */
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
    different_from_publication:'nao_corresponde',not_as_described:'nao_corresponde',wrong_item:'nao_corresponde',different_from_listing:'nao_corresponde',different_from_ad:'nao_corresponde',different_item:'nao_corresponde',missing_parts:'nao_corresponde',parts_missing:'nao_corresponde',incomplete:'nao_corresponde',
    buyer_remorse:'arrependimento_cliente',
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
    if (/(nao\s*(o\s*)?quer\s*mais|não\s*(o\s*)?quer\s*mais|mudou\s*de\s*ideia|changed\s*mind|buyer\s*remorse|no\s*longer\s*wants?)/.test(t)) return 'arrependimento_cliente';
    if (/(nao\s*serv|não\s*serv|tamanho|size|doesn.?t\s*fit)/.test(t)) return 'arrependimento_cliente';
    if (/(defeit|nao\s*funciona|não\s*funciona|not\s*working|broken)/.test(t)) return 'produto_defeituoso';
    if (/(danific|avariad|in\s*transit)/.test(t)) return 'produto_danificado';
    if (/(diferent[ea]|nao\s*correspond|não\s*correspond|wrong\s*item|not\s*as\s*described)/.test(t)) return 'nao_corresponde';
    if (/(nao\s*entreg|não\s*entreg|delayed|not\s*delivered)/.test(t)) return 'entrega_atrasada';
    var fromDict = MOTIVO_CANON[t]; if (fromDict) return fromDict;
    return null;
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
  function setMotivoCanon(canon, lock){
    var sel = getMotivoSelect(); if (!sel || !canon) return false;
    for (var i=0;i<sel.options.length;i++){
      if (sel.options[i].value === canon) {
        sel.value = canon; sel.dispatchEvent(new Event('change'));
        if (lock) lockMotivo(true,'(ML)');
        return true;
      }
    }
    var wanted = (CANON_LABELS[canon] || []).map(norm);
    for (var j=0;j<sel.options.length;j++){
      var opt = sel.options[j];
      var labelN = norm(opt.text || opt.label || '');
      if (labelN && (labelN === norm(canon) || wanted.indexOf(labelN) >= 0)) {
        sel.value = opt.value; sel.dispatchEvent(new Event('change'));
        if (lock) lockMotivo(true,'(ML)');
        return true;
      }
    }
    return false;
  }

  /* =============== UI fill =============== */
  function fill(d){
    var dvId=$('dv-id'); if (dvId) dvId.textContent = d.id ? ('#' + d.id) : '';

    [getFirst(CLIENTE_SELECTORS),
     getFirst(['#loja_nome','input[name="loja_nome"]','.js-loja']),
     getFirst(ORDER_ID_SELECTORS),
     getFirst(['#valor_produto','#produto_valor','input[name="valor_produto"]','.js-valor-produto']),
     getFirst(['#valor_frete','#frete_valor','input[name="valor_frete"]','.js-valor-frete'])
    ].forEach(bindDirty);
    upperSKUInstant();

    setFirst(ORDER_ID_SELECTORS, d.id_venda);
    setFirst(CLIENTE_SELECTORS, d.cliente_nome);
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
    setFirst(['#order_id','input[name="order_id"]','.js-order-id-raw'].concat(ORDER_ID_SELECTORS), rawOrderId);
    var rawClaimId = firstNonEmpty(d.raw && (d.raw.ml_claim_id || d.raw.claim_id), d.raw && d.raw.claim && d.raw.claim.id);
    setFirst(CLAIM_ID_SELECTORS, rawClaimId);

    var sel = getMotivoSelect();
    if (sel) {
      var mot = d.tipo_reclamacao || '';
      var wasSet = false;
      if (/_/.test(mot) || mot === 'nao_corresponde') wasSet = setMotivoCanon(mot, false);
      if (!wasSet && mot)         wasSet = setMotivoCanon(canonFromText(mot), false);
      if (!wasSet && d.reclamacao)wasSet = setMotivoCanon(canonFromText(d.reclamacao), false);
      if (!wasSet) lockMotivo(false);
    }

    // não sobrescreve o pill se já estiver travado por ML
    if (!LOG_LOCKED) setLogPill(d.log_status || '—');
    setCdInfo({ receivedAt: d.cd_recebido_em || null, responsavel: d.cd_responsavel || null });

    fillMlSummaryFromCurrent();
    if (d.raw && d.raw.claim) fillClaimUI(d.raw.claim);

    updateSummary(d); recalc();
  }

  /* =============== Resumo ML =============== */
  function fillMlSummary(payload){
    var order = payload && (payload.order || payload.order_info);
    var amounts = payload && payload.amounts;
    var retCost = payload && payload.return_cost;

    var ordId = (order && (order.id || order.order_id)) || readFirst(['#order_id','input[name="order_id"]','.js-order-id-raw'].concat(ORDER_ID_SELECTORS));
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

    var claimId = (payload && payload.sources && payload.sources.claim_id) || readFirst(CLAIM_ID_SELECTORS);
    var a = $('claim-open-link');
    if (a) {
      if (claimId) {
        a.href = 'https://www.mercadolivre.com.br/claims/' + encodeURIComponent(String(claimId).replace(/\D+/g,''));
        a.target = '_blank'; a.rel = 'noopener';
        a.setAttribute('title', 'Abrir claim #' + claimId + ' no ML');
      } else {
        a.href = '#'; a.removeAttribute('target'); a.setAttribute('title', 'Sem Claim ID');
      }
    }

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

  /* =============== Claim UI =============== */
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

    var prefer = (function (root) {
      function canonFromPayload(root){
        if (!root || typeof root !== 'object') return null;
        if (root.reason_key && REASONKEY_TO_CANON[root.reason_key]) return REASONKEY_TO_CANON[root.reason_key];
        if (root.reason_name && REASONNAME_TO_CANON[root.reason_name]) return REASONNAME_TO_CANON[root.reason_name];
        if (root.reason_name) { var t = canonFromText(root.reason_name); if (t) return t; }
        if (root.reason_detail) { var td = canonFromText(root.reason_detail); if (td) return td; }
        if (root.reason_id) { var c = canonFromCode(root.reason_id); if (c) return c; }
        return null;
      }
      return canonFromPayload({ reason_key: claim.reason_key, reason_name: claim.reason_name, reason_id: claim.reason_id, reason_detail: claim.reason_detail })
             || canonFromCode(claim.reason_id);
    })();
    if (prefer) { setMotivoCanon(prefer, true); }

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

    if (claim.id) fetchAndApplyReturnCost(String(claim.id), { persist: true });
  }

  /* =============== [ML v2+] Status & Flow helpers =============== */
  function humanizeReturnStatusML(s){
    var k = String(s || '').toLowerCase();
    var map = {
      'pending_cancel':    'Cancelamento pendente',
      'pending':           'Devolução criada',
      'failed':            'Falha ao gerar devolução',
      'shipped':           'Devolução enviada',
      'pending_delivered': 'Em processo de entrega',
      'return_to_buyer':   'Devolução voltando ao comprador',
      'pending_expiration':'Próxima de expirar',
      'scheduled':         'Coleta agendada',
      'pending_failure':   'Processo com falha pendente',
      'label_generated':   'Etiqueta pronta',
      'cancelled':         'Devolução cancelada',
      'canceled':          'Devolução cancelada',
      'not_delivered':     'Não entregue',
      'expired':           'Devolução expirada',
      'delivered':         'Recebida pelo vendedor'
    };
    return map[k] || (s ? String(s).replace(/_/g, ' ') : '—');
  }
  function suggestLogFromMLReturn(s){
    var k = String(s || '').toLowerCase();
    if (k === 'delivered')                          return 'recebido_cd';
    if (k === 'shipped' || k === 'pending_delivered') return 'em_transporte';
    if (k === 'label_generated' || k === 'ready_to_ship') return 'pronto_envio';
    if (k === 'return_to_buyer')                    return 'retorno_comprador';
    if (k === 'cancelled' || k === 'canceled')      return 'cancelado';
    if (k === 'expired')                            return 'expirado';
    if (k === 'failed' || k === 'pending_failure')  return 'falha';
    if (k === 'scheduled')                          return 'agendado';
    return 'pendente';
  }
  function showReturnShipmentsFromRet(ret){
    try {
      var destino = (ret.shipments || []).map(function(s){
        var name = (s.destination && s.destination.name) || '';
        var status = humanizeReturnStatusML(s.status);
        return status + (name ? ' · ' + name : '');
      }).join(' | ');
      var slot = $('ml-shipments'); if (slot) slot.textContent = destino || '—';
    } catch(_){}
  }
  function syncReturnState(claimId, orderId){
    if (!claimId) return Promise.resolve();
    var url = '/api/ml/returns/state?claim_id=' + encodeURIComponent(String(claimId).replace(/\D+/g,''));
    if (orderId) url += '&order_id=' + encodeURIComponent(String(orderId).replace(/\D+/g,''));
    return fetch(url, { headers: { 'Accept':'application/json' } })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(j){
        if (j && j.flow) {
          var ls = String(current.log_status || '').toLowerCase();
          if (ls !== 'aprovado_cd' && ls !== 'reprovado_cd') {
            setLogPill(j.flow, { lock: true }); // trava o pill vindo do ML
            current.log_status = j.flow;

            // (opcional) persiste o flow no banco para manter consistência
            if ((current.id || returnId) && j.flow) {
              fetch('/api/returns/' + encodeURIComponent(current.id || returnId), {
                method:'PATCH',
                headers:{ 'Content-Type':'application/json' },
                body: JSON.stringify({ log_status: j.flow, updated_by: 'frontend-flow-sync' })
              }).catch(function(){});
            }
          }
        }
      })
      .catch(function(){});
  }
  function applyEnrichedReturnPayload(j){
    if (!j || typeof j !== 'object') return;
    var ret = j.returns || null;
    var summary = j.summary || null;

    if (ret && ret.status) {
      var label = humanizeReturnStatusML(ret.status);
      var el = $('ml-status-desc'); if (el) el.textContent = label;
      showReturnShipmentsFromRet(ret);
      // sugere log se não tiver inspeção já fechada
      var suggested = suggestLogFromMLReturn(ret.status);
      var ls = String(current.log_status || '').toLowerCase();
      if (ls !== 'aprovado_cd' && ls !== 'reprovado_cd' && suggested) {
        setLogPill(suggested, { lock: true }); // trava ao aplicar do ML
        current.log_status = suggested;
      }
    }
    if (summary && summary.claim_reason) {
      // ajusta motivo (e trava) + exibe label amigável
      var c = canonFromText(summary.claim_reason.label || summary.claim_reason.raw);
      if (c) setMotivoCanon(c, true);
      var cr = $('claim-reason'); if (cr) cr.textContent = summary.claim_reason.label || summary.claim_reason.raw || cr.textContent;
    }
    // persiste estado canônico de flow/raw no servidor
    var cid = j.claim_id || readFirst(CLAIM_ID_SELECTORS);
    var oid = readFirst(ORDER_ID_SELECTORS) || (Array.isArray(j.orders) && j.orders[0] && j.orders[0].order_id) || null;
    if (cid) syncReturnState(cid, oid);
  }

  /* =============== Nome do comprador: fallbacks =============== */
  function guessBuyerNameFromOrder(ord){
    try {
      var direct =
        (ord && ord.buyer && (
          (ord.buyer.first_name && ord.buyer.last_name
            ? (ord.buyer.first_name + ' ' + ord.buyer.last_name)
            : (ord.buyer.nickname || ord.buyer.name || ord.buyer.first_name)
          )
        )) ||
        (ord && ord.shipping && ord.shipping.receiver_address && ord.shipping.receiver_address.receiver_name);
      if (direct) return Promise.resolve(String(direct).trim());
      var buyerId = ord && ord.buyer && (ord.buyer.id || ord.buyer.user_id);
      if (!buyerId) return Promise.resolve(null);
      return fetch('/api/ml/users/' + encodeURIComponent(buyerId), { headers:{ 'Accept':'application/json' } })
        .then(function(r){ return r.ok ? r.json() : null; })
        .then(function(u){
          if (!u || typeof u !== 'object') return 'Cliente ML #' + buyerId;
          var n = (u.first_name && u.last_name) ? (u.first_name + ' ' + u.last_name) : (u.nickname || u.name);
          return (n && String(n).trim()) || ('Cliente ML #' + buyerId);
        })
        .catch(function(){ return 'Cliente ML #' + buyerId; });
    } catch(_) {
      return Promise.resolve(null);
    }
  }
  function setBuyerName(name, persist){
    if (!name) return;
    if (setFirst(CLIENTE_SELECTORS, name)) {
      current.cliente_nome = name;
    }
    if (persist && (current.id || returnId)) {
      fetch('/api/returns/' + encodeURIComponent(current.id || returnId), {
        method:'PATCH', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ cliente_nome: name, updated_by:'frontend-buyername' })
      }).catch(function(){});
    }
  }
  function ensureBuyerName(opts){
    opts = opts || {};
    var existing = readFirst(CLIENTE_SELECTORS);
    if (existing) return Promise.resolve(existing);
    var ordId = readFirst(ORDER_ID_SELECTORS) || (current.raw && (current.raw.order_id || current.raw.resource_id)) || qs.get('order_id');
    if (!ordId) return Promise.resolve(null);
    return fetchOrderInfo(String(ordId).replace(/\D+/g,'')).then(function(ord){
      if (!ord) return null;
      return guessBuyerNameFromOrder(ord).then(function(name){
        if (name) setBuyerName(name, true);
        return name;
      });
    });
  }

  /* =============== Order fallback =============== */
  function fetchOrderInfo(orderId){
    if (!orderId) return Promise.resolve(null);
    var nk = sellerNick();
    var base = '/api/ml/orders/' + encodeURIComponent(orderId);
    var candidates = [
      base + (nk ? ('?nick=' + encodeURIComponent(nk)) : ''),
      base,
      '/api/ml/order/' + encodeURIComponent(orderId) + (nk ? ('?nick=' + encodeURIComponent(nk)) : ''),
      '/api/ml/sales/' + encodeURIComponent(orderId) + (nk ? ('?nick=' + encodeURIComponent(nk)) : '')
    ];
    var i=0;
    function next(){
      if (i >= candidates.length) return Promise.resolve(null);
      var url = candidates[i++];
      return fetch(url, { headers: { 'Accept': 'application/json' } })
        .then(function(r){ return r.text().then(function (txt) {
            var j={}; try { j = txt ? JSON.parse(txt) : {}; } catch(_){}
            if (!r.ok) return next();
            return (j && (j.data || j.order || j.sale || j)) || null;
        });})
        .catch(next);
    }
    return next();
  }

  function applyOrderToUi(ord, opts){
    opts = opts || {};
    if (!ord || typeof ord !== 'object') return Promise.resolve(false);

    var nick = (ord.seller && (ord.seller.nickname || ord.seller.nick_name)) || null;

    var sku = null;
    if (Array.isArray(ord.order_items) && ord.order_items.length) {
      var it0 = ord.order_items[0];
      var it  = it0.item || it0;
      sku = it0.seller_sku || it0.variation_sku || it.seller_sku || it.sku || it.id || null;
    }

    var when = ord.date_created || ord.paid_at || ord.created_at || null;

    var product = null;
    if (Array.isArray(ord.order_items) && ord.order_items.length) {
      product = ord.order_items.reduce(function(acc, oi){
        var q = toNum(oi.quantity || 1);
        var p = toNum(oi.unit_price != null ? oi.unit_price : (oi.full_unit_price != null ? oi.full_unit_price : oi.price));
        return acc + (isFinite(p*q) ? p*q : 0);
      }, 0);
    } else if (ord.total_paid_amount != null) product = toNum(ord.total_paid_amount);
      else if (ord.total_amount != null)   product = toNum(ord.total_amount);
      else if (ord.amount != null)         product = toNum(ord.amount);

    var freight = null;
    var s = ord.shipping || ord.shipment || null;
    if (s) {
      freight = firstNonEmpty(
        s.shipping_cost, s.base_cost, s.cost, s.paid_cost,
        s.shipping_option && s.shipping_option.cost,
        s.logistic_cost, s.logistics_cost, s.amount_shipping, s.total_shipping_cost
      );
      freight = (freight != null) ? toNum(freight) : null;
    } else {
      freight = firstNonEmpty(ord.shipping_cost, ord.freight, ord.logistics_cost, ord.amount_shipping);
      freight = (freight != null) ? toNum(freight) : null;
    }

    return guessBuyerNameFromOrder(ord).then(function(buyerName){
      var changed = false;

      if (buyerName) { if (setFirst(CLIENTE_SELECTORS, buyerName)) { current.cliente_nome = buyerName; changed = true; } }
      if (nick && !current.loja_nome) {
        if (setFirst(['#loja_nome','input[name="loja_nome"]','.js-loja'], 'Mercado Livre · ' + nick)) changed = true;
      }
      if (when) { if (setFirst(['#data_compra','input[name="data_compra"]','.js-data'], String(when).slice(0,10))) changed = true; }
      if (sku)  { if (setFirst(['#sku','input[name="sku"]','.js-sku'], String(sku).toUpperCase(), {upper:true})) { current.sku = String(sku).toUpperCase(); changed = true; } }

      var ip = getFirst(['#valor_produto','#produto_valor','input[name="valor_produto"]','.js-valor-produto']);
      var ifr = getFirst(['#valor_frete','#frete_valor','input[name="valor_frete"]','.js-valor-frete']);
      if (product != null && ip && ip.dataset.dirty!=='1') { ip.value = String(product); current.valor_produto = product; changed = true; }
      if (freight != null && ifr && ifr.dataset.dirty!=='1') { ifr.value = String(freight); current.valor_frete = freight; changed = true; }

      if (changed) {
        recalc();
        updateSummary(Object.assign({}, current, capture()));
        toast('Dados do pedido aplicados do ML.', 'success');
      }

      // persist — agora compara e atualiza se mudou
      var patchMeta = {};
      if (buyerName && buyerName !== current.cliente_nome) patchMeta.cliente_nome = buyerName;
      if (nick && !current.loja_nome) patchMeta.loja_nome = 'Mercado Livre · ' + nick;
      if (when && !current.data_compra) patchMeta.data_compra = when;
      if (sku && !current.sku) patchMeta.sku = String(sku).toUpperCase();

      var patchAmounts = {};
      if (product != null) patchAmounts.valor_produto = product;
      if (freight != null) patchAmounts.valor_frete   = freight;

      var persists = [];
      var idp = current.id || returnId;
      if (idp) {
        if (Object.keys(patchMeta).length) {
          persists.push(fetch('/api/returns/' + encodeURIComponent(idp), {
            method:'PATCH', headers:{'Content-Type':'application/json'},
            body: JSON.stringify(Object.assign({}, patchMeta, { updated_by:'frontend-order-fallback-meta' }))
          }));
        }
        if (Object.keys(patchAmounts).length) {
          persists.push(fetch('/api/returns/' + encodeURIComponent(idp), {
            method:'PATCH', headers:{'Content-Type':'application/json'},
            body: JSON.stringify(Object.assign({}, patchAmounts, { updated_by:'frontend-order-fallback-amounts' }))
          }));
        }
      }
      return Promise.all(persists).catch(function(){ return null; }).then(function(){ return changed; });
    });
  }

  /* =============== Return-cost =============== */
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
    var params = ['usd=true'];
    var nk = sellerNick(); if (nk) params.push('nick=' + encodeURIComponent(nk));
    var base = '/api/ml/claims/' + encodeURIComponent(claimId) + '/charges/return-cost?' + params.join('&');
    return fetch(base, { headers: { 'Accept': 'application/json' } })
      .then(function(r){
        if (r.status === 403 && nk) {
          return fetch('/api/ml/claims/' + encodeURIComponent(claimId) + '/charges/return-cost?usd=true', { headers: { 'Accept':'application/json' } });
        }
        return r;
      })
      .then(function(r){ return r.json().then(function(j){ return { ok:r.ok, body:j }; }); })
      .then(function(res){
        if (!res.ok) return;
        var data = (res.body && res.body.data) || res.body || {};
        showReturnCostInUi(data);
        applyReturnCostToFreight(toNum(data.amount), { persist: opts.persist });
      })
      .catch(function(){});
  }

  /* =============== Timeline =============== */
  function coerceEventsPayload(j){ if (Array.isArray(j)) return j; if (!j || typeof j !== 'object') return []; return j.items || j.events || j.data || []; }
  function fetchEvents(id, limit, offset){
    limit = limit || 100; offset = offset || 0;
    var url = '/api/returns/' + encodeURIComponent(id) + '/events?limit=' + limit + '&offset=' + offset;
    return fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function(r){
        return r.text().then(function(txt){
          var j={}; try{ j = txt ? JSON.parse(txt) : {}; } catch(_){}
          if (!r.ok) return { ok:false, items:null };
          var arr = coerceEventsPayload(j);
          return { ok:true, items: Array.isArray(arr) ? arr : [] };
        });
      })
      .catch(function(){ return { ok:false, items:null }; });
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
    if (!wrap) return;
    if (elLoad) elLoad.hidden=true;

    if (!items || !items.length){
      if (elEmpty) elEmpty.hidden=false;
      wrap.innerHTML = '';
      return;
    }
    if (elEmpty) elEmpty.hidden=true;

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

      var reasonTxt =
        (meta && (meta.reason_name || meta.reason || meta.tipo_reclamacao ||
          (meta.claim && (meta.claim.reason_name || (meta.claim.reason && (meta.claim.reason.name || meta.claim.reason.description)))))) || null;
      if (reasonTxt) metaBox.insertAdjacentHTML('beforeend','<span class="tl-badge">motivo: <b>'+ reasonTxt +'</b></span>');

      frag.appendChild(item);
    });

    $('events-list').innerHTML='';
    $('events-list').appendChild(frag);
  }
  function refreshTimeline(id){
    if (!hasLocalRow) {
      var elLoad=$('events-loading'), elEmpty=$('events-empty');
      if (elLoad) elLoad.hidden=true;
      if (elEmpty) elEmpty.hidden=false;
      return Promise.resolve();
    }
    var elLoad=$('events-loading'), elList=$('events-list');
    if (elLoad) elLoad.hidden=false;
    if (elList) elList.setAttribute('aria-busy','true');

    var previousHTML = elList ? elList.innerHTML : '';

    return fetchEvents(id, 100, 0)
      .then(function(res){
        if (!res.ok) { if (elList) elList.innerHTML = previousHTML; return; }
        renderEvents(res.items || []);
      })
      .catch(function(){ if (elList) elList.innerHTML = previousHTML; })
      .then(function(){
        if (elLoad) elLoad.hidden=true;
        if (elList) elList.setAttribute('aria-busy','false');
      });
  }

  /* =============== Header actions =============== */
  document.addEventListener('keydown', function (e) { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); } });

  ['#valor_produto','#produto_valor','input[name="valor_produto"]','.js-valor-produto',
   '#valor_frete','#frete_valor','input[name="valor_frete"]','.js-valor-frete',
   '#status','select[name="status"]'
  ].forEach(function(sel){ var el=pickEl(sel); if (!el) return; el.addEventListener('input', recalc); if (el.tagName === 'SELECT') el.addEventListener('change', recalc); });
  (function(){ var sel=getMotivoSelect(); if (sel){ sel.addEventListener('change', recalc); } })();

  // Neutraliza submits implícitos e liga handlers seguros
  ['btn-insp-aprova','btn-insp-reprova','rq-aprovar','rq-reprovar','rq-receber','btn-cd','btn-salvar','btn-mark','btn-enrich']
    .forEach(neutralizeSubmit);

  var btnIA=$('btn-insp-aprova'), btnIR=$('btn-insp-reprova');
  if (btnIA) safeOnClick(btnIA, function(){ openInspectDialog('aprovado'); });
  if (btnIR) safeOnClick(btnIR, function(){ openInspectDialog('rejeitado'); });

  var rqA=$('rq-aprovar'), rqR=$('rq-reprovar');
  if (rqA) safeOnClick(rqA, function(){ openInspectDialog('aprovado'); });
  if (rqR) safeOnClick(rqR, function(){ openInspectDialog('rejeitado'); });

  var rqRec=$('rq-receber'); if (rqRec) safeOnClick(rqRec, openReceiveDialog);
  var btnCd = $('btn-cd');   if (btnCd) safeOnClick(btnCd, openReceiveDialog);

  var btnSalvar=$('btn-salvar'); if (btnSalvar) safeOnClick(btnSalvar, save);

  var btnMark=$('btn-mark');
  if (btnMark) {
    safeOnClick(btnMark, function(){
      var id = current.id || returnId;
      if (!id) return toast('ID inválido.', 'error');
      var sel = $('mark-op'); var obs = $('mark-obs');
      var body = { updated_by: 'frontend-mark' };
      if (sel && sel.value) body.status = sel.value;
      if (obs && obs.value) body.mark_obs = obs.value;
      fetch('/api/returns/' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify(body)
      })
      .then(function(r){ if(!r.ok) throw new Error('Falha ao aplicar'); })
      .then(function(){ toast('Aplicado.', 'success'); return Promise.all([reloadCurrent(), refreshTimeline(id)]); })
      .catch(function(e){ toast(e.message || 'Erro ao aplicar', 'error'); });
    });
  }

  var btnEnrich=$('btn-enrich'); if (btnEnrich) safeOnClick(btnEnrich, function(){ enrichFromML('manual'); });
  function disableHead(disabled){
    ['btn-salvar','btn-enrich','btn-insp-aprova','btn-insp-reprova','rq-receber','rq-aprovar','rq-reprovar','btn-cd','btn-mark']
      .forEach(function(id){ var el=$(id); if (el) el.disabled = !!disabled; });
  }

  /* =============== Save =============== */
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

  /* =============== Recebimento no CD =============== */
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
      function cancel(){ if (dlg.close) dlg.close(); cleanup(); }
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

  /* =============== Inspeção =============== */
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

  /* =============== Enrich (ML) =============== */
  var ENRICH_TTL_MS = 10 * 60 * 1000;
  function lojaEhML(nome){ var s=String(nome||'').toLowerCase(); return s.indexOf('mercado')>=0 || s.indexOf('meli')>=0 || s.indexOf('ml')>=0; }
  function parecePedidoML(pedido){ return /^\d{6,}$/.test(String(pedido || '')); }
  function needsEnrichment(d){
    var faltamValores = !d || toNum(d.valor_produto) === 0 || toNum(d.valor_frete) === 0;
    var faltamMetadados = !d || !d.id_venda || !d.cliente_nome || !d.loja_nome || !d.data_compra;
    return faltamValores || faltamMetadados;
  }
  function canEnrichNow(){ var key='rf_enrich_'+returnId; var last=Number(localStorage.getItem(key) || 0); var ok=!last || (Date.now()-last)>ENRICH_TTL_MS; if(ok) localStorage.setItem(key,String(Date.now())); return ok; }

  function persistMetaPatch(patch){
    var idp = current.id || returnId;
    if (!idp || !Object.keys(patch).length) return Promise.resolve();
    return fetch('/api/returns/' + encodeURIComponent(idp), {
      method: 'PATCH',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify(Object.assign({}, patch, { updated_by:'frontend-auto-enrich-meta' })) }
    ).catch(function(){});
  }
  function searchClaimsByOrder(orderId){
    if (!orderId) return Promise.resolve([]);
    var nk = sellerNick();
    var url = '/api/ml/claims/search?order_id=' + encodeURIComponent(orderId) + (nk ? ('&nick=' + encodeURIComponent(nk)) : '');
    return fetch(url, { headers: { 'Accept':'application/json' } })
      .then(function(r){
        if (r.status === 403 && nk) {
          return fetch('/api/ml/claims/search?order_id=' + encodeURIComponent(orderId), { headers: { 'Accept':'application/json' } });
        }
        return r;
      })
      .then(function(r){ if (!r.ok) return []; return r.json(); })
      .then(function(j){ var items = (j && (j.items || j.results || j.claims)) || []; return Array.isArray(items) ? items : []; })
      .catch(function(){ return []; });
  }
  function pickLatestClaimId(items){
    if (!Array.isArray(items) || !items.length) return null;
    items.sort(function(a,b){
      var da = new Date(a.created_date || a.date_created || 0).getTime();
      var db = new Date(b.created_date || b.date_created || 0).getTime();
      return db - da;
    });
    return String(items[0].id || items[0].claim_id || '').replace(/\D+/g,'') || null;
  }

  function tryFetchClaimDetails(claimId){
    if (!claimId) return Promise.resolve();
    var nk = sellerNick();
    var q = nk ? ('?nick=' + encodeURIComponent(nk)) : '';
    return fetch('/api/ml/claims/' + encodeURIComponent(claimId) + q, { headers: { 'Accept': 'application/json' } })
      .then(function(r){
        if (r.status === 403 && q) {
          return fetch('/api/ml/claims/' + encodeURIComponent(claimId), { headers: { 'Accept':'application/json' } });
        }
        return r;
      })
      .then(function(r){ if(!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function(j){
        var c = j && (j.data || j.claim || j);
        if (c && typeof c==='object') {
          fillClaimUI(c);
          if (c.resource_id && !readFirst(ORDER_ID_SELECTORS)) {
            setFirst(ORDER_ID_SELECTORS, String(c.resource_id));
          }
        }
      })
      .catch(function(){});
  }

  function enrichFromML(reason){
    reason = reason || 'auto';
    if (!current || !current.id) current = { id: returnId };

    disableHead(true);
    setAutoHint('(buscando valores no ML…)');

    var typedOrderId = readFirst(ORDER_ID_SELECTORS) || qs.get('order_id');
    var typedClaimId = readFirst(CLAIM_ID_SELECTORS) || qs.get('claim_id');

    function enrichedFetchByClaim(cId){
      if (!cId) return Promise.reject(Object.assign(new Error('no_claim'), {status:400}));
      var nk = sellerNick();
      var url = '/api/ml/claims/' + encodeURIComponent(cId) + '/returns/enriched?usd=true' + (nk ? ('&nick=' + encodeURIComponent(nk)) : '');
      return fetch(url, { headers: { 'Accept':'application/json' } })
        .then(function(r){
          if ((r.status === 403 || r.status === 429) && nk) {
            // 403/429 → tenta sem nick (outra conta/limite)
            return fetch('/api/ml/claims/' + encodeURIComponent(cId) + '/returns/enriched?usd=true', { headers: { 'Accept':'application/json' } });
          }
          return r;
        })
        .then(function(r){ return r.text().then(function (txt) {
          var j={}; try { j = txt ? JSON.parse(txt) : {}; } catch(_){}
          if (!r.ok) { var err = new Error((j && (j.error || j.message)) || ('HTTP '+r.status)); err.status = r.status; throw err; }
          return j;
        });});
    }

    var claimPromise = typedClaimId
      ? Promise.resolve(String(typedClaimId).replace(/\D+/g,''))
      : (typedOrderId
          ? searchClaimsByOrder(String(typedOrderId).replace(/\D+/g,'')).then(pickLatestClaimId)
          : Promise.resolve(null));

    return claimPromise
      .then(function(claimId){
        if (!claimId) throw Object.assign(new Error('Sem claim para enriquecer'), {status:404});
        return enrichedFetchByClaim(claimId).then(function(j){ return { claimId: claimId, payload: j }; });
      })
      .then(function(res){
        var j = res.payload || {};

        // >>> aplicar status/flow/motivo/shipments do enriched (com lock)
        applyEnrichedReturnPayload(j);

        try {
          var anyOrder = (j.orders && j.orders[0]) || null;
          var ordMeta = anyOrder ? { id: anyOrder.order_id, seller: anyOrder.seller } : null;
          fillMlSummary({ order: ordMeta, return_cost: j.return_cost });
        } catch(_){}

        var product = null;
        if (Array.isArray(j.orders) && j.orders.length) {
          product = j.orders.reduce(function(acc, o){
            var p = (o.total_paid != null ? toNum(o.total_paid) : toNum(o.unit_price) * toNum(o.quantity || 1));
            return acc + (isFinite(p) ? p : 0);
          }, 0);
        }
        var freight = (j.return_cost && j.return_cost.amount != null) ? toNum(j.return_cost.amount) : null;

        var ip = getFirst(['#valor_produto','#produto_valor','input[name="valor_produto"]','.js-valor-produto']);
        var ifr = getFirst(['#valor_frete','#frete_valor','input[name="valor_frete"]','.js-valor-frete']);
        var changed = false;
        if (product !== null && toNum(product) !== toNum(current.valor_produto)) { current.valor_produto = toNum(product); if (ip && ip.dataset.dirty!=='1')  { ip.value  = String(current.valor_produto); changed = true; } }
        if (freight !== null && toNum(freight) !== toNum(current.valor_frete))   { current.valor_frete   = toNum(freight); if (ifr && ifr.dataset.dirty!=='1'){ ifr.value = String(current.valor_frete);   changed = true; } }

        if (changed) {
          recalc(); updateSummary(Object.assign({}, current, capture()));
          toast('Valores do ML ' + (reason === 'auto' ? '(auto) ' : '') + 'aplicados', 'success');
        } else {
          toast('ML não trouxe valores. Tentando pelo pedido…', 'warning');
        }

        var amountsPatch = {};
        if (product !== null) amountsPatch.valor_produto = toNum(product);
        if (freight !== null) amountsPatch.valor_frete   = toNum(freight);
        if ((current.id || returnId) && Object.keys(amountsPatch).length) {
          fetch('/api/returns/' + encodeURIComponent(current.id || returnId), {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.assign({}, amountsPatch, { updated_by: 'frontend-auto-enrich' }))
          }).catch(function(){});
        }

        tryFetchClaimDetails(res.claimId);
        fetchAndApplyReturnCost(res.claimId, { persist: true });

        var orderId = readFirst(ORDER_ID_SELECTORS) || (j.orders && j.orders[0] && j.orders[0].order_id) || (current.raw && (current.raw.order_id || current.raw.resource_id));
        if (needsEnrichment(Object.assign({}, current, capture()))) {
          return orderId ? fetchOrderInfo(orderId).then(function(ord){ if (ord) return applyOrderToUi(ord, {persist:true}); }) : null;
        }
      })
      .then(function(){ if (hasLocalRow) return reloadCurrent(); })
      .catch(function (e) {
        // 429/403/404 → fallback via pedido
        if (e && (e.status === 429 || e.status === 403)) toast('Limite do ML (429/403). Usando fallback do pedido…', 'warning');
        var orderId = readFirst(ORDER_ID_SELECTORS) || qs.get('order_id') || (current.raw && (current.raw.order_id || current.raw.resource_id));
        if (orderId) {
          return fetchOrderInfo(String(orderId).replace(/\D+/g,''))
            .then(function(ord){
              if (ord) {
                return applyOrderToUi(ord, {persist:true}).then(function(){
                  return hasLocalRow ? reloadCurrent() : null;
                });
              }
            })
            .then(function(){ return ensureBuyerName({ persist:true }); })
            .catch(function(){});
        }
        if (e && e.status === 404) toast('Sem dados do ML para esta devolução.', 'warning');
        else if (e) toast(e.message || 'Falha no ML', 'error');
      })
      .then(function(){
        // garante nome mesmo após enrich
        return ensureBuyerName({ persist:true });
      })
      .then(function(){ setAutoHint(''); disableHead(false); });
  }

  /* =============== API local =============== */
  function normalizeAndSet(j){ var n = normalize(j); current = n; fill(n); if (qs.has('debug')) try{ console.debug('[devolucao-editar] raw->norm', j, n);}catch(e){} }
  function reloadCurrent(){
    if (!returnId) return Promise.resolve();
    return fetch('/api/returns/' + encodeURIComponent(returnId), { headers: { 'Accept': 'application/json' } })
      .then(function(r){
        if (r.status === 404) {
          current = { id: returnId };
          hasLocalRow = false;
          return Promise.reject(Object.assign(new Error('404'), { status: 404 }));
        }
        if (!r.ok) throw new Error('HTTP '+r.status);
        return r.json();
      })
      .then(function (j) {
        var data = (j && (j.data || j.item || j.return || j)) || j || {};
        hasLocalRow = true;
        normalizeAndSet(data);
      })
      .catch(function (e) {
        if (e && e.status === 404) return; // segue com enrich
        throw e;
      });
  }

  /* =============== Load =============== */
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
      })
      .catch(function(){})
      .then(function(){
        var needMotivoConvert = !!current.tipo_reclamacao && !/_/.test(String(current.tipo_reclamacao)) && current.tipo_reclamacao !== 'nao_corresponde';
        var podeML = lojaEhML(current.loja_nome) || parecePedidoML(current.id_venda) || !!readFirst(CLAIM_ID_SELECTORS) || !!qs.get('order_id') || !!qs.get('claim_id');

        if (needMotivoConvert) return enrichFromML('motivo');
        if (podeML && canEnrichNow() && needsEnrichment(current)) return enrichFromML('auto');
      })
      .then(function(){
        var ls = String(current.log_status || '').toLowerCase();
        if (ls === 'aprovado_cd' || ls === 'reprovado_cd') {
          var btnA=$('btn-insp-aprova'), btnR=$('btn-insp-reprova'); if (btnA && btnA.style) btnA.style.display='none'; if (btnR && btnR.style) btnR.style.display='none';
          var rqA2=$('rq-aprovar'), rqR2=$('rq-reprovar'); if (rqA2) rqA2.setAttribute('disabled','true'); if (rqR2) rqR2.setAttribute('disabled','true');
        }

        var cid = readFirst(CLAIM_ID_SELECTORS) || (current.raw && (current.raw.claim_id || current.raw.ml_claim_id));
        if (cid && !(current.raw && current.raw.claim)) tryFetchClaimDetails(cid);
        if (cid) fetchAndApplyReturnCost(String(cid), { persist: true });

        return hasLocalRow ? refreshTimeline(current.id || returnId) : null;
      })
      .then(function(){ return ensureBuyerName({ persist:true }); })
      .catch(function (e) {
        var cont=document.querySelector('.page-wrap'); if (cont) cont.innerHTML='<div class="card"><b>'+(e.message || 'Falha ao carregar.')+'</b></div>';
      });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load); else load();
})();
