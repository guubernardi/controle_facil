// /js/devolucao-editar.js  — versão compatível ES2017 e com normalização reforçada
(function () {
  // ===== Helpers =====
  var $  = function (id) { return document.getElementById(id); };
  var qs = new URLSearchParams(location.search);
  var returnId = qs.get('id') || qs.get('return_id') || (location.pathname.split('/').pop() || '').replace(/\D+/g,'');

  function toNum(v) {
    if (v === null || v === undefined || v === '') return 0;
    if (typeof v === 'string') {
      // remove separador de milhar . e troca vírgula decimal por ponto
      v = v.replace(/\./g, '').replace(',', '.');
    }
    var n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  }
  function moneyBRL(v) {
    return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }
  function toast(msg, type) {
    type = type || 'info';
    var t = $('toast');
    if (!t) { alert(msg); return; }
    t.className = 'toast ' + type;
    t.textContent = msg;
    requestAnimationFrame(function () {
      t.classList.add('show');
      setTimeout(function () { t.classList.remove('show'); }, 3000);
    });
  }
  function setAutoHint(txt){ var el = $('auto-hint'); if (el) el.textContent = txt || ''; }

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
  function setCdInfo(opts) {
    opts = opts || {};
    var receivedAt = opts.receivedAt || null;
    var responsavel = opts.responsavel || null;

    var pill = $('pill-cd');
    var resp = $('cd-resp');
    var when = $('cd-when');
    var sep  = $('cd-sep');
    if (!pill) return;

    if (!receivedAt) {
      pill.className = 'pill -neutro';
      pill.textContent = 'Não recebido';
      if (resp) resp.hidden = true;
      if (when) when.hidden = true;
      if (sep)  sep.hidden  = true;
      return;
    }

    pill.className = 'pill -aprovado';
    pill.textContent = 'Recebido no CD';
    if (resp) { resp.textContent = 'Resp.: ' + (responsavel || 'cd'); resp.hidden = false; }
    if (when) {
      var dt = new Date(receivedAt);
      when.textContent = 'Quando: ' + (isNaN(dt) ? receivedAt : dt.toLocaleString('pt-BR'));
      when.hidden = false;
    }
    if (sep) sep.hidden = false;
  }

  // ===== Regras de cálculo (frente) =====
  function calcTotalByRules(d) {
    var st   = String(d.status || '').toLowerCase();
    var mot  = String(d.tipo_reclamacao || d.reclamacao || '').toLowerCase();
    var lgs  = String(d.log_status || '').toLowerCase();
    var vp   = Number(d.valor_produto || 0);
    var vf   = Number(d.valor_frete || 0);

    if (st.indexOf('rej') >= 0 || st.indexOf('neg') >= 0) return 0;
    if (mot.indexOf('cliente') >= 0) return 0;
    if (lgs === 'recebido_cd' || lgs === 'em_inspecao') return vf;
    return vp + vf;
  }

  // ===== Normalização de payload =====
  function siteIdToName(siteId) {
    var map = { MLB:'Mercado Livre', MLA:'Mercado Livre', MLM:'Mercado Libre', MCO:'Mercado Libre', MPE:'Mercado Libre', MLC:'Mercado Libre', MLU:'Mercado Libre' };
    return map[siteId] || 'Mercado Livre';
  }
  function firstNonEmpty() {
    for (var i=0;i<arguments.length;i++) {
      var v = arguments[i];
      if (v !== undefined && v !== null && String(v).trim() !== '') return v;
    }
    return null;
  }
  function findWarehouseReceivedAt(j) {
    try {
      var sh = j.shipments || [];
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

  function normalize(j) {
    var sellerName =
      (j.seller && (j.seller.nickname || j.seller.name || j.seller.nickname || j.seller.nick_name)) ||
      j.seller_nickname || j.sellerNick || j.seller_nick || j.nickname ||
      j.seller_name || j.store_name || j.shop_name || null;

    var buyerName  =
      (j.buyer && (j.buyer.nickname || j.buyer.name)) ||
      j.cliente || j.cliente_nome || j.buyer_name || null;

    var dataCompra = firstNonEmpty(j.data_compra, j.order_date, j.date_created, j.paid_at, j.created_at);

    var motivo     = firstNonEmpty(
      j.tipo_reclamacao, j.reclamacao, j.reason_name, j.reason, j.reason_id,
      j.motivo, j.motivo_cliente
    );

    var logAtual   = firstNonEmpty(j.log_status, j.log, j.current_log, j.log_atual, j.status_log);

    var lojaNome   = firstNonEmpty(
      j.loja_nome, j.loja, sellerName, j.store_nickname, j.store_nick, j.seller_nickname, j.nickname,
      (j.site_id ? siteIdToName(j.site_id) : null)
    );

    var recebCdEm  = firstNonEmpty(j.cd_recebido_em, j.recebido_em, j.warehouse_received_at, findWarehouseReceivedAt(j));
    var recebResp  = firstNonEmpty(j.cd_responsavel, j.warehouse_responsavel, j.recebido_por);

    // valores — procurar em vários nomes possíveis
    var vpRaw = firstNonEmpty(
      j.valor_produto, j.valor_produtos, j.valor_item, j.produto_valor, j.valor, j.valor_total, j.total_produto,
      j.product_value, j.item_value, j.price, j.unit_price, j.amount_item, j.item_amount, j.amount, j.subtotal,
      j.refund_value, j.refund_amount
    );
    var vfRaw = firstNonEmpty(
      j.valor_frete, j.frete, j.shipping_value, j.shipping_cost, j.valor_envio, j.valorFrete, j.custo_envio,
      j.frete_valor, j.logistics_cost, j.logistic_cost, j.shipping_amount, j.amount_shipping
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
      cd_recebido_em: recebCdEm,
      cd_responsavel: recebResp
    };
  }

  // ===== Estado =====
  var current = {};

  // ===== Resumo (card) =====
  function updateSummary(d) {
    var rs = $('resumo-status');
    var rl = $('resumo-log');
    var rc = $('resumo-cd');
    var rp = $('resumo-prod');
    var rf = $('resumo-frete');
    var rt = $('resumo-total');

    if (rs) rs.textContent = d.status || '—';
    if (rl) rl.textContent = d.log_status || '—';
    if (rc) rc.textContent = d.cd_recebido_em ? 'recebido' : 'não recebido';
    if (rp) rp.textContent = moneyBRL(d.valor_produto || 0);
    if (rf) rf.textContent = moneyBRL(d.valor_frete || 0);
    if (rt) rt.textContent = moneyBRL(calcTotalByRules(d));
  }

  function capture() {
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

  function recalc() {
    var d = capture();
    var eProd  = $('ml-prod');
    var eFrete = $('ml-frete');
    var eTotal = $('ml-total');
    if (eProd)  eProd.textContent  = moneyBRL(d.valor_produto);
    if (eFrete) eFrete.textContent = moneyBRL(d.valor_frete);
    if (eTotal) eTotal.textContent = moneyBRL(calcTotalByRules(d));
    updateSummary(Object.assign({}, current, d));
  }

  function fill(d) {
    var dvId = $('dv-id');
    if (dvId) dvId.textContent = d.id ? ('#' + d.id) : '';

    if ($('id_venda'))         $('id_venda').value         = d.id_venda || '';
    if ($('cliente_nome'))     $('cliente_nome').value     = d.cliente_nome || '';
    if ($('loja_nome'))        $('loja_nome').value        = d.loja_nome || '';
    if ($('data_compra'))      $('data_compra').value      = d.data_compra ? String(d.data_compra).slice(0,10) : '';
    if ($('status'))           $('status').value           = d.status || '';
    if ($('sku'))              $('sku').value              = d.sku || '';
    if ($('tipo_reclamacao'))  $('tipo_reclamacao').value  = d.tipo_reclamacao || '';
    if ($('nfe_numero'))       $('nfe_numero').value       = d.nfe_numero || '';
    if ($('nfe_chave'))        $('nfe_chave').value        = d.nfe_chave || '';
    if ($('reclamacao'))       $('reclamacao').value       = d.reclamacao || '';
    if ($('valor_produto'))    $('valor_produto').value    = (d.valor_produto === null || d.valor_produto === undefined) ? '' : toNum(d.valor_produto);
    if ($('valor_frete'))      $('valor_frete').value      = (d.valor_frete  === null || d.valor_frete  === undefined) ? '' : toNum(d.valor_frete);

    setLogPill(d.log_status || '—');
    setCdInfo({ receivedAt: d.cd_recebido_em || null, responsavel: d.cd_responsavel || null });

    updateSummary(d);
    recalc();
  }

  function normalizeAndSet(j) {
    var n = normalize(j);
    current = n;
    try { console.debug('[devolucao-editar] raw->norm', j, n); } catch(e){}
    fill(n);
  }

  // ===== API =====
  function safeJson(res){ 
    if (!res.ok) return Promise.reject(new Error('HTTP ' + res.status));
    return res.json();
  }
  function reloadCurrent() {
    if (!returnId) return Promise.resolve();
    return fetch('/api/returns/' + encodeURIComponent(returnId))
      .then(safeJson)
      .then(function (j) {
        var data = (j && (j.data || j.item || j.return || j)) || {};
        normalizeAndSet(data);
      });
  }

  function save() {
    var body = capture();
    fetch('/api/returns/' + encodeURIComponent(current.id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({}, body, { updated_by: 'frontend' }))
    })
    .then(function (r) {
      if(!r.ok) return r.json().catch(function(){})
        .then(function(e){ throw new Error((e && e.error) || 'Falha ao salvar');});
    })
    .then(function(){ return reloadCurrent(); })
    .then(function(){ toast('Salvo!', 'success'); return refreshTimeline(current.id); })
    .catch(function(e){ toast(e.message || 'Erro ao salvar', 'error'); });
  }

  function runInspect(result, observacao) {
    disableHead(true);
    var when = new Date().toISOString();
    fetch('/api/returns/' + encodeURIComponent(current.id) + '/cd/inspect', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'inspect-' + current.id + '-' + when + '-' + result
      },
      body: JSON.stringify({ resultado: result, observacao: observacao || '', updated_by: 'frontend', when: when })
    })
    .then(function(r){ if(!r.ok) return r.json().catch(function(){}) .then(function(e){ throw new Error((e && e.error) || 'Falha na inspeção');}); })
    .then(function(){ return reloadCurrent(); })
    .then(function(){ toast('Inspeção registrada (' + result + ')!', 'success'); return refreshTimeline(current.id); })
    .catch(function(e){ toast(e.message || 'Erro', 'error'); })
    .then(function(){ disableHead(false); });
  }

  function openInspectDialog(result) {
    var dlg   = $('dlg-inspecao');
    var title = $('insp-title');
    var sub   = $('insp-sub');
    var txt   = $('insp-text');
    var btnOk = $('insp-confirm');
    var btnNo = $('insp-cancel');
    if (!dlg) return;

    var isApprove = result === 'aprovado';
    title.textContent = isApprove ? 'Aprovar inspeção' : 'Reprovar inspeção';
    sub.textContent   = isApprove
      ? 'Confirme a aprovação da inspeção. Você pode adicionar uma observação.'
      : 'Confirme a reprovação da inspeção. Você pode adicionar uma observação.';
    if (btnOk) btnOk.className = isApprove ? 'btn btn--success' : 'btn btn--danger';
    if (txt) txt.value = '';
    dlg.showModal();

    function onSubmit(ev) {
      ev.preventDefault();
      var obs = (txt && txt.value ? txt.value.trim() : '');
      dlg.close();
      runInspect(result, obs);
      cleanup();
    }
    function onCancel(){ dlg.close(); cleanup(); }
    function cleanup(){
      var form = $('insp-form');
      if (form) form.removeEventListener('submit', onSubmit);
      if (btnNo) btnNo.removeEventListener('click', onCancel);
    }
    var form = $('insp-form');
    if (form) form.addEventListener('submit', onSubmit);
    if (btnNo) btnNo.addEventListener('click', onCancel);
    setTimeout(function(){ if (txt) txt.focus(); }, 0);
  }

  function disableHead(disabled) {
    ['btn-salvar','btn-enrich','btn-insp-aprova','btn-insp-reprova','rq-receber','rq-aprovar','rq-reprovar']
      .forEach(function(id){ var el = $(id); if (el) el.disabled = !!disabled; });
  }

  // ===== ENRIQUECIMENTO (ML) =====
  var ENRICH_TTL_MS = 10 * 60 * 1000;
  function lojaEhML(nome) {
    var s = String(nome || '').toLowerCase();
    return s.indexOf('mercado') >= 0 || s.indexOf('meli') >= 0 || s.indexOf('ml') >= 0;
  }
  function parecePedidoML(pedido) { return /^\d{6,}$/.test(String(pedido || '')); }
  function needsEnrichment(d) {
    return !d || !d.id_venda || !d.sku || !d.cliente_nome || !d.loja_nome || !d.data_compra || !d.log_status;
  }
  function canEnrichNow() {
    var key = 'rf_enrich_' + returnId;
    var last = Number(localStorage.getItem(key) || 0);
    var ok = !last || (Date.now() - last) > ENRICH_TTL_MS;
    if (ok) localStorage.setItem(key, String(Date.now()));
    return ok;
  }
  function enrichFromML(reason) {
    reason = reason || 'auto';
    if (!current || !current.id) return Promise.resolve(false);
    disableHead(true); setAutoHint('(atualizando dados do ML…)');
    return Promise.resolve()
      .then(function(){ return fetch('/api/ml/claims/import?days=90&silent=1').catch(function(){}); })
      .then(function(){ 
        return fetch('/api/ml/returns/' + encodeURIComponent(current.id) + '/enrich', { method: 'POST' })
          .then(function(r){ if(!r.ok) throw new Error(); })
          .catch(function(){}); 
      })
      .then(function(){ return reloadCurrent(); })
      .then(function(){ toast(reason === 'auto' ? 'Dados atualizados automaticamente.' : 'Dados atualizados do ML.', 'success'); return true; })
      .catch(function(){ return false; })
      .then(function(v){ setAutoHint(''); disableHead(false); return v; });
  }

  // ==== Dialog Recebido no CD ====
  var btnRecebido = $('rq-receber');
  var dlgR = $('dlg-recebido');
  var inpResp = $('rcd-resp');
  var inpWhen = $('rcd-when');
  var btnSaveR = $('rcd-save');
  var btnUnset = $('rcd-unset');
  var rcdCancel = $('rcd-cancel');
  if (rcdCancel) rcdCancel.addEventListener('click', function(){ if (dlgR) dlgR.close(); });

  function pad(n){ return String(n).padStart(2,'0'); }

  if (btnRecebido) {
    btnRecebido.addEventListener('click', function () {
      var lastResp = localStorage.getItem('cd_responsavel') || '';
      if (inpResp) inpResp.value = lastResp;
      var now = new Date();
      if (inpWhen) {
        inpWhen.value = now.getFullYear() + '-' + pad(now.getMonth()+1) + '-' + pad(now.getDate()) +
                        'T' + pad(now.getHours()) + ':' + pad(now.getMinutes());
      }
      if (dlgR) dlgR.showModal();
    });
  }

  if (btnSaveR) {
    btnSaveR.addEventListener('click', function (ev) {
      ev.preventDefault();
      if (!returnId) return toast('ID da devolução não encontrado.', 'error');

      var responsavel = (inpResp && inpResp.value ? inpResp.value.trim() : '') || 'cd';
      localStorage.setItem('cd_responsavel', responsavel);

      var whenIso = new Date().toISOString();
      if (inpWhen && inpWhen.value) {
        var d = new Date(inpWhen.value);
        if (!isNaN(d)) whenIso = d.toISOString();
      }

      var headers = { 'Content-Type': 'application/json', 'Idempotency-Key': 'receive-' + returnId + '-' + Date.now() };
      fetch('/api/returns/' + encodeURIComponent(returnId) + '/cd/receive', {
        method: 'PATCH',
        headers: headers,
        body: JSON.stringify({ responsavel: responsavel, when: whenIso, updated_by: 'frontend' })
      })
      .then(function(r){ if(!r.ok) return r.json().catch(function(){ return { error:'Falha no PATCH'}; }).then(function(err){ throw new Error(err.error || 'Falha'); }); })
      .then(function(){ return reloadCurrent(); })
      .then(function(){ toast('Recebimento no CD atualizado!', 'success'); if (dlgR) dlgR.close(); return refreshTimeline(returnId); })
      .catch(function(e){ toast(e.message || 'Erro ao registrar recebimento.', 'error'); });
    });
  }

  if (btnUnset) {
    btnUnset.addEventListener('click', function () {
      if (!returnId) return toast('ID da devolução não encontrado.', 'error');

      var responsavel = (inpResp && inpResp.value ? inpResp.value.trim() : '') || 'cd';
      var whenIso = new Date().toISOString();
      if (inpWhen && inpWhen.value) {
        var d = new Date(inpWhen.value);
        if (!isNaN(d)) whenIso = d.toISOString();
      }

      var headers = { 'Content-Type': 'application/json', 'Idempotency-Key': 'unreceive-' + returnId + '-' + Date.now() };
      fetch('/api/returns/' + encodeURIComponent(returnId) + '/cd/unreceive', {
        method: 'PATCH',
        headers: headers,
        body: JSON.stringify({ responsavel: responsavel, when: whenIso, updated_by: 'frontend' })
      })
      .then(function(r){ if(!r.ok) return r.json().catch(function(){ return { error:'Falha no PATCH'}; }).then(function(err){ throw new Error(err.error || 'Falha'); }); })
      .then(function(){ return reloadCurrent(); })
      .then(function(){ toast('Marcação de recebido removida.', 'success'); if (dlgR) dlgR.close(); return refreshTimeline(returnId); })
      .catch(function(e){ toast(e.message || 'Erro ao remover marcação.', 'error'); });
    });
  }

  // ===== TIMELINE =====
  function fetchEvents(id, limit, offset) {
    limit = limit || 100; offset = offset || 0;
    var url = '/api/returns/' + encodeURIComponent(id) + '/events?limit=' + limit + '&offset=' + offset;
    return fetch(url).then(safeJson).then(function (j) {
      var arr = (j && j.items) || [];
      return Array.isArray(arr) ? arr : [];
    });
  }

  function fmtRel(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var diffMs = Date.now() - d.getTime();
    var abs = Math.abs(diffMs);
    var min = 60 * 1000, hr = 60 * min, day = 24 * hr;
    function s(n, u){ return n + ' ' + u + (n > 1 ? 's' : ''); }
    if (abs < hr)  return s(Math.round(abs / min) || 0, 'min') + (diffMs >= 0 ? ' atrás' : ' depois');
    if (abs < day) return s(Math.round(abs / hr),  'hora') + (diffMs >= 0 ? 's atrás' : 's depois');
    return d.toLocaleString('pt-BR');
  }

  function iconFor(type) {
    if (type === 'status') return '🛈';
    if (type === 'note')   return '📝';
    if (type === 'warn')   return '⚠️';
    if (type === 'error')  return '⛔';
    return '•';
  }

  function renderEvents(items) {
    var wrap   = $('events-list');
    var elLoad = $('events-loading');
    var elEmpty= $('events-empty');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (elLoad) elLoad.hidden = true;

    if (!items.length) { if (elEmpty) elEmpty.hidden = false; return; }
    if (elEmpty) elEmpty.hidden = true;

    var frag = document.createDocumentFragment();
    items.forEach(function (ev) {
      var type = String(ev.type || 'status').toLowerCase();
      var meta = ev.meta && typeof ev.meta === 'object' ? ev.meta : null;

      var item = document.createElement('article');
      item.className = 'tl-item -' + type;
      item.setAttribute('role', 'article');

      var created = ev.createdAt || ev.created_at || ev.created;
      var rel = created ? fmtRel(created) : '';

      item.innerHTML =
        '<span class="tl-dot" aria-hidden="true"></span>' +
        '<div class="tl-head">' +
          '<span class="tl-title">' + iconFor(type) + ' ' + (ev.title || (type === 'status' ? 'Status' : 'Evento')) + '</span>' +
          '<span class="tl-time" title="' + (created || '') + '">' + rel + '</span>' +
        '</div>' +
        (ev.message ? '<div class="tl-msg">' + ev.message + '</div>' : '') +
        '<div class="tl-meta"></div>';

      var metaBox = item.querySelector('.tl-meta');
      if (meta && meta.status)           metaBox.insertAdjacentHTML('beforeend','<span class="tl-badge">status: <b>'+ meta.status +'</b></span>');
      if (meta && meta.log_status)       metaBox.insertAdjacentHTML('beforeend','<span class="tl-badge">log: <b>'+ meta.log_status +'</b></span>');
      if (meta && meta.cd && meta.cd.responsavel)  metaBox.insertAdjacentHTML('beforeend','<span class="tl-badge">CD: '+ meta.cd.responsavel +'</span>');
      if (meta && meta.cd && meta.cd.receivedAt)   metaBox.insertAdjacentHTML('beforeend','<span class="tl-badge">recebido: '+ new Date(meta.cd.receivedAt).toLocaleString('pt-BR') +'</span>');
      if (meta && meta.cd && meta.cd.unreceivedAt) metaBox.insertAdjacentHTML('beforeend','<span class="tl-badge">removido: '+ new Date(meta.cd.unreceivedAt).toLocaleString('pt-BR') +'</span>');
      if (meta && meta.cd && meta.cd.inspectedAt)  metaBox.insertAdjacentHTML('beforeend','<span class="tl-badge">inspecionado: '+ new Date(meta.cd.inspectedAt).toLocaleString('pt-BR') +'</span>');

      frag.appendChild(item);
    });
    wrap.appendChild(frag);
  }

  function refreshTimeline(id) {
    var elLoad = $('events-loading');
    var elList = $('events-list');
    if (elLoad) elLoad.hidden = false;
    if (elList) elList.setAttribute('aria-busy','true');
    return fetchEvents(id, 100, 0)
      .then(renderEvents)
      .catch(function(){ renderEvents([]); })
      .then(function(){
        if (elLoad) elLoad.hidden = true;
        if (elList) elList.setAttribute('aria-busy','false');
      });
  }

  // ===== Keyboard shortcuts =====
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      save();
    }
  });

  // ===== Listeners =====
  ['valor_produto','valor_frete','status','tipo_reclamacao'].forEach(function(id){
    var el = $(id);
    if (!el) return;
    el.addEventListener('input', recalc);
    if (el.tagName === 'SELECT') el.addEventListener('change', recalc);
  });

  var btnIA = $('btn-insp-aprova');
  var btnIR = $('btn-insp-reprova');
  if (btnIA) btnIA.addEventListener('click', function(){ openInspectDialog('aprovado'); });
  if (btnIR) btnIR.addEventListener('click', function(){ openInspectDialog('rejeitado'); });

  var rqA = $('rq-aprovar');
  var rqR = $('rq-reprovar');
  if (rqA) rqA.addEventListener('click', function(){ openInspectDialog('aprovado'); });
  if (rqR) rqR.addEventListener('click', function(){ openInspectDialog('rejeitado'); });

  var btnSalvar = $('btn-salvar');
  if (btnSalvar) btnSalvar.addEventListener('click', save);

  var btnEnrich = $('btn-enrich');
  if (btnEnrich) btnEnrich.addEventListener('click', function(){ enrichFromML('manual'); });

  // ===== Load inicial =====
  function load() {
    if (!returnId) {
      var cont = document.querySelector('.page-wrap');
      if (cont) cont.innerHTML = '<div class="card"><b>ID não informado.</b></div>';
      return;
    }
    reloadCurrent()
      .then(function () {
        if ((lojaEhML(current.loja_nome) || parecePedidoML(current.id_venda)) && needsEnrichment(current) && canEnrichNow()) {
          return enrichFromML('auto');
        }
      })
      .then(function () {
        var ls = String(current.log_status || '').toLowerCase();
        if (ls === 'aprovado_cd' || ls === 'reprovado_cd') {
          var btnA = $('btn-insp-aprova');
          var btnR = $('btn-insp-reprova');
          if (btnA && btnA.style) btnA.style.display = 'none';
          if (btnR && btnR.style) btnR.style.display = 'none';
          var rqA2 = $('rq-aprovar');
          var rqR2 = $('rq-reprovar');
          if (rqA2) rqA2.setAttribute('disabled','true');
          if (rqR2) rqR2.setAttribute('disabled','true');
        }
        return refreshTimeline(current.id);
      })
      .catch(function (e) {
        var cont = document.querySelector('.page-wrap');
        if (cont) cont.innerHTML = '<div class="card"><b>' + (e.message || 'Falha ao carregar.') + '</b></div>';
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})();
