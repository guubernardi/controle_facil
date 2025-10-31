/* Chat ML – mensagens, mediação, evidências e reviews
 * Consome rotas do backend:
 * - GET /api/ml/claims/:claimId/messages                    (listar)                 [mlChat.js]
 * - POST /api/ml/claims/:claimId/attachments                (upload anexo)           [mlChat.js]
 * - GET /api/ml/claims/:claimId/attachments/:attId/download (download anexo)        [mlChat.js]
 * - POST /api/ml/claims/:claimId/messages                   (enviar)                 [mlChat.js]
 * - GET /api/ml/returns/by-claim/:claimId                   (detalhes return v2)     [mlChat.js]
 * - GET /api/ml/returns/:returnId/reviews                   (reviews)                [mlChat.js]
 * - POST /api/ml/returns/:returnId/return-review            (review OK/FAIL)         [mlChat.js]
 * - GET /api/ml/returns/reasons?flow=seller_return_failed&claim_id=… (motivos FAIL)  [mlChat.js]
 * - GET /api/ml/claims/:claimId/charges/return-cost         (custo retorno)          [mlChat.js ou ml-resolutions.js]
 * - GET /api/ml/claims/:claimId/affects-reputation          (atinge reputação)       [ml-resolutions.js]
 * - POST /api/ml/claims/:claimId/actions/open-dispute       (abrir mediação)         [ml-resolutions.js]
 * - POST /api/ml/claims/:claimId/expected-resolutions/allow-return  (autorizar)      [ml-resolutions.js]
 * - POST /api/ml/claims/:claimId/expected-resolutions/refund        (reembolso)      [ml-resolutions.js]
 * - POST /api/ml/claims/:claimId/expected-resolutions/partial-refund {percentage}    [ml-resolutions.js]
 * - GET /api/ml/claims/:claimId/evidences                   (listar evidências)      [ml-resolutions.js]
 * - POST /api/ml/claims/:claimId/attachments-evidences      (upload evidência)       [ml-resolutions.js]
 */

