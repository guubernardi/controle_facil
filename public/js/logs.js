// public/js/logs.js
/*
 * Log de custos — pesquisa e paginação
 * - NÃO força período por padrão (from/to vazios => busca tudo)
 * - Lê ?from=YYYY-MM-DD&to=YYYY-MM-DD&status=&loja=&q=...
 * - Ordenação, paginação, export CSV (se houver)
 */

const $  = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const money = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

async function jfetch(url, opts) {
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || r.statusText || 'Falha na requisição');
  return j;
}
function toast(msg) {
  const el = $('#toast');
  if (!el) return;
  el.querySelector('.toast-message').textContent = msg;
  el.classList.add('is-visible');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('is-visible'), 3500);
}
function debounce(fn, wait) {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

const state = { page: 1, pageSize: 50, orderBy: 'event_at', orderDir: 'desc', total: 0, sum: 0, items: [] };

function getFilters() {
  return {
    from: $('#filtro-data-de')?.value || '',
    to:   $('#filtro-data-ate')?.value || '',
    status: $('#filtro-status')?.value || '',
    log_status: '',
    responsavel: $('#filtro-responsavel')?.value || '',
    loja: $('#filtro-loja')?.value || '',
    q: ($('#filtro-busca')?.value || '').trim(),
    page: String(state.page),
    pageSize: String(state.pageSize),
    orderBy: state.orderBy,
    orderDir: state.orderDir,
  };
}
function buildQuery(obj) {
  const u = new URLSearchParams();
  Object.entries(obj).forEach(([k, v]) => { if (v !== '' && v != null) u.set(k, v); });
  return u.toString();
}

async function loadLogs() {
  const tbody = $('#corpo-tabela');
  if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="celula-carregando"><div class="loading-spinner"></div> Carregando…</td></tr>`;
  try {
    const qs = buildQuery(getFilters());
    const j = await jfetch(`/api/returns/logs?${qs}`);
    state.total = j.total || 0;
    state.sum   = Number(j.sum_total || 0);
    state.items = Array.isArray(j.items) ? j.items : [];
    renderSummary(); renderTable(); renderPager();
  } catch (e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="celula-carregando">Erro: ${esc(e.message)}</td></tr>`;
    toast(`Erro ao carregar: ${e.message}`);
  }
}
function renderSummary() {
  $('#total-registros') && ($('#total-registros').textContent = state.total.toLocaleString('pt-BR'));
  $('#soma-periodo')    && ($('#soma-periodo').textContent    = money(state.sum));
  $('#contador-filtros .contador-badge') &&
    ($('#contador-filtros .contador-badge').textContent = `${state.total} registros`);
}
function renderTable() {
  const tbody = $('#corpo-tabela');
  if (!tbody) return;
  if (!state.items.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="celula-carregando">Nada encontrado.</td></tr>`;
    return;
  }
  tbody.innerHTML = state.items.map((it, idx) => {
    const dt = it.event_at ? new Date(it.event_at) : null;
    const dataFmt = dt ? dt.toLocaleString('pt-BR') : '—';
    const status = (it.status || '').toLowerCase();
    const tag = status.includes('rej') ? 'tag -neg' : status.includes('aprov') ? 'tag -ok'
              : status.includes('pend') ? 'tag -warn' : 'tag';
    return `
      <tr data-id="${it.return_id ?? ''}" style="animation: fade-in 0.3s ease-out ${idx * 0.05}s backwards;">
        <td>${dataFmt}</td>
        <td><a href="devolucao-editar.html?id=${encodeURIComponent(it.return_id ?? '')}" class="link-pedido">${esc(it.numero_pedido ?? '—')}</a></td>
        <td>${esc(it.cliente_nome ?? '—')}</td>
        <td>${esc(it.loja_nome ?? '—')}</td>
        <td><span class="${tag}">${esc(it.status ?? '—')}</span></td>
        <td class="texto-direita">${money(it.total)}</td>
      </tr>`;
  }).join('');
}
function renderPager() {
  const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
  $('#info-paginacao') && ($('#info-paginacao').textContent = `Página ${state.page} de ${pages}`);
  $('#botao-anterior') && ($('#botao-anterior').disabled = state.page <= 1);
  $('#botao-proxima')  && ($('#botao-proxima').disabled  = state.page >= pages);
}

document.addEventListener('DOMContentLoaded', () => {
  // NÃO aplicar defaults de mês — manter vazio para buscar todas
  const params = new URLSearchParams(location.search);
  const qsFrom = params.get('from') || '';
  const qsTo   = params.get('to')   || '';
  const qsSt   = params.get('status') || '';
  const qsLoja = params.get('loja') || '';
  const qsQ    = params.get('q')    || '';

  // Preenche inputs com QS (ou vazio)
  if ($('#filtro-data-de'))  $('#filtro-data-de').value  = qsFrom || '';
  if ($('#filtro-data-ate')) $('#filtro-data-ate').value = qsTo   || '';
  if (qsSt && $('#filtro-status'))        $('#filtro-status').value = qsSt;
  if (qsLoja && $('#filtro-loja'))        $('#filtro-loja').value   = qsLoja;
  if (qsQ && $('#filtro-busca'))          $('#filtro-busca').value  = qsQ;

  // Se o select de itens/página existir com valor inicial, respeite-o
  const selPageSize = $('#filtro-itens-pagina');
  if (selPageSize) {
    const v = parseInt(selPageSize.value, 10);
    if (Number.isFinite(v) && v > 0) state.pageSize = v;
  }

  // Toggle filtros
  const toggleBtn = document.getElementById('toggle-filtros');
  if (toggleBtn) toggleBtn.addEventListener('click', () => {
    const isExpanded = toggleBtn.getAttribute('aria-expanded') === 'true';
    toggleBtn.setAttribute('aria-expanded', String(!isExpanded));
    document.getElementById('filtros-conteudo')?.classList.toggle('is-collapsed', isExpanded);
  });

  // Ações filtros
  $('#filtro-itens-pagina')?.addEventListener('change', (e) => {
    state.pageSize = Number.parseInt(e.target.value, 10) || 50; state.page = 1; loadLogs();
  });
  $('#botao-aplicar')?.addEventListener('click', () => { state.page = 1; loadLogs(); });
  $('#botao-limpar')?.addEventListener('click', () => {
    ['#filtro-data-de','#filtro-data-ate','#filtro-status','#filtro-responsavel','#filtro-loja','#filtro-busca']
      .forEach(sel => { const el = $(sel); if (el) el.value = ''; });
    state.page = 1; // não recoloca mês — fica vazio para puxar tudo
    loadLogs();
  });

  // Ordenação
  $$('th[data-col]').forEach(th => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      const col = th.getAttribute('data-col');
      if (state.orderBy === col) state.orderDir = state.orderDir === 'asc' ? 'desc' : 'asc';
      else { state.orderBy = col; state.orderDir = 'asc'; }
      $$('th[data-col]').forEach(h => h.setAttribute('aria-sort', 'none'));
      th.setAttribute('aria-sort', state.orderDir === 'asc' ? 'ascending' : 'descending');
      state.page = 1;
      loadLogs();
    });
  });

  // Pager
  $('#botao-anterior')?.addEventListener('click', () => { if (state.page > 1) { state.page--; loadLogs(); }});
  $('#botao-proxima') ?.addEventListener('click', () => { state.page++; loadLogs(); });

  // Live search
  const onSearch = debounce(() => { state.page = 1; loadLogs(); }, 350);
  $('#filtro-busca')?.addEventListener('input', onSearch);

  // Primeiro carregamento
  loadLogs();
});
