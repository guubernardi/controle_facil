/* logs.js — Auditoria de custos (return_cost_log) com filtros, paginação e CSV */

/* Helpers básicos */
const qs = new URLSearchParams(location.search);
const $ = (sel) =>
  sel && sel.startsWith('#') ? document.querySelector(sel) : document.getElementById(sel);
const money = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const esc = (s='') => String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const escapeHtml = esc; // alias

let page     = Math.max(1, Number(qs.get('page') || 1));
let pageSize = Math.max(1, Number(qs.get('pageSize') || 50));
let lastResp = { items: [], total: 0, sum_total: 0 };

/* -------- Prefill dos filtros (mês atual por padrão) -------- */
(function initFilters () {
  const hoje = new Date();
  const from = qs.get('from') || new Date(hoje.getFullYear(), hoje.getMonth(), 1).toISOString().slice(0, 10);
  const to   = qs.get('to')   || new Date(hoje.getFullYear(), hoje.getMonth() + 1, 1).toISOString().slice(0, 10);

  $('filtro-data-de').value      = from;
  $('filtro-data-ate').value     = to;
  $('filtro-status').value       = qs.get('status')       || '';
  $('filtro-responsavel').value  = qs.get('responsavel')  || '';
  $('filtro-loja').value         = qs.get('loja')         || '';
  $('filtro-busca').value        = qs.get('q')            || '';
  $('filtro-itens-pagina').value = String(pageSize);
})();

/* ------------------ Eventos ------------------ */
$('botao-aplicar').addEventListener('click', () => { page = 1; load(); });

$('botao-limpar').addEventListener('click', () => {
  const hoje = new Date();
  $('filtro-data-de').value  = new Date(hoje.getFullYear(), hoje.getMonth(), 1).toISOString().slice(0, 10);
  $('filtro-data-ate').value = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 1).toISOString().slice(0, 10);
  $('filtro-status').value = '';
  $('filtro-responsavel').value = '';
  $('filtro-loja').value = '';
  $('filtro-busca').value = '';
  page = 1;
  load();
});

$('botao-exportar').addEventListener('click', exportCSV);

$('filtro-itens-pagina').addEventListener('change', () => {
  pageSize = Number($('filtro-itens-pagina').value || 50);
  page = 1;
  load();
});

$('botao-anterior').addEventListener('click', () => {
  if (page > 1) { page--; load(); }
});

$('botao-proxima').addEventListener('click', () => {
  const max = Math.max(1, Math.ceil((lastResp.total || 0) / pageSize));
  if (page < max) { page++; load(); }
});

/* ------------------ Helpers ------------------ */
function buildParams () {
  const p = new URLSearchParams();
  p.set('from', $('filtro-data-de').value || '');
  p.set('to',   $('filtro-data-ate').value || '');
  if ($('filtro-status').value)      p.set('status', $('filtro-status').value);
  if ($('filtro-responsavel').value) p.set('responsavel', $('filtro-responsavel').value);
  if ($('filtro-loja').value)        p.set('loja', $('filtro-loja').value);
  if ($('filtro-busca').value)       p.set('q', $('filtro-busca').value);
  p.set('page', String(page));
  p.set('pageSize', String(pageSize));
  p.set('orderBy', 'event_at');
  p.set('orderDir', 'desc');
  return p;
}

// pílula por status
function statusPill(st) {
  const s = String(st||'').toLowerCase();
  const cls = s.includes('pend') ? '-pendente' :
              s.includes('aprov') ? '-aprovado' :
              s.includes('rej')||s.includes('neg') ? '-rejeitado' : '';
  return `<span class="rf-pill ${cls}">${escapeHtml(st||'—')}</span>`;
}

/* ------------------ Carregamento ------------------ */
async function load () {
  const params = buildParams();

  // mantém URL compartilhável
  history.replaceState(null, '', `/logs.html?${params.toString()}`);

  $('corpo-tabela').innerHTML = `
    <tr><td colspan="6" class="celula-carregando">Carregando dados...</td></tr>
  `;

  try {
    const r = await fetch('/api/returns/logs?' + params.toString());
    if (!r.ok) throw new Error('Falha ao carregar');
    const data = await r.json();
    lastResp = data || { items: [], total: 0, sum_total: 0 };
    render(lastResp);
  } catch (e) {
    $('corpo-tabela').innerHTML = `
      <tr><td colspan="6" class="celula-vazia">Erro ao carregar os dados.</td></tr>
    `;
    showToast('Não foi possível carregar o log.', 'error');
  }
}

