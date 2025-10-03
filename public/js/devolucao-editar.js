// /js/devolucao-editar.js
(function () {
  // ===== Helpers =====
  const $  = (id) => document.getElementById(id);
  const qs = new URLSearchParams(location.search);
  const returnId = qs.get('id');

  const moneyBRL = (v) =>
    Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  const toast = (msg, type = 'info') => {
    const t = $('toast');
    if (!t) { alert(msg); return; }
    t.className = 'toast ' + (type || 'info');
    t.textContent = msg;
    requestAnimationFrame(() => {
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 3000);
    });
  };

  const getLogPillEl = () => $('pill-log') || $('log_status_pill');

  const setLogPill = (text) => {
    const el = getLogPillEl();
    if (!el) return;
    const s = String(text || '').toLowerCase();
    let cls = 'pill -neutro';
    if (!text) cls = 'pill -neutro';
    else if (s.includes('pend')) cls = 'pill -pendente';
    else if (s.includes('aprov')) cls = 'pill -aprovado';
    else if (s.includes('rej') || s.includes('neg') || s.includes('reprov')) cls = 'pill -rejeitado';
    el.className = cls;
    el.textContent = text || '—';
  };

  const setCdInfo = ({ receivedAt = null, responsavel = null } = {}) => {
    const pill = $('pill-cd');
    const resp = $('cd-resp');
    const when = $('cd-when');
    const sep  = $('cd-sep');
    if (!pill) return;

    if (!receivedAt) {
      pill.className = 'pill -neutro';
      pill.textContent = 'não recebido';
      if (resp) resp.hidden = true;
      if (when) when.hidden = true;
      if (sep)  sep.hidden  = true;
      return;
    }

    pill.className = 'pill -aprovado';
    pill.textContent = 'recebido no CD';

    if (resp) {
      resp.textContent = `Resp.: ${responsavel || 'cd'}`;
      resp.hidden = false;
    }
    if (when) {
      const dt = new Date(receivedAt);
      when.textContent = `Quando: ${isNaN(dt) ? receivedAt : dt.toLocaleString('pt-BR')}`;
      when.hidden = false;
    }
    if (sep) sep.hidden = false;
  };

  // ===== Regras de cálculo =====
  function calcTotalByRules(d) {
    const st   = String(d.status || '').toLowerCase();
    const mot  = String(d.tipo_reclamacao || d.reclamacao || '').toLowerCase();
    const lgs  = String(d.log_status || '').toLowerCase();
    const vp   = Number(d.valor_produto || 0);
    const vf   = Number(d.valor_frete || 0);

    if (st.includes('rej') || st.includes('neg')) return 0;
    if (mot.includes('cliente')) return 0;
    if (lgs === 'recebido_cd' || lgs === 'em_inspecao') return vf;
    return vp + vf;
  }

  // ===== Estado =====
  let current = {};

  // ===== Resumo (card à esquerda) =====
  function updateSummary(d) {
    const rs = $('resumo-status');
    const rl = $('resumo-log');
    const rc = $('resumo-cd');
    const rp = $('resumo-prod');
    const rf = $('resumo-frete');
    const rt = $('resumo-total');

    if (rs) rs.textContent = d.status || '—';
    if (rl) rl.textContent = d.log_status || '—';
    if (rc) rc.textContent = d.cd_recebido_em ? 'recebido' : 'não recebido';
    if (rp) rp.textContent = moneyBRL(d.valor_produto || 0);
    if (rf) rf.textContent = moneyBRL(d.valor_frete || 0);
    if (rt) rt.textContent = moneyBRL(calcTotalByRules(d));
  }

  function capture() {
    return {
      id_venda:        $('id_venda')?.value.trim() || null,
      cliente_nome:    $('cliente_nome')?.value.trim() || null,
      loja_nome:       $('loja_nome')?.value.trim() || null,
      data_compra:     $('data_compra')?.value || null,
      status:          $('status')?.value || null,
      sku:             $('sku')?.value.trim() || null,
      tipo_reclamacao: $('tipo_reclamacao')?.value || null,
      nfe_numero:      $('nfe_numero')?.value.trim() || null,
      nfe_chave:       $('nfe_chave')?.value.trim() || null,
      reclamacao:      $('reclamacao')?.value.trim() || null,
      valor_produto:   Number($('valor_produto')?.value || 0),
      valor_frete:     Number($('valor_frete')?.value || 0),
      log_status:      current.log_status || null,
      // campos que vêm do back quando carregados
      cd_recebido_em:  current.cd_recebido_em || null
    };
  }

  function recalc() {
    const d = capture();
    const eProd  = $('ml-prod');
    const eFrete = $('ml-frete');
    const eTotal = $('ml-total');
    if (eProd)  eProd.textContent  = moneyBRL(d.valor_produto);
    if (eFrete) eFrete.textContent = moneyBRL(d.valor_frete);
    if (eTotal) eTotal.textContent = moneyBRL(calcTotalByRules(d));

    updateSummary({ ...current, ...d }); // mantém resumo sincronizado
  }

  function fill(d) {
    const dvId = $('dv-id');
    if (dvId) dvId.textContent = d.id ? `#${d.id}` : '';

    if ($('id_venda'))         $('id_venda').value         = d.id_venda || '';
    if ($('cliente_nome'))     $('cliente_nome').value     = d.cliente_nome || '';
    if ($('loja_nome'))        $('loja_nome').value        = d.loja_nome || '';
    if ($('data_compra'))      $('data_compra').value      = d.data_compra ? String(d.data_compra).slice(0, 10) : '';
    if ($('status'))           $('status').value           = d.status || '';
    if ($('sku'))              $('sku').value              = d.sku || '';
    if ($('tipo_reclamacao'))  $('tipo_reclamacao').value  = d.tipo_reclamacao || '';
    if ($('nfe_numero'))       $('nfe_numero').value       = d.nfe_numero || '';
    if ($('nfe_chave'))        $('nfe_chave').value        = d.nfe_chave || '';
    if ($('reclamacao'))       $('reclamacao').value       = d.reclamacao || '';
    if ($('valor_produto'))    $('valor_produto').value    = (d.valor_produto ?? '') === '' ? '' : Number(d.valor_produto || 0);
    if ($('valor_frete'))      $('valor_frete').value      = (d.valor_frete  ?? '') === '' ? '' : Number(d.valor_frete  || 0);

    setLogPill(d.log_status || '—');
    setCdInfo({ receivedAt: d.cd_recebido_em || null, responsavel: d.cd_responsavel || null });

    // atualiza ambos: money lines e resumo
    updateSummary(d);
    recalc();
  }

  async function reloadCurrent() {
    if (!returnId) return;
    const r = await fetch(`/api/returns/${encodeURIComponent(returnId)}`);
    if (!r.ok) throw new Error('Falha ao recarregar registro.');
    current = await r.json();
    fill(current);
  }

  async function save() {
    try {
      const body = capture();
      const r = await fetch(`/api/returns/${encodeURIComponent(current.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, updated_by: 'frontend' })
      });
      if (!r.ok) {
        const e = await r.json().catch(() => null);
        throw new Error(e?.error || 'Falha ao salvar');
      }
      await reloadCurrent();
      toast('Salvo!', 'success');
      await refreshTimeline(current.id);
    } catch (e) {
      toast(e.message || 'Erro ao salvar', 'error');
    }
  }

  async function runInspect(result, observacao) {
  try {
    disableHead(true);
    const when = new Date().toISOString();
    const r = await fetch(`/api/returns/${encodeURIComponent(current.id)}/cd/inspect`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `inspect-${current.id}-${when}-${result}`
      },
      body: JSON.stringify({ resultado: result, observacao: observacao || '', updated_by: 'frontend', when })
    });
    if (!r.ok) {
      const e = await r.json().catch(() => null);
      throw new Error(e?.error || 'Falha na inspeção');
    }
    await reloadCurrent();
    toast(`Inspeção registrada (${result})!`, 'success');
    await refreshTimeline(current.id);
  } catch (e) {
    toast(e.message || 'Erro', 'error');
  } finally {
    disableHead(false);
  }
}

  function openInspectDialog(result) {
    const dlg   = document.getElementById('dlg-inspecao');
    const title = document.getElementById('insp-title');
    const sub   = document.getElementById('insp-sub');
    const txt   = document.getElementById('insp-text');
    const btnOk = document.getElementById('insp-confirm');
    const btnNo = document.getElementById('insp-cancel');

    if (!dlg) return;

    // visual conforme ação
    const isApprove = result === 'aprovado';
    title.textContent = isApprove ? 'Aprovar inspeção' : 'Reprovar inspeção';
    sub.textContent   = isApprove
      ? 'Confirme a aprovação da inspeção. Você pode adicionar uma observação.'
      : 'Confirme a reprovação da inspeção. Você pode adicionar uma observação.';
    btnOk.classList.toggle('aprovar',  isApprove);
    btnOk.classList.toggle('reprovar', !isApprove);

    txt.value = '';
    dlg.showModal();

    // handlers pontuais
    const onSubmit = (ev) => {
      ev.preventDefault();
      const obs = txt.value.trim();
      dlg.close();
      // executa
      runInspect(result, obs);
      cleanup();
    };
    const onCancel = () => { dlg.close(); cleanup(); };

    function cleanup(){
      dlg.removeEventListener('close', onCancel);
      document.getElementById('insp-form')?.removeEventListener('submit', onSubmit);
      btnNo?.removeEventListener('click', onCancel);
    }

    document.getElementById('insp-form')?.addEventListener('submit', onSubmit);
    btnNo?.addEventListener('click', onCancel);

    // foco no textarea
    setTimeout(() => txt?.focus(), 0);
  }


  function disableHead(disabled) {
    ['btn-salvar', 'btn-recebido', 'btn-insp-aprova', 'btn-insp-reprova',
     'rq-receber', 'rq-aprovar', 'rq-reprovar'
    ].forEach(id => {
      const el = $(id); if (el) el.disabled = !!disabled;
    });
  }

  // ==== Dialog Recebido no CD ====
  const btnRecebido = $('btn-recebido');
  const dlg     = $('dlg-recebido');
  const inpResp = $('rcd-resp');
  const inpWhen = $('rcd-when');
  const btnSaveR = $('rcd-save');
  const btnUnset = $('rcd-unset');

  $('rcd-cancel')?.addEventListener('click', () => dlg?.close());

  const pad = (n) => String(n).padStart(2, '0');

  btnRecebido?.addEventListener('click', () => {
    const lastResp = localStorage.getItem('cd_responsavel') || '';
    if (inpResp) inpResp.value = lastResp;
    const now = new Date();
    if (inpWhen) {
      inpWhen.value =
        `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    }
    dlg?.showModal();
  });

  btnSaveR?.addEventListener('click', async (ev) => {
    ev.preventDefault();
    try {
      if (!returnId) return toast('ID da devolução não encontrado.', 'error');

      const responsavel = (inpResp?.value || '').trim() || 'cd';
      localStorage.setItem('cd_responsavel', responsavel);

      let whenIso = new Date().toISOString();
      if (inpWhen?.value) {
        const d = new Date(inpWhen.value);
        if (!isNaN(d)) whenIso = d.toISOString();
      }

      const headers = {
        'Content-Type': 'application/json',
        'Idempotency-Key': `receive-${returnId}-${Date.now()}`
      };
      const r = await fetch(`/api/returns/${encodeURIComponent(returnId)}/cd/receive`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ responsavel, when: whenIso, updated_by: 'frontend' })
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: 'Falha no PATCH' }));
        throw new Error(err?.error || 'Falha ao registrar recebimento.');
      }

      await reloadCurrent();
      toast('Recebimento no CD atualizado!', 'success');
      dlg?.close();
      await refreshTimeline(returnId);
    } catch (e) {
      toast(e.message || 'Erro ao registrar recebimento.', 'error');
    }
  });

  btnUnset?.addEventListener('click', async () => {
    try {
      if (!returnId) return toast('ID da devolução não encontrado.', 'error');

      const responsavel = (inpResp?.value || '').trim() || 'cd';
      let whenIso = new Date().toISOString();
      if (inpWhen?.value) {
        const d = new Date(inpWhen.value);
        if (!isNaN(d)) whenIso = d.toISOString();
      }

      const headers = {
        'Content-Type': 'application/json',
        'Idempotency-Key': `unreceive-${returnId}-${Date.now()}`
      };
      const r = await fetch(`/api/returns/${encodeURIComponent(returnId)}/cd/unreceive`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ responsavel, when: whenIso, updated_by: 'frontend' })
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: 'Falha no PATCH' }));
        throw new Error(err?.error || 'Falha ao remover marcação.');
      }

      await reloadCurrent();
      toast('Marcação de recebido removida.', 'success');
      dlg?.close();
      await refreshTimeline(returnId);
    } catch (e) {
      toast(e.message || 'Erro ao remover marcação.', 'error');
    }
  });

  // ==== Load inicial ====
  async function load() {
    if (!returnId) {
      const cont = document.querySelector('.page-wrap');
      if (cont) cont.innerHTML = '<div class="card"><b>ID não informado.</b></div>';
      return;
    }
    try {
      await reloadCurrent();

      const ls = String(current.log_status || '').toLowerCase();
      if (ls === 'aprovado_cd' || ls === 'reprovado_cd') {
        $('btn-insp-aprova')?.style && ($('btn-insp-aprova').style.display = 'none');
        $('btn-insp-reprova')?.style && ($('btn-insp-reprova').style.display = 'none');
        $('rq-aprovar')?.setAttribute('disabled', 'true');
        $('rq-reprovar')?.setAttribute('disabled', 'true');
      }

      await refreshTimeline(current.id);
    } catch (e) {
      const cont = document.querySelector('.page-wrap');
      if (cont) cont.innerHTML = `<div class="card"><b>${e.message || 'Falha ao carregar.'}</b></div>`;
    }
  }

  // Recalcular automaticamente
  ['valor_produto', 'valor_frete', 'status', 'tipo_reclamacao'].forEach(id => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', recalc);
    if (el.tagName === 'SELECT') el.addEventListener('change', recalc);
  });

  // Botões do topo
  $('btn-insp-aprova')?.addEventListener('click', () => openInspectDialog('aprovado'));
  $('btn-insp-reprova')?.addEventListener('click', () => openInspectDialog('rejeitado'));
  $('rq-aprovar')?.addEventListener('click', () => openInspectDialog('aprovado'));
  $('rq-reprovar')?.addEventListener('click', () => openInspectDialog('rejeitado'));

  // ===== TIMELINE =====
  async function fetchEvents(id, limit = 100, offset = 0) {
    const url = `/api/returns/${encodeURIComponent(id)}/events?limit=${limit}&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Falha ao carregar eventos.');
    const j = await res.json();
    return Array.isArray(j.items) ? j.items : [];
  }

  const fmtRel = (iso) => {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const diffMs = Date.now() - d.getTime();
    const abs = Math.abs(diffMs);
    const min = 60 * 1000, hr = 60 * min, day = 24 * hr;
    const s = (n, u) => `${n} ${u}${n > 1 ? 's' : ''}`;
    if (abs < hr)  return s(Math.round(abs / min) || 0, 'min') + (diffMs >= 0 ? ' atrás' : ' depois');
    if (abs < day) return s(Math.round(abs / hr),  'hora') + (diffMs >= 0 ? 's atrás' : 's depois');
    return d.toLocaleString('pt-BR');
  };

  function iconFor(type) {
    if (type === 'status') return '🛈';
    if (type === 'note')   return '📝';
    if (type === 'warn')   return '⚠️';
    if (type === 'error')  return '⛔';
    return '•';
  }

  function renderEvents(items) {
    const wrap   = $('events-list');
    const elLoad = $('events-loading');
    const elEmpty= $('events-empty');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (elLoad) elLoad.hidden = true;

    if (!items.length) {
      if (elEmpty) elEmpty.hidden = false;
      return;
    }
    if (elEmpty) elEmpty.hidden = true;

    const frag = document.createDocumentFragment();
    items.forEach(ev => {
      const type = (ev.type || 'status').toLowerCase();
      const meta = (ev.meta && (typeof ev.meta === 'object' ? ev.meta : null)) || null;

      const item = document.createElement('article');
      item.className = `tl-item -${type}`;
      item.setAttribute('role', 'article');

      const created = ev.createdAt || ev.created_at || ev.created;
      const rel = created ? fmtRel(created) : '';

      item.innerHTML = `
        <span class="tl-dot" aria-hidden="true"></span>
        <div class="tl-head">
          <span class="tl-title">${iconFor(type)} ${ev.title || (type === 'status' ? 'Status' : 'Evento')}</span>
          <span class="tl-time" title="${created || ''}">${rel}</span>
        </div>
        ${ev.message ? `<div class="tl-msg">${ev.message}</div>` : ''}
        <div class="tl-meta"></div>
      `;

      const metaBox = item.querySelector('.tl-meta');
      if (meta?.status)           metaBox.insertAdjacentHTML('beforeend', `<span class="tl-badge">status: <b>${meta.status}</b></span>`);
      if (meta?.log_status)       metaBox.insertAdjacentHTML('beforeend', `<span class="tl-badge">log: <b>${meta.log_status}</b></span>`);
      if (meta?.cd?.responsavel)  metaBox.insertAdjacentHTML('beforeend', `<span class="tl-badge">CD: ${meta.cd.responsavel}</span>`);
      if (meta?.cd?.receivedAt)   metaBox.insertAdjacentHTML('beforeend', `<span class="tl-badge">recebido: ${new Date(meta.cd.receivedAt).toLocaleString('pt-BR')}</span>`);
      if (meta?.cd?.unreceivedAt) metaBox.insertAdjacentHTML('beforeend', `<span class="tl-badge">removido: ${new Date(meta.cd.unreceivedAt).toLocaleString('pt-BR')}</span>`);
      if (meta?.cd?.inspectedAt)  metaBox.insertAdjacentHTML('beforeend', `<span class="tl-badge">inspecionado: ${new Date(meta.cd.inspectedAt).toLocaleString('pt-BR')}</span>`);

      frag.appendChild(item);
    });
    wrap.appendChild(frag);
  }

  async function refreshTimeline(id) {
    const elLoad = $('events-loading');
    const elList = $('events-list');
    if (elLoad) elLoad.hidden = false;
    if (elList) elList.setAttribute('aria-busy', 'true');
    try {
      const items = await fetchEvents(id, 100, 0);
      renderEvents(items);
    } catch (e) {
      renderEvents([]);
      console.error(e);
    } finally {
      if (elLoad) elLoad.hidden = true;
      if (elList) elList.setAttribute('aria-busy', 'false');
    }
  }

  // ===== AÇÕES RÁPIDAS =====
  $('rq-receber')?.addEventListener('click', () => $('btn-recebido')?.click());
  $('rq-aprovar')?.addEventListener('click', () => inspect('aprovado'));
  $('rq-reprovar')?.addEventListener('click', () => inspect('rejeitado'));

  document.addEventListener('DOMContentLoaded', load);
})();