(() => {
  const $ = (id) => document.getElementById(id);
  const qs = new URLSearchParams(location.search);

  // elementos
  const el = {
    claimId: $('claimId'),
    sellerToken: $('sellerToken'),
    btnLoad: $('btnLoad'),
    btnSaveTok: $('btnSaveTok'),
    messages: $('messages'),
    receiverRole: $('receiverRole'),
    msgText: $('msgText'),
    fileInput: $('fileInput'),
    btnSend: $('btnSend'),
    uploadPreview: $('uploadPreview'),
    sendHint: $('sendHint'),
    mediationBadge: $('mediationBadge'),
    affects: $('affects'),
    claimStatus: $('claimStatus'),
    claimSubstatus: $('claimSubstatus'),
    returnCost: $('returnCost'),
    // actions
    btnOpenDispute: $('btnOpenDispute'),
    btnAllowReturn: $('btnAllowReturn'),
    btnRefund: $('btnRefund'),
    partialPct: $('partialPct'),
    btnPartial: $('btnPartial'),
    evidences: $('evidences'),
    btnUpEvidence: $('btnUpEvidence'),
    evidenceFile: $('evidenceFile'),
    btnRefreshEvd: $('btnRefreshEvd'),
    returnsBox: $('returnsBox'),
    btnRefreshReturns: $('btnRefreshReturns'),
    reviewBox: $('reviewBox'),
    btnReviewOK: $('btnReviewOK'),
    btnReviewFAIL: $('btnReviewFAIL'),
    failReason: $('failReason'),
    toast: $('toast'),
  };

  // estado
  let state = {
    claimId: null,
    pendingAttachments: [],  // filenames retornados pelo upload (para enviar na próxima msg)
    returnId: null,
    reasons: [],             // motivos fail
  };

  // helpers
  function toast(msg) {
    if (!el.toast) return alert(msg);
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    setTimeout(() => el.toast.classList.remove('show'), 2400);
  }
  function headers() {
    const h = { 'Accept': 'application/json' };
    const token = (el.sellerToken.value || '').trim();
    if (token) h['x-seller-token'] = token;
    return h;
  }
  function api(url, opt={}) {
    const o = Object.assign({ headers: headers() }, opt);
    if (o.body && !(o.body instanceof FormData)) {
      o.headers['Content-Type'] = 'application/json';
      o.body = JSON.stringify(o.body);
    }
    return fetch(url, o).then(async r => {
      const isJSON = (r.headers.get('content-type') || '').includes('application/json');
      const data = isJSON ? await r.json().catch(()=> ({})) : await r.text();
      if (!r.ok) throw new Error((data && (data.error || data.message)) || `HTTP ${r.status}`);
      return data;
    });
  }
  function pickMessagesPayload(j){
    if (!j) return [];
    if (Array.isArray(j)) return j;
    return j.messages || j.results || j.data || j.items || [];
  }
  function when(iso){
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString('pt-BR');
  }
  function roleBadge(role){
    const r = String(role||'').toLowerCase();
    if (r.includes('mediator')) return 'Mediador';
    if (r.includes('complain')) return 'Comprador';
    if (r.includes('respond')) return 'Vendedor';
    return role || '—';
  }

  // mensagens
  async function loadMessages() {
    const id = state.claimId;
    el.messages.innerHTML = '<div class="hint">Carregando mensagens…</div>';
    const j = await api(`/api/ml/claims/${encodeURIComponent(id)}/messages`);
    const arr = pickMessagesPayload(j);
    if (!arr.length) {
      el.messages.innerHTML = '<div class="hint">Sem mensagens.</div>';
      el.mediationBadge.textContent = 'Mediação: —';
      return;
    }
    const frag = document.createDocumentFragment();
    let hasMediator = false;
    arr.forEach(m => {
      const who = m.from?.role || m.sender?.role || m.role || '';
      if ((who||'').toLowerCase().includes('mediator')) hasMediator = true;

      const me = /respond/.test(String(who||'').toLowerCase());
      const box = document.createElement('div');
      box.className = 'msg' + (me ? ' me' : '');
      box.innerHTML = `
        <div class="meta">
          <span class="pill">${roleBadge(who)}</span>
          <span>${when(m.date_created || m.created_at || m.date || m.updated_at)}</span>
        </div>
        <div class="text">${(m.message || m.text || '').replace(/\n/g,'<br>')}</div>
      `;

      // anexos
      const atts = Array.isArray(m.attachments) ? m.attachments
                   : Array.isArray(m.files) ? m.files : [];
      if (atts.length) {
        const row = document.createElement('div');
        row.className = 'attachments';
        atts.forEach(a => {
          const id = a.id || a.attachment_id || a.file_name || a.filename || a.name;
          const label = a.original_filename || a.filename || a.file_name || id || 'arquivo';
          const elA = document.createElement('a');
          elA.href = `/api/ml/claims/${encodeURIComponent(state.claimId)}/attachments/${encodeURIComponent(id)}/download`;
          elA.target = '_blank';
          elA.rel = 'noopener';
          elA.className = 'attachment';
          elA.innerHTML = `📎 <span>${label}</span>`;
          row.appendChild(elA);
        });
        box.appendChild(row);
      }
      frag.appendChild(box);
    });
    el.messages.innerHTML = '';
    el.messages.appendChild(frag);
    el.mediationBadge.textContent = `Mediação: ${hasMediator ? 'ATIVA' : '—'}`;
  }

  async function uploadSelectedFiles() {
    const files = Array.from(el.fileInput.files || []);
    if (!files.length) return [];
    el.uploadPreview.hidden = false;
    el.uploadPreview.innerHTML = '';
    const out = [];
    for (const f of files) {
      const fd = new FormData();
      fd.append('file', f, f.name);
      const j = await fetch(`/api/ml/claims/${encodeURIComponent(state.claimId)}/attachments`, {
        method: 'POST',
        body: fd,
        headers: headers() // não setar content-type manualmente; o browser faz
      }).then(r => r.json());
      if (j.error) throw new Error(j.error);
      const fname = j.filename || j.file_name;
      out.push(fname);
      const chip = document.createElement('span');
      chip.className = 'attachment';
      chip.textContent = fname;
      el.uploadPreview.appendChild(chip);
    }
    state.pendingAttachments.push(...out);
    return out;
  }

  async function sendMessage() {
    const role = el.receiverRole.value;
    const text = (el.msgText.value || '').trim();
    if (!text) return toast('Escreva uma mensagem.');
    el.btnSend.disabled = true;
    el.sendHint.textContent = 'Enviando…';
    try {
      // sobe anexos (se houver)
      if (el.fileInput.files?.length) await uploadSelectedFiles();

      await api(`/api/ml/claims/${encodeURIComponent(state.claimId)}/messages`, {
        method: 'POST',
        body: {
          receiver_role: role,
          message: text,
          attachments: state.pendingAttachments.length ? state.pendingAttachments : undefined
        }
      });
      el.msgText.value = '';
      el.fileInput.value = '';
      state.pendingAttachments = [];
      el.uploadPreview.hidden = true;
      el.uploadPreview.innerHTML = '';
      toast('Mensagem enviada!');
      await loadMessages();
    } catch (e) {
      toast(e.message || 'Falha ao enviar');
    } finally {
      el.btnSend.disabled = false;
      el.sendHint.textContent = '';
    }
  }

  // status & ações
  async function loadAffects() {
    try {
      const j = await api(`/api/ml/claims/${encodeURIComponent(state.claimId)}/affects-reputation`);
      const val = j.ok ? j.data?.affects_reputation : j.affects_reputation;
      el.affects.textContent = `Atinge reputação: ${val ? 'SIM' : 'NÃO'}`;
    } catch { el.affects.textContent = 'Atinge reputação: —'; }
  }
  async function loadReturnCost() {
    try {
      const j = await api(`/api/ml/claims/${encodeURIComponent(state.claimId)}/charges/return-cost`);
      const amt = j?.amount ?? j?.data?.amount ?? null;
      el.returnCost.textContent = (amt != null) ? amt.toLocaleString('pt-BR', { style:'currency', currency:'BRL' }) : '—';
    } catch { el.returnCost.textContent = '—'; }
  }
  // como ainda não temos uma rota de "claim detail" pura neste módulo,
  // inferimos status/substatus pelos próprios objetos retornados de endpoints vizinhos quando possível
  function setClaimStatus(status, substatus) {
    if (status) el.claimStatus.textContent = status;
    if (substatus) el.claimSubstatus.textContent = substatus;
  }

  // evidências
  async function loadEvidences() {
    el.evidences.innerHTML = '<li class="hint">Carregando…</li>';
    try {
      const j = await api(`/api/ml/claims/${encodeURIComponent(state.claimId)}/evidences`);
      const arr = Array.isArray(j?.data) ? j.data : (Array.isArray(j) ? j : []);
      if (!arr.length) { el.evidences.innerHTML = '<li class="hint">Sem evidências.</li>'; return; }
      el.evidences.innerHTML = '';
      arr.forEach(ev => {
        const li = document.createElement('li');
        li.className = 'row';
        const atts = Array.isArray(ev.attachments) ? ev.attachments : [];
        li.innerHTML = `
          <span class="pill">${ev.type || 'evidence'}</span>
          <span class="hint">${when(ev.date || ev.created_at || '')}</span>
        `;
        if (atts.length) {
          const wrap = document.createElement('div');
          wrap.className = 'attachments';
          atts.forEach(a => {
            const id = a.id || a.attachment_id || a.file_name || a.filename || a.name;
            const label = a.original_filename || a.filename || a.file_name || id || 'arquivo';
            const link = document.createElement('a');
            link.href = `/api/ml/claims/${encodeURIComponent(state.claimId)}/attachments-evidences/${encodeURIComponent(id)}/download`;
            link.target = '_blank';
            link.rel = 'noopener';
            link.className = 'attachment';
            link.innerHTML = `📎 ${label}`;
            wrap.appendChild(link);
          });
          li.appendChild(wrap);
        }
        el.evidences.appendChild(li);
      });
    } catch (e) {
      el.evidences.innerHTML = `<li class="hint">Erro: ${e.message || e}</li>`;
    }
  }
  async function uploadEvidence() {
    const f = el.evidenceFile.files?.[0];
    if (!f) return toast('Escolha um arquivo.');
    const fd = new FormData();
    fd.append('file', f, f.name);
    try {
      await fetch(`/api/ml/claims/${encodeURIComponent(state.claimId)}/attachments-evidences`, {
        method: 'POST', body: fd, headers: headers()
      }).then(r => r.json()).then(j => { if (j.ok === false || j.error) throw new Error(j.error || 'Falha no upload'); });
      toast('Evidência anexada!');
      el.evidenceFile.value = '';
      loadEvidences();
    } catch (e) {
      toast(e.message || 'Falha ao anexar evidência');
    }
  }

  // returns & reviews
  async function loadReturnsAndReviews() {
    el.returnsBox.innerHTML = '<div class="hint">Carregando retornos…</div>';
    try {
      const j = await api(`/api/ml/returns/by-claim/${encodeURIComponent(state.claimId)}`);
      // respostas possíveis: { returns:[{id,status,...}], ... } ou array direto
      const arr = Array.isArray(j?.returns) ? j.returns : (Array.isArray(j) ? j : j?.data || []);
      if (!arr.length) {
        el.returnsBox.innerHTML = '<div class="hint">Sem retornos vinculados.</div>';
        el.reviewBox.hidden = true;
        state.returnId = null;
        return;
      }
      const ret = arr[0];
      state.returnId = ret.id || ret.return_id || null;
      setClaimStatus(ret.claim_status || ret.status || null, ret.substatus || null);

      el.returnsBox.innerHTML = `
        <div class="card">
          <div class="row"><span class="subtitle">Return ID:</span> <b>${state.returnId || '—'}</b></div>
          <div class="row"><span class="subtitle">Status do retorno:</span> <span>${ret.status || '—'}</span></div>
          <div class="row"><span class="subtitle">Última atualização:</span> <span>${when(ret.last_updated || ret.updated_at || '')}</span></div>
        </div>
      `;

      // reviews atuais
      const rev = await api(`/api/ml/returns/${encodeURIComponent(state.returnId)}/reviews`);
      const items = Array.isArray(rev?.reviews) ? rev.reviews : (Array.isArray(rev) ? rev : rev?.data || []);
      const list = document.createElement('div');
      list.className = 'list';
      list.innerHTML = `<div class="subtitle">Reviews atuais</div>`;
      if (!items.length) list.innerHTML += `<div class="hint">Nenhum review registrado.</div>`;
      items.forEach(r => {
        const row = document.createElement('div');
        row.className = 'row';
        row.innerHTML = `
          <span class="pill">${r?.status || '—'}</span>
          <span class="hint">${r?.reason_id || ''}</span>
          <span class="hint">${(r?.message || '').slice(0,120)}</span>
        `;
        list.appendChild(row);
      });
      el.returnsBox.appendChild(list);

      // motivos para FAIL
      const rs = await api(`/api/ml/returns/reasons?flow=seller_return_failed&claim_id=${encodeURIComponent(state.claimId)}`);
      const reasons = Array.isArray(rs?.reasons) ? rs.reasons : (Array.isArray(rs) ? rs : rs?.data || []);
      state.reasons = reasons;
      el.failReason.innerHTML = '';
      reasons.forEach(r => {
        const opt = document.createElement('option');
        opt.value = r.id || r.reason_id || r.key || r.code || r.name;
        opt.textContent = r.name || r.title || opt.value;
        el.failReason.appendChild(opt);
      });
      el.reviewBox.hidden = false;
    } catch (e) {
      el.returnsBox.innerHTML = `<div class="hint">Erro: ${e.message || e}</div>`;
      el.reviewBox.hidden = true;
      state.returnId = null;
    }
  }

  async function reviewOK() {
    if (!state.returnId) return toast('Sem return_id.');
    try {
      await api(`/api/ml/returns/${encodeURIComponent(state.returnId)}/return-review`, { method: 'POST', body: [] });
      toast('Review OK enviado!');
      loadReturnsAndReviews();
    } catch (e) { toast(e.message || 'Falha no review OK'); }
  }
  async function reviewFAIL() {
    if (!state.returnId) return toast('Sem return_id.');
    const reason = el.failReason.value;
    if (!reason) return toast('Escolha um motivo.');
    const body = [{ order_id: undefined, reason_id: reason }]; // se precisar por-ordem, preenche order_id
    try {
      await api(`/api/ml/returns/${encodeURIComponent(state.returnId)}/return-review`, { method: 'POST', body });
      toast('Review FAIL enviado!');
      loadReturnsAndReviews();
    } catch (e) { toast(e.message || 'Falha no review FAIL'); }
  }

  // mediações / resoluções
  const withBusy = (btn, fn) => async () => {
    const txt = btn.textContent; btn.disabled = true; btn.textContent = '...';
    try { await fn(); } catch (e) { toast(e.message || 'Falha'); } finally { btn.disabled = false; btn.textContent = txt; }
  };
  async function openDispute(){ await api(`/api/ml/claims/${encodeURIComponent(state.claimId)}/actions/open-dispute`, { method:'POST' }); toast('Mediação aberta!'); loadMessages(); }
  async function allowReturn(){ await api(`/api/ml/claims/${encodeURIComponent(state.claimId)}/expected-resolutions/allow-return`, { method:'POST' }); toast('Devolução autorizada!'); }
  async function refund(){ await api(`/api/ml/claims/${encodeURIComponent(state.claimId)}/expected-resolutions/refund`, { method:'POST' }); toast('Reembolso total solicitado!'); }
  async function partialRefund(){
    const pct = Number(el.partialPct.value);
    if (!pct || pct<=0 || pct>=100) return toast('Informe % entre 1 e 99.');
    await api(`/api/ml/claims/${encodeURIComponent(state.claimId)}/expected-resolutions/partial-refund`, { method:'POST', body:{ percentage:pct } });
    toast('Reembolso parcial solicitado!');
  }

  // boot
  function restoreFromURL() {
    const claim = qs.get('claim_id') || qs.get('claim') || '';
    if (claim) el.claimId.value = claim;
    const savedTok = localStorage.getItem('rf_seller_token');
    if (savedTok) el.sellerToken.value = savedTok;
  }
  function saveToken() {
    localStorage.setItem('rf_seller_token', el.sellerToken.value || '');
    toast('Token salvo.');
  }
  async function loadAll() {
    state.claimId = (el.claimId.value || '').trim();
    if (!state.claimId) return toast('Informe o Claim ID.');
    // limpa estado visual
    el.messages.innerHTML = '';
    el.uploadPreview.hidden = true;
    el.uploadPreview.innerHTML = '';
    state.pendingAttachments = [];
    state.returnId = null;

    // carrega blocos paralelamente
    await Promise.allSettled([
      loadMessages(),
      loadAffects(),
      loadReturnCost(),
      loadEvidences(),
      loadReturnsAndReviews()
    ]);
  }

  // listeners
  el.btnLoad.addEventListener('click', loadAll);
  el.btnSaveTok.addEventListener('click', saveToken);
  el.btnSend.addEventListener('click', sendMessage);
  el.btnOpenDispute.addEventListener('click', withBusy(el.btnOpenDispute, openDispute));
  el.btnAllowReturn.addEventListener('click', withBusy(el.btnAllowReturn, allowReturn));
  el.btnRefund.addEventListener('click', withBusy(el.btnRefund, refund));
  el.btnPartial.addEventListener('click', withBusy(el.btnPartial, partialRefund));
  el.btnRefreshEvd.addEventListener('click', loadEvidences);
  el.btnUpEvidence.addEventListener('click', uploadEvidence);
  el.btnRefreshReturns.addEventListener('click', loadReturnsAndReviews);
  el.btnReviewOK.addEventListener('click', reviewOK);
  el.btnReviewFAIL.addEventListener('click', reviewFAIL);

  // atalhos
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'enter') {
      e.preventDefault(); sendMessage();
    }
  });

  // auto-init se vier claim_id na URL
  restoreFromURL();
  if (el.claimId.value) loadAll();
})();
