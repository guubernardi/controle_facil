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

  const setAutoHint = (txt) => {
    const el = $('auto-hint');
    if (el) el.textContent = txt || '';
  };

  const deepGet = (obj, path, def = null) => {
    if (!obj) return def;
    try {
      return path.split('.').reduce((o, k) => (o && k in o ? o[k] : undefined), obj) ?? def;
    } catch { return def; }
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
      pill.textContent = 'Não recebido';
      if (resp) resp.hidden = true;
      if (when) when.hidden = true;
      if (sep)  sep.hidden  = true;
      return;
    }

    pill.className = 'pill -aprovado';
    pill.textContent = 'Recebido no CD';

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

  // ===== Normalização dos dados vindos da API =====
  const parseMoney = (v) => {
    if (v == null || v === '') return '';
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      // remove R$, pontos de milhar e troca vírgula por ponto
      const clean = v.replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.');
      const n = Number(clean);
      return isNaN(n) ? 0 : n;
    }
    return Number(v) || 0;
  };

  const toISODate = (x) => {
    if (!x) return '';
    if (typeof x === 'number') return new Date(x).toISOString().slice(0,10);
    const s = String(x).trim();
    // dd/mm/aaaa
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    const d = new Date(s);
    if (!isNaN(d)) return d.toISOString().slice(0,10);
    return s.slice(0,10);
  };

  function normalizeMotivo(raw) {
    let motivo = raw || '';
    if (typeof motivo !== 'string') return '';
    const s = motivo.toLowerCase().replace(/[_\s]+/g, '-');
    if (s.includes('arrepend') || s.includes('buyer-remorse')) return 'cliente-arrependimento';
    if (s.includes('endereco') || s.includes('address'))       return 'cliente-endereco-errado';
    if (s.includes('defe') || s.includes('defect') || s.includes('damaged')) return 'defeito';
    if (s.includes('avaria') || s.includes('transporte'))      return 'avaria';
    if (s.includes('incor') || s.includes('errad') || s.includes('wrong-item')) return 'pedido-incorreto';
    return s; // deixa como veio; se não bater, o select fica sem seleção
  }

  function normalizeStatus(raw) {
    if (!raw) return '';
    const s = String(raw).toLowerCase();
    if (s.includes('pend')) return 'pendente';
    if (s.includes('aprov')) return 'aprovado';
    if (s.includes('rej') || s.includes('neg')) return 'rejeitado';
    return s;
  }

  function normalizeReturn(payload) {
    const data = (payload && typeof payload === 'object' && 'item' in payload) ? payload.item : payload || {};
    const n = {};

    n.id           = data.id ?? data._id ?? data.return_id ?? null;
    n.id_venda     = data.id_venda ?? data.pedido_id ?? data.order_id ?? data.numero_pedido ?? null;
    n.cliente_nome = data.cliente_nome ?? data.cliente ?? data.buyer_name ?? deepGet(data, 'buyer.name') ?? null;

    // tenta extrair o nome real da loja / vendedor
    n.loja_nome =
      data.loja_nome ?? data.loja ?? data.store_name ?? data.seller_name ??
      deepGet(data, 'seller.nickname') ?? deepGet(data, 'ml.order.seller.nickname') ??
      deepGet(data, 'seller.name') ?? data.plataforma ?? '';

    // status "humano" (select) e "log" (pílula)
    n.status     = normalizeStatus(data.status ?? data.situacao ?? data.claim_status);
    n.log_status = data.log_status ?? data.status_log ?? deepGet(data, 'cd.status') ?? data.log ?? '';

    // motivo
    n.tipo_reclamacao = normalizeMotivo(
      data.tipo_reclamacao ?? data.motivo ?? data.reason ?? data.claim_reason
    );

    // datas
    n.data_compra = data.data_compra ?? data.data_pedido ?? data.created_at ?? data.order_date ?? deepGet(data, 'ml.order.date_created') ?? '';

    // valores
    n.valor_produto = parseMoney(
      data.valor_produto ?? data.valor ?? data.valor_prod ?? data.preco ?? deepGet(data, 'totals.produto')
    );
    n.valor_frete = parseMoney(
      data.valor_frete ?? data.frete ?? data.valor_envio ?? deepGet(data, 'totals.frete')
    );

    // demais campos
    n.sku          = data.sku ?? data.produto_sku ?? data.item_sku ?? deepGet(data, 'produto.sku') ?? '';
    n.nfe_numero   = data.nfe_numero ?? data.nfe ?? data.nota_fiscal ?? '';
    n.nfe_chave    = data.nfe_chave ?? data.chave_nfe ?? '';
    n.reclamacao   = data.reclamacao ?? data.observacao ?? data.obs ?? '';
    n.cd_recebido_em  = data.cd_recebido_em ?? deepGet(data, 'cd.recebido_em') ?? deepGet(data, 'cd.receivedAt') ?? deepGet(data, 'cd.recebidoEm') ?? null;
    n.cd_responsavel  = data.cd_responsavel ?? deepGet(data, 'cd.responsavel') ?? null;

    // aplica formatos finais
    if (n.data_compra) n.data_compra = toISODate(n.data_compra);

    // devolve o objeto original + normalizados (os normalizados prevalecem)
    return { ...data, ...n };
  }

  // ===== Regras de cálculo (frente) =====
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

  // ===== Resumo (card) =====
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

    updateSummary({ ...current, ...d });
  }

  function fill(d) {
    const dvId = $('dv-id');
    if (dvId) dvId.textContent = d.id ? `#${d.id}` : '';

    if ($('id_venda'))         $('id_venda').value         = d.id_venda || '';
    if ($('cliente_nome'))     $('cliente_nome').value     = d.cliente_nome || '';
    if ($('loja_nome'))        $('loja_nome').value        = d.loja_nome || '';
    if ($('data_compra'))      $('data_compra').value      = d.data_compra ? toISODate(d.data_compra) : '';
    if ($('status'))           $('status').value           = normalizeStatus(d.status) || '';
    if ($('sku'))              $('sku').value              = d.sku || '';
    if ($('tipo_reclamacao'))  $('tipo_reclamacao').value  = normalizeMotivo(d.tipo_reclamacao) || '';
    if ($('nfe_numero'))       $('nfe_numero').value       = d.nfe_numero || '';
    if ($('nfe_chave'))        $('nfe_chave').value        = d.nfe_chave || '';
    if ($('reclamacao'))       $('reclamacao').value       = d.reclamacao || '';
    if ($('valor_produto'))    $('valor_produto').value    = (d.valor_produto ?? '') === '' ? '' : parseMoney(d.valor_produto);
    if ($('valor_frete'))      $('valor_frete').value      = (d.valor_frete  ?? '') === '' ? '' : parseMoney(d.valor_frete);

    setLogPill(d.log_status || '—');
    setCdInfo({ receivedAt: d.cd_recebido_em || null, responsavel: d.cd_responsavel || null });

    updateSummary(d);
    recalc();
  }

  async function reloadCurrent() {
    if (!returnId) return;
    const r = await fetch(`/api/returns/${encodeURIComponent(returnId)}`);
    if (!r.ok) throw new Error('Falha ao recarregar registro.');
    const data = await r.json();
    current = normalizeReturn(data);
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
    const dlg   = $('dlg-inspecao');
    const title = $('insp-title');
    const sub   = $('insp-sub');
    thetxt = $('insp-text');
    const btnOk = $('insp-confirm');
    const btnNo = $('insp-cancel');

    if (!dlg) return;

    const isApprove = result === 'aprovado';
    title.textContent = isApprove ? 'Aprovar inspeção' : 'Reprovar inspeção';
    sub.textContent   = isApprove
      ? 'Confirme a aprovação da inspeção. Você pode adicionar uma observação.'
      : 'Confirme a reprovação da inspeção. Você pode adicionar uma observação.';
    if (btnOk) btnOk.className = isApprove ? 'btn btn--success' : 'btn btn--danger';

    thetxt.value = '';
    dlg.showModal();

    const onSubmit = (ev) => {
      ev.preventDefault();
      const obs = thetxt.value.trim();
      dlg.close();
      runInspect(result, obs);
      cleanup();
    };
    const onCancel = () => { dlg.close(); cleanup(); };

    function cleanup(){
      dlg.removeEventListener('close', onCancel);
      const form = $('insp-form');
      if (form) form.removeEventListener('submit', onSubmit);
      if (btnNo) btnNo.removeEventListener('click', onCancel);
    }

    const form = $('insp-form');
    if (form) form.addEventListener('submit', onSubmit);
    if (btnNo) btnNo.addEventListener('click', onCancel);

    setTimeout(() => thetxt?.focus(), 0);
  }

  function disableHead(disabled) {
    ['btn-salvar', 'btn-enrich', 'btn-insp-aprova', 'btn-insp-reprova',
     'rq-receber', 'rq-aprovar', 'rq-reprovar'
    ].forEach(id => {
      const el = $(id); 
      if (el) el.disabled = !!disabled;
    });
  }

  // ====== ENRIQUECIMENTO AUTOMÁTICO (ML) ======
  const ENRICH_TTL_MS = 10 * 60 * 1000; // 10 minutos

  function lojaEhML(nome = '') {
    const s = String(nome).toLowerCase();
    return s.includes('mercado') || s.includes('meli') || s.includes('ml');
  }

  function parecePedidoML(pedido = '') {
    return /^\d{6,}$/.test(String(pedido || ''));
  }

  function needsEnrichment(d = {}) {
    return !d || !d.id_venda || !d.sku || !d.cliente_nome || !d.loja_nome || !d.data_compra || !d.log_status;
  }

  function canEnrichNow() {
    const key = `rf_enrich_${returnId}`;
    const last = Number(localStorage.getItem(key) || 0);
    const ok = !last || (Date.now() - last) > ENRICH_TTL_MS;
    if (ok) localStorage.setItem(key, String(Date.now()));
    return ok;
  }

  async function enrichFromML(reason = 'auto') {
    if (!current?.id) return false;
    try {
      disableHead(true);
      setAutoHint('(atualizando dados do ML…)');
      await fetch(`/api/ml/claims/import?days=90&silent=1`).catch(() => null);
      await fetch(`/api/ml/returns/${encodeURIComponent(current.id)}/enrich`, { method: 'POST' })
        .then(r => r.ok ? null : Promise.reject())
        .catch(() => null);
      await reloadCurrent();
      toast(reason === 'auto' ? 'Dados atualizados automaticamente.' : 'Dados atualizados do ML.', 'success');
      return true;
    } catch {
      return false;
    } finally {
      setAutoHint('');
      disableHead(false);
    }
  }

  // ==== Dialog Recebido no CD ====
  const btnRecebido = $('rq-receber');
  const dlg = $('dlg-recebido');
  const inpResp = $('rcd-resp');
  const inpWhen = $('rcd-when');
  const btnSaveR = $('rcd-save');
  const btnUnset = $('rcd-unset');

  const rcdCancel = $('rcd-cancel');
  if (rcdCancel) rcdCancel.addEventListener('click', () => dlg?.close());

  const pad = (n) => String(n).padStart(2, '0');

  if (btnRecebido) {
    btnRecebido.addEventListener('click', () => {
      const lastResp = localStorage.getItem('cd_responsavel') || '';
      if (inpResp) inpResp.value = lastResp;
      const now = new Date();
      if (inpWhen) {
        inpWhen.value =
          `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
      }
      dlg?.showModal();
    });
  }

  if (btnSaveR) {
    btnSaveR.addEventListener('click', async (ev) => {
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
  }

  if (btnUnset) {
    btnUnset.addEventListener('click', async () => {
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
  }

  // ==== Load inicial ====
  async function load() {
    if (!returnId) {
      const cont = document.querySelector('.page-wrap');
      if (cont) cont.innerHTML = '<div class="card"><b>ID não informado.</b></div>';
      return;
    }
    try {
      await reloadCurrent();

      if ((lojaEhML(current.loja_nome) || parecePedidoML(current.id_venda)) &&
          needsEnrichment(current) && canEnrichNow()) {
        await enrichFromML('auto');
      }

      const ls = String(current.log_status || '').toLowerCase();
      if (ls === 'aprovado_cd' || ls === 'reprovado_cd') {
        const btnA = $('btn-insp-aprova');
        const btnR = $('btn-insp-reprova');
        if (btnA?.style) btnA.style.display = 'none';
        if (btnR?.style) btnR.style.display = 'none';
        const rqA = $('rq-aprovar');
        const rqR = $('rq-reprovar');
        if (rqA) rqA.setAttribute('disabled', 'true');
        if (rqR) rqR.setAttribute('disabled', 'true');
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
  const btnIA = $('btn-insp-aprova');
  const btnIR = $('btn-insp-reprova');
  if (btnIA) btnIA.addEventListener('click', () => openInspectDialog('aprovado'));
  if (btnIR) btnIR.addEventListener('click', () => openInspectDialog('rejeitado'));

  const rqA = $('rq-aprovar');
  const rqR = $('rq-reprovar');
  if (rqA) rqA.addEventListener('click', () => openInspectDialog('aprovado'));
  if (rqR) rqR.addEventListener('click', () => openInspectDialog('rejeitado'));

  const btnSalvar = $('btn-salvar');
  if (btnSalvar) btnSalvar.addEventListener('click', save);

  // Botão manual de enriquecimento (ML)
  const btnEnrich = $('btn-enrich');
  if (btnEnrich) {
    btnEnrich.addEventListener('click', async () => {
      await enrichFromML('manual');
    });
  }

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

  // ===== Keyboard shortcuts =====
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      save();
    }
  });

  // Carregar quando DOM estiver pronto
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})();
