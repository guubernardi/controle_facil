// /public/js/devolucao-editar.js — motivo por código/claim (sem enrich) + enrich ML; inclui PDD9944 → "Defeito de produção"
(function () {
  // ===== Helpers =====
  var $  = function (id) { return document.getElementById(id); };
  var qs = new URLSearchParams(location.search);
  var returnId = qs.get('id') || qs.get('return_id') || (location.pathname.split('/').pop() || '').replace(/\D+/g,'');

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

  function getLogPillEl() { return $('pill-log') || $('log_status_pill'); }
  function setLogPill(text) {
    var el = getLogPillEl(); if (!el) return;
    var s = String(text || '').toLowerCase();
    var cls = 'pill -neutro';
    if (!text) cls = 'pill -neutro';
    else if (s.indexOf('pend') >= 0) cls = 'pill -pendente';
    else if (s.indexOf('aprov') >= 0) cls = 'pill -aprovado';
    else if (s.indexOf('rej') >= 0 || s.indexOf('neg') >= 0 || s.indexOf('reprov') >= 0) cls = 'pill -rejeitado';
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
    if (st.indexOf('rej') >= 0 || st.indexOf('neg') >= 0) return 0;
    if (mot.indexOf('cliente') >= 0) return 0;
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

  // ---- motivoFromAny: pega motivo de vários lugares (inclui claim/claims[]) ----
  function motivoFromAny(j){
    if (!j || typeof j !== 'object') return null;
    var c0 = Array.isArray(j.claims) && j.claims.length ? j.claims[0] : (j.claim || null);

    function pick(){
      for (var i=0;i<arguments.length;i++){
        var v = arguments[i];
        if (v !== undefined && v !== null && String(v).trim() !== '') return v;
      }
      return null;
    }

    var byText = pick(
      j.tipo_reclamacao, j.reclamacao, j.motivo, j.motivo_cliente,
      j.reason_name, (j.reason && j.reason.name), j.reason, j.reason_description
    );
    if (byText) return byText;

    var byCode = pick(
      j.reason_code, j.sub_reason_code, j.substatus, j.reason_id,
      (j.reason && (j.reason.code || j.reason.id)),
      c0 && (c0.reason_code || c0.sub_reason_code || c0.substatus || c0.reason_id),
      (c0 && c0.reason && (c0.reason.code || c0.reason.id))
    );
    if (byCode) return byCode;

    var byClaimText = pick(
      c0 && (c0.reason_name || (c0.reason && (c0.reason.name || c0.reason.description)))
    );
    return byClaimText;
  }

  // ==== Motivo: utils de mapeamento/lock ====
  function stripAcc(s){ try { return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,''); } catch(_) { return String(s||''); } }
  function norm(s){ return stripAcc(String(s||'').toLowerCase().replace(/[^\w\s]/g,' ').replace(/\s+/g,' ').trim()); }

  function labelFromReasonKey(key){
    switch(String(key||'').toLowerCase()){
      case 'cliente_arrependimento': return 'Cliente: arrependimento';
      case 'cliente_endereco_errado': return 'Cliente: endereço errado';
      case 'produto_defeito':        return 'Produto com defeito';
      case 'avaria_transporte':      return 'Avaria no transporte';
      case 'pedido_incorreto':       return 'Pedido incorreto';
      default: return '';
    }
  }
  function ensureMotivoOption(selectEl, label){
    if (!selectEl || !label) return;
    var wanted = norm(label);
    for (var i=0;i<selectEl.options.length;i++){
      var opt = selectEl.options[i];
      if (norm(opt.text) === wanted || norm(opt.value) === wanted) return;
    }
    var o = document.createElement('option');
    o.text = label; o.value = label;
    selectEl.appendChild(o);
  }
  function selectMotivoLabel(sel, label){
    if (!sel || !label) return false;
    ensureMotivoOption(sel, label);
    var ok = false, wanted = norm(label);
    for (var i=0;i<sel.options.length;i++){
      var opt = sel.options[i];
      if (norm(opt.text) === wanted || norm(opt.value) === wanted){ sel.value = opt.value; ok = true; break; }
    }
    if (!ok) sel.value = label;
    sel.dispatchEvent(new Event('change'));
    return true;
  }
  function mapMotivoLabel(text){
    var t = norm(text);
    if (!t) return '';
    if (/(arrepend|nao serv|não serv|mudou de ideia|compra errad|tamanho|size|cor|color)/.test(t))
      return 'Cliente: arrependimento';
    if (/(endereco|endereço|address|ausencia|ausência|receptor)/.test(t))
      return 'Cliente: endereço errado';
    if (/(defeit|avari|quebrad|danific|faltand|incomplet)/.test(t))
      return 'Produto com defeito';
    if (/(transporte|logistic|logistica|shipping damage|avaria no transporte)/.test(t))
      return 'Avaria no transporte';
    if (/(pedido incorret|produto errad|item errad|sku incorret|wrong item)/.test(t))
      return 'Pedido incorreto';
    return text || '';
  }
  function setMotivoFromText(text, opts){
    opts = opts || {};
    var sel = $('tipo_reclamacao'); if (!sel) return false;
    if (!sel.__lockBound){
      sel.addEventListener('change', function(){ lockMotivo(false); });
      sel.__lockBound = true;
    }
    var label = mapMotivoLabel(text || '');
    if (!label) return false;
    var ok = selectMotivoLabel(sel, label);
    if (ok && opts.lock) lockMotivo(true, '(ML)');
    return ok;
  }
  function lockMotivo(lock, hint){
    var sel = $('tipo_reclamacao'); if (!sel) return;
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

  // ==== CÓDIGOS → RÓTULOS ====
  function isReasonCode(v){ return /^[A-Z]{2,}\d{3,}$/i.test(String(v||'').trim()); }
  var CODE_TO_LABEL = {
    'PDD9939': 'Pedido incorreto',
    'PDD9904': 'Produto com defeito',
    'PDD9905': 'Avaria no transporte',
    'PDD9906': 'Cliente: arrependimento',
    'PDD9907': 'Cliente: endereço errado',
    'PDD9944': 'Defeito de produção'
  };
  function labelFromCode(code){
    return CODE_TO_LABEL[String(code||'').toUpperCase()] || null;
  }

  // Extrai rótulo de um payload do ML (código → key → texto)
  function reasonLabelFromMLPayload(j){
    if (!j || typeof j !== 'object') return null;
    var c0 = Array.isArray(j.claims) && j.claims.length ? j.claims[0] : (j.claim || null);

    var codes = [
      j.tipo_reclamacao, j.reason_code, j.reason_id, j.sub_reason_code, j.substatus,
      (j.reason && (j.reason.code || j.reason.id)),
      c0 && (c0.reason_code || c0.reason_id || c0.sub_reason_code || c0.substatus),
      (c0 && c0.reason && (c0.reason.code || c0.reason.id))
    ].filter(Boolean);

    for (var i=0;i<codes.length;i++){
      if (isReasonCode(codes[i])) {
        var lbl = labelFromCode(codes[i]); if (lbl) return lbl;
      }
    }

    var key = j.reason_key || (c0 && c0.reason_key);
    if (key) {
      var byKey = labelFromReasonKey(key);
      if (byKey) return byKey;
    }

    var txt = j.reason_name || (j.reason && (j.reason.name || j.reason.description)) ||
              (c0 && (c0.reason_name || (c0.reason && (c0.reason.name || c0.reason.description))));
    if (txt) return mapMotivoLabel(txt) || txt;
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

    // >>> motivo robusto
    var motivo = motivoFromAny(j);

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
      tipo_reclamacao: motivo, // <<< já pode vir código ou texto
      nfe_numero:   firstNonEmpty(j.nfe_numero, j.invoice_number),
      nfe_chave:    firstNonEmpty(j.nfe_chave, j.invoice_key),
      reclamacao:   firstNonEmpty(j.reclamacao, j.obs, j.observacoes, j.observacao),
      valor_produto: toNum(vpRaw),
      valor_frete:   toNum(vfRaw),
      log_status:    logAtual,
      cd_recebido_em: recebCdEm,
      cd_responsavel: recebResp
    };
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
    return {
      id_venda:        $('id_venda') ? $('id_venda').value.trim() : null,
      cliente_nome:    $('cliente_nome') ? $('cliente_nome').value.trim() : null,
      loja_nome:       $('loja_nome') ? $('loja_nome').value.trim() : null,
      data_compra:     $('data_compra') ? $('data_compra').value : null,
      status:          $('status') ? $('status').value : null,
      sku:             $('sku') ? $('sku').value.trim() : null,
      tipo_reclamacao: $('tipo_reclamacao') ? $('tipo_reclamacao').value : null,
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
    var eProd=$('ml-prod'), eFrete=$('ml-frete'), eTotal=$('ml-total');
    if (eProd)  eProd.textContent  = moneyBRL(d.valor_produto);
    if (eFrete) eFrete.textContent = moneyBRL(d.valor_frete);
    if (eTotal) eTotal.textContent = moneyBRL(calcTotalByRules(d));
    updateSummary(Object.assign({}, current, d));
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
    return (first.seller_sku || first.variation_sku || it.seller_sku || it.sku || it.id || null);
  }
  function applyIfEmpty(acc, field, value){ if (value == null || value === '') return acc; var cur=current[field]; if (cur == null || String(cur).trim() === '') { acc[field] = value; } return acc; }

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
      .then(function (j) {
        // ---- Valores (produto/frete) ----
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

        // ---- Dados do pedido (vazios) ----
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

        // ---- Motivo (PRIORIDADE: código → key → nome) ----
        var finalLabel = reasonLabelFromMLPayload(j);
        if (finalLabel) {
          setMotivoFromText(finalLabel, { lock:true });
          patch.tipo_reclamacao = finalLabel; // persistir rótulo amigável
        }

        // ---- Log sugerido (pré/transporte/recebido) ----
        var logHint = j.log_status_suggested || null;
        if (logHint) {
          var lsNow = String(current.log_status || '').toLowerCase();
          if (!lsNow || lsNow === 'nao_recebido' || lsNow === 'não_recebido') {
            current.log_status = logHint;
            setLogPill(logHint);
          }
        }

        // Reflete na UI
        if (Object.keys(patch).length) {
          if (patch.id_venda && $('id_venda')) $('id_venda').value = patch.id_venda;
          if (patch.cliente_nome && $('cliente_nome')) $('cliente_nome').value = patch.cliente_nome;
          if (patch.loja_nome && $('loja_nome')) $('loja_nome').value = patch.loja_nome;
          if (patch.data_compra && $('data_compra')) $('data_compra').value = patch.data_compra;
          if (patch.sku && $('sku')) $('sku').value = patch.sku;
          current = Object.assign({}, current, patch);
          recalc();
        }

        // ---- Evento + PATCH (inclui valores) ----
        var persistEvent = fetch(persistUrl, { method: 'POST' }).catch(function(){});
        var amountsPatch = {};
        if (product !== null) amountsPatch.valor_produto = toNum(product);
        if (freight !== null) amountsPatch.valor_frete   = toNum(freight);

        var persistPatch = Promise.resolve();
        if (Object.keys(patch).length || Object.keys(amountsPatch).length || logHint) {
          var body = Object.assign({}, patch, amountsPatch, (logHint ? { log_status: current.log_status } : {}), { updated_by: 'frontend-auto-enrich' });
          persistPatch = fetch('/api/returns/' + encodeURIComponent(current.id || returnId), {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
          }).catch(function(){});
        }
        return Promise.all([persistEvent, persistPatch]);
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
      .then(function(res){ if (!res.ok) throw new Error('HTTP '+res.status); return res.json(); })
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

  // ===== Listeners =====
  function disableHead(disabled){
    ['btn-salvar','btn-enrich','btn-insp-aprova','btn-insp-reprova','rq-receber','rq-aprovar','rq-reprovar']
      .forEach(function(id){ var el=$(id); if (el) el.disabled = !!disabled; });
  }
  ['valor_produto','valor_frete','status','tipo_reclamacao'].forEach(function(id){
    var el=$(id); if (!el) return; el.addEventListener('input', recalc); if (el.tagName === 'SELECT') el.addEventListener('change', recalc);
  });
  var btnIA=$('btn-insp-aprova'), btnIR=$('btn-insp-reprova');
  if (btnIA) btnIA.addEventListener('click', function(){ openInspectDialog('aprovado'); });
  if (btnIR) btnIR.addEventListener('click', function(){ openInspectDialog('rejeitado'); });
  var rqA=$('rq-aprovar'), rqR=$('rq-reprovar');
  if (rqA) rqA.addEventListener('click', function(){ openInspectDialog('aprovado'); });
  if (rqR) rqR.addEventListener('click', function(){ openInspectDialog('rejeitado'); });
  var btnSalvar=$('btn-salvar'); if (btnSalvar) btnSalvar.addEventListener('click', save);
  var btnEnrich=$('btn-enrich'); if (btnEnrich) btnEnrich.addEventListener('click', function(){ enrichFromML('manual'); });

  // ===== Load inicial =====
  function applyMotivoFromCurrentRawIfEmpty(){
    var sel = $('tipo_reclamacao'); if (!sel) return;
    if (sel.value && sel.value.trim() !== '') return; // já tem
    var lbl = reasonLabelFromMLPayload(current.raw || {}) || current.tipo_reclamacao;
    if (!lbl) return;
    if (isReasonCode(lbl)) {
      var mapped = labelFromCode(lbl);
      if (mapped) lbl = mapped;
    }
    setMotivoFromText(lbl, { lock:true });
  }

  function load(){
    if (!returnId) {
      var cont=document.querySelector('.page-wrap'); if (cont) cont.innerHTML='<div class="card"><b>ID não informado.</b></div>'; return;
    }
    reloadCurrent()
      .then(function(){
        // tenta preencher motivo mesmo SEM enrich (ex.: veio só o código)
        applyMotivoFromCurrentRawIfEmpty();

        var needMotivoConvert = !!(current.tipo_reclamacao && isReasonCode(current.tipo_reclamacao));
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
        return current.id ? refreshTimeline(current.id) : null;
      })
      .catch(function (e) {
        var cont=document.querySelector('.page-wrap'); if (cont) cont.innerHTML='<div class="card"><b>'+(e.message || 'Falha ao carregar.')+'</b></div>';
      });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load); else load();
})();
