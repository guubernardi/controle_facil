/* logs.js — Auditoria de custos (v_return_cost_log) com filtros, paginação e CSV */

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

/* -------- Regras de custo (fallback do front) --------
   - Rejeitado/Negado => 0
   - Motivo do cliente => 0
   - Recebido no CD / Em inspeção => apenas frete
   - Demais => produto + frete
------------------------------------------------------ */
function calcPrejuizoRow(row = {}) {
  const st  = String(row.status || '').toLowerCase();
  const lgs = String(row.log_status || '').toLowerCase();
  const motivo = (row.motivo_codigo || row.tipo_reclamacao || row.reclamacao || '').toLowerCase();
  const vp  = Number(row.valor_produto || 0);
  const vf  = Number(row.valor_frete || 0);

  if (st.includes('rej') || st.includes('neg')) return 0;
  if (motivo.includes('cliente')) return 0;
  if (lgs === 'recebido_cd' || lgs === 'em_inspecao') return vf;
  return vp + vf;
}

/* Usa o total do back se existir; senão, aplica a regra local */
function calcTotal(row) {
  if (row.total != null && !Number.isNaN(Number(row.total))) return Number(row.total);
  return calcPrejuizoRow(row);
}

/* -------- Prefill dos filtros (mês atual por padrão) -------- */
(function initFilters () {
  const hoje = new Date();
  const from = qs.get('from') || new Date(hoje.getFullYear(), hoje.getMonth(), 1).toISOString().slice(0, 10);
  const to   = qs.get('to')   || new Date(hoje.getFullYear(), hoje.getMonth() + 1, 1).toISOString().slice(0, 10);

  $('filtro-data-de').value      = from;
  $('filtro-data-ate').value     = to;

  // Mapeia query param para o select único:
  const qStatus = (qs.get('status') || '').toLowerCase();
  const qLogSt  = (qs.get('log_status') || '').toLowerCase();
  $('filtro-status').value = qLogSt || qStatus || '';

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

  // Mapeia status do select: se for "recebido_cd" ou "em_inspecao" => log_status
  const selStatus = String($('filtro-status').value || '').toLowerCase();
  if (selStatus === 'recebido_cd' || selStatus === 'em_inspecao') {
    p.set('log_status', selStatus);
  } else if (selStatus) {
    p.set('status', selStatus);
  }

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
              (s.includes('rej') || s.includes('neg')) ? '-rejeitado' :
              (s.includes('receb') || s.includes('insp')) ? '-neutro' : '';
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
      const totalCalc = calcTotal(row);
      return `
        <tr data-idx="${idx}">
          <td class="celula-data">${dt}</td>
          <td><span class="badge-pedido">#${escapeHtml(pedido)}</span></td>
          <td class="celula-cliente">${escapeHtml(cliente)}</td>
          <td class="celula-loja">${escapeHtml(loja)}</td>
          <td>${statusPill(row.status)}</td>
          <td class="celula-total texto-direita">${money(totalCalc)}</td>
        </tr>`;
    }).join('');
  }

  // resumo e paginação (usa sum_total do back se tiver; senão soma local)
  const sumLocal = (items || []).reduce((acc, r) => acc + calcTotal(r), 0);
  const sumShow = (sum_total != null) ? Number(sum_total) : sumLocal;

  $('total-registros').textContent = String(total);
  $('soma-periodo').textContent    = money(sumShow || 0);

  const max = Math.max(1, Math.ceil((total || 0) / pageSize));
  $('info-paginacao').textContent = `Página ${page} de ${max}`;
  $('botao-anterior').disabled = page <= 1;
  $('botao-proxima').disabled  = page >= max;

  // ao clicar na linha, navegar para a página de edição
  tbody.querySelectorAll('tr[data-idx]').forEach(tr => {
    tr.addEventListener('click', () => {
      const idx = Number(tr.getAttribute('data-idx'));
      const row = items[idx];
      const rid = row?.return_id || row?.id;
      if (rid) {
        location.href = `/devolucao-editar.html?id=${encodeURIComponent(rid)}`;
      } else {
        showToast('Sem vínculo de devolução para abrir.', 'error');
      }
    });
  });
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
    motivo: r.motivo_codigo || r.tipo_reclamacao || r.reclamacao || '',
    status: r.status || '',
    log_status: r.log_status || '',
    politica: r.regra_aplicada || r.politica || '',
    responsavel: r.responsavel_custo || '',
    valor_produto: Number(r.valor_produto || 0),
    valor_frete: Number(r.valor_frete || 0),
    total: Number(calcTotal(r)),
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