function render({ items=[], total=0, sum_total=0 }) {
  const tbody = $('corpo-tabela');
  if (!items.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="celula-vazia">Sem registros nesse período.</td></tr>`;
  } else {
    tbody.innerHTML = items.map((row, idx) => {
      const dt = new Date(row.event_at || row.created_at || Date.now()).toLocaleString('pt-BR');
      const pedido = row.numero_pedido || row.id_venda || row.return_id || '—';
      const cliente= (row.cliente_nome || '—').slice(0, 48);
      const loja   = row.loja_nome || '—';
      return `
        <tr data-idx="${idx}">
          <td class="celula-data">${dt}</td>
          <td><span class="badge-pedido">#${escapeHtml(pedido)}</span></td>
          <td class="celula-cliente">${escapeHtml(cliente)}</td>
          <td class="celula-loja">${escapeHtml(loja)}</td>
          <td>${statusPill(row.status)}</td>
          <td class="celula-total texto-direita">${money(row.total)}</td>
        </tr>`;
    }).join('');
  }

  // resumo e paginação
  $('total-registros').textContent = String(total);
  $('soma-periodo').textContent    = money(sum_total || 0);

  const max = Math.max(1, Math.ceil((total || 0) / pageSize));
  $('info-paginacao').textContent = `Página ${page} de ${max}`;
  $('botao-anterior').disabled = page <= 1;
  $('botao-proxima').disabled  = page >= max;

  // abre modal ao clicar
  tbody.querySelectorAll('tr[data-idx]').forEach(tr => {
    tr.addEventListener('click', () => {
      const idx = Number(tr.getAttribute('data-idx'));
      openDetails(items[idx]);
    });
  });
}

/* ---- modal ---- */
const modal = {
  el: document.getElementById('log-modal'),
  open(){ this.el.classList.remove('hidden'); this.el.setAttribute('aria-hidden','false'); },
  close(){ this.el.classList.add('hidden'); this.el.setAttribute('aria-hidden','true'); }
};
document.querySelectorAll('[data-modal-close]').forEach(b=>b.addEventListener('click',()=>modal.close()));
document.addEventListener('keydown', (e)=>{ if(e.key==='Escape') modal.close(); });

async function openDetails(row){
  if (!row) return;

  // meta
  $('#md-pedido').textContent   = row.numero_pedido || row.id_venda || row.return_id || '—';
  $('#md-cliente').textContent  = row.cliente_nome || '—';
  $('#md-loja').textContent     = row.loja_nome || '—';
  $('#md-politica').textContent = row.regra_aplicada || row.politica || '—';
  $('#md-resp').textContent     = row.responsavel_custo || '—';

  const st = row.status || '—';
  const wrap = document.createElement('span');
  wrap.innerHTML = statusPill(st);
  const pill = wrap.firstElementChild;
  const mdst = $('#md-status');
  mdst.replaceWith(pill);
  pill.id = 'md-status';

  // conteúdos
  $('#md-sku').textContent        = row.sku || '—';
  $('#md-motivo').textContent     = row.motivo_codigo || row.reclamacao || '—';
  $('#md-prod').textContent       = money(row.valor_produto);
  $('#md-frete').textContent      = money(row.valor_frete);
  $('#md-total').textContent      = money(row.total);
  $('#md-reclamacao').textContent = row.reclamacao || '—';

  // timeline
  const ul = $('#md-timeline');
  ul.innerHTML = '<li>Carregando…</li>';
  try{
    const rid = row.return_id || null;
    if (rid){
      const r = await fetch(`/api/returns/${encodeURIComponent(rid)}/events?limit=50`);
      const data = await r.json();
      if (!r.ok) throw new Error('falha timeline');
      ul.innerHTML = (data.items||[]).map(ev => {
        const when = new Date(ev.createdAt||ev.created_at).toLocaleString('pt-BR');
        const msg  = escapeHtml(ev.title || ev.type || '');
        const det  = escapeHtml(ev.message || '');
        return `<li><b>${when} — ${msg}</b><div>${det}</div></li>`;
      }).join('') || '<li>Sem eventos.</li>';
    } else {
      ul.innerHTML = '<li>Sem vínculo de devolução.</li>';
    }
  } catch {
    ul.innerHTML = '<li>Não foi possível carregar a linha do tempo.</li>';
  }

  // link "Ver completo"
  const fullBtn = document.getElementById('md-open-full');
  if (row.return_id) {
    fullBtn.href = `/log-detalhe.html?id=${encodeURIComponent(row.return_id)}`;
    fullBtn.removeAttribute('disabled');
  } else {
    fullBtn.removeAttribute('href');
    fullBtn.setAttribute('disabled', 'disabled');
  }

  // copiar #pedido
  const btnCopy = document.getElementById('md-copy');
  btnCopy.onclick = async () => {
    const nro = row.numero_pedido || row.id_venda || row.return_id || '';
    try { await navigator.clipboard.writeText(String(nro)); showToast('Pedido copiado!', 'success'); }
    catch { showToast('Falha ao copiar.', 'error'); }
  };

  modal.open();
}

/* ------------------ Exportar CSV ------------------ */
function toCSV (rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escv = (v) => {
    if (v == null) return '';
    const s = String(v);
    return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map(r => headers.map(h => escv(r[h])).join(','))].join('\n');
}

function exportCSV () {
  const rows = (lastResp.items || []).map(r => ({
    data: new Date(r.event_at || r.created_at || Date.now()).toISOString(),
    pedido: r.numero_pedido || r.id_venda || r.return_id || '',
    cliente: r.cliente_nome || '',
    sku: r.sku || '',
    motivo: r.motivo_codigo || r.reclamacao || '',
    status: r.status || '',
    politica: r.regra_aplicada || r.politica || '',
    responsavel: r.responsavel_custo || '',
    valor_produto: Number(r.valor_produto || 0),
    valor_frete: Number(r.valor_frete || 0),
    total: Number(r.total || 0),
    loja: r.loja_nome || ''
  }));
  const csv  = toCSV(rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'log_custos.csv';
  a.click();
}

/* ------------------ Toast simples ------------------ */
function showToast (msg, type = 'info') {
  const t = $('toast');
  if (!t) return;
  t.className = 'toast ' + (type || 'info');
  t.textContent = msg;
  requestAnimationFrame(() => {
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3000);
  });
}

/* ------------------ Boot ------------------ */
document.addEventListener('DOMContentLoaded', load);
