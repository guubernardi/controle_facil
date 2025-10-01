(function () {
  const qs = new URLSearchParams(location.search);
  const id = qs.get('id'); // obrigatório para editar
  const $ = (id) => document.getElementById(id);
  const money = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  function toast(msg, type = 'info') {
    const t = $('toast'); if (!t) return;
    t.className = 'toast ' + type; t.textContent = msg;
    requestAnimationFrame(() => { t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2500); });
  }

  function pillHtml(val) {
    const s = String(val || '').toLowerCase();
    let cls = ' -neutro';
    if (!val) cls = ' -neutro';
    else if (s.includes('pend')) cls = ' -pendente';
    else if (s.includes('aprov')) cls = ' -aprovado';
    else if (s.includes('rej') || s.includes('neg') || s.includes('reprov')) cls = ' -rejeitado';
    return `<span class="pill${cls}">${val || '—'}</span>`;
  }

  // --------- Regra de custo local (igual ao restante do front) ----------
  function calcTotalByRules(d) {
    const st = String(d.status || '').toLowerCase();
    const motivo = String(d.tipo_reclamacao || d.reclamacao || '').toLowerCase();
    const lgs = String(d.log_status || '').toLowerCase();
    const vp = Number(d.valor_produto || 0);
    const vf = Number(d.valor_frete || 0);

    if (st.includes('rej') || st.includes('neg')) return 0;
    if (motivo.includes('cliente')) return 0;
    if (lgs === 'recebido_cd' || lgs === 'em_inspecao') return vf;
    return vp + vf;
  }

  function capture() {
    return {
      id_venda: $('id_venda').value.trim() || null,
      cliente_nome: $('cliente_nome').value.trim() || null,
      loja_nome: $('loja_nome').value.trim() || null,
      data_compra: $('data_compra').value || null,
      status: $('status').value || null,
      sku: $('sku').value.trim() || null,
      tipo_reclamacao: $('tipo_reclamacao').value || null,
      nfe_numero: $('nfe_numero').value.trim() || null,
      nfe_chave: $('nfe_chave').value.trim() || null,
      reclamacao: $('reclamacao').value.trim() || null,
      valor_produto: Number($('valor_produto').value || 0),
      valor_frete: Number($('valor_frete').value || 0),
      log_status: current.log_status || null // não editamos diretamente, mas usamos no cálculo
    };
  }

  function fill(d) {
    $('dv-id').textContent = d.id ? `#${d.id}` : '';
    $('id_venda').value = d.id_venda || '';
    $('cliente_nome').value = d.cliente_nome || '';
    $('loja_nome').value = d.loja_nome || '';
    $('data_compra').value = d.data_compra ? String(d.data_compra).slice(0, 10) : '';
    $('status').value = d.status || '';
    $('sku').value = d.sku || '';
    $('tipo_reclamacao').value = d.tipo_reclamacao || '';
    $('nfe_numero').value = d.nfe_numero || '';
    $('nfe_chave').value = d.nfe_chave || '';
    $('reclamacao').value = d.reclamacao || '';
    $('valor_produto').value = (d.valor_produto ?? '') === '' ? '' : Number(d.valor_produto || 0);
    $('valor_frete').value = (d.valor_frete ?? '') === '' ? '' : Number(d.valor_frete || 0);

    // pílula do log_status
    $('log_status_pill').outerHTML = pillHtml(d.log_status || '—');

    // money lines
    $('ml-prod').textContent = money(d.valor_produto);
    $('ml-frete').textContent = money(d.valor_frete);
    $('ml-total').textContent = money(calcTotalByRules(d));
  }

  function recalc() {
    const d = capture();
    $('ml-prod').textContent = money(d.valor_produto);
    $('ml-frete').textContent = money(d.valor_frete);
    $('ml-total').textContent = money(calcTotalByRules(d));
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
        const e = await r.json().catch(()=>null);
        throw new Error(e?.error || 'Falha ao salvar');
      }
      const saved = await r.json();
      current = { ...current, ...saved };
      fill(current);
      toast('Salvo!', 'success');
    } catch (e) {
      toast(e.message || 'Erro ao salvar', 'error');
    }
  }

  async function markReceived() {
    try {
      disableHead(true);
      const resp = prompt('Quem recebeu no CD? (opcional)') || 'cd';
      const when = new Date().toISOString();

      const r = await fetch(`/api/returns/${encodeURIComponent(current.id)}/cd/receive`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `receive-${current.id}-${when}` },
        body: JSON.stringify({ responsavel: resp, when, updated_by: 'frontend' })
      });
      if (!r.ok) {
        const e = await r.json().catch(()=>null);
        throw new Error(e?.error || 'Falha ao registrar recebimento');
      }
      current.log_status = 'recebido_cd';
      fill(current); // recalcula total (só frete)
      toast('Recebimento registrado!', 'success');
    } catch (e) {
      toast(e.message || 'Erro', 'error');
    } finally {
      disableHead(false);
    }
  }

  async function inspect(result) {
    try {
      disableHead(true);
      const observacao = prompt(`Observação para inspeção (${result})?`) || '';
      const when = new Date().toISOString();
      const r = await fetch(`/api/returns/${encodeURIComponent(current.id)}/cd/inspect`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `inspect-${current.id}-${when}-${result}` },
        body: JSON.stringify({
          resultado: result, observacao, updated_by: 'frontend', when
        })
      });
      if (!r.ok) {
        const e = await r.json().catch(()=>null);
        throw new Error(e?.error || 'Falha na inspeção');
      }
      const j = await r.json();
      // back já grava status e log_status; refletimos localmente
      current.status = j?.status || result;
      current.log_status = (result === 'aprovado') ? 'aprovado_cd' : 'reprovado_cd';
      fill(current);
      toast(`Inspeção registrada (${result})!`, 'success');
    } catch (e) {
      toast(e.message || 'Erro', 'error');
    } finally {
      disableHead(false);
    }
  }

  function disableHead(disabled) {
    ['btn-salvar','btn-recebido','btn-insp-aprova','btn-insp-reprova'].forEach(id => {
      const el = $(id); if (el) el.disabled = !!disabled;
    });
  }

  // listeners de recálculo
  ['valor_produto','valor_frete','status','tipo_reclamacao'].forEach(id => {
    const el = $(id); if (el) el.addEventListener('input', recalc);
    if (el && el.tagName === 'SELECT') el.addEventListener('change', recalc);
  });

  $('btn-salvar').addEventListener('click', save);
  $('btn-recebido').addEventListener('click', markReceived);
  $('btn-insp-aprova').addEventListener('click', () => inspect('aprovado'));
  $('btn-insp-reprova').addEventListener('click', () => inspect('rejeitado'));

  let current = {};

  async function load() {
    if (!id) {
      document.querySelector('.page-wrap').innerHTML =
        '<div class="card"><b>ID não informado.</b></div>';
      return;
    }
    try {
      const r = await fetch(`/api/returns/${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error('Registro não encontrado.');
      current = await r.json();
      fill(current);

      // ações de cabeçalho — ocultar quando fizer sentido
      const ls = String(current.log_status || '').toLowerCase();
      if (ls === 'recebido_cd' || ls === 'em_inspecao' || ls === 'aprovado_cd' || ls === 'reprovado_cd') {
        $('btn-recebido').style.display = 'none';
      }
      if (ls === 'aprovado_cd' || ls === 'reprovado_cd') {
        $('btn-insp-aprova').style.display = 'none';
        $('btn-insp-reprova').style.display = 'none';
      }
    } catch (e) {
      document.querySelector('.page-wrap').innerHTML =
        `<div class="card"><b>${e.message || 'Falha ao carregar.'}</b></div>`;
    }
  }

  document.addEventListener('DOMContentLoaded', load);
})();
