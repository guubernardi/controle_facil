/* util */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const money = (v) => Number(v || 0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});

let state = {
  page: 1,
  pageSize: 50,
  orderBy: 'event_at',
  orderDir: 'desc',
  total: 0,
  sum: 0,
  items: []
};

function getFilters() {
  return {
    from: $('#filtro-data-de')?.value || '',
    to:   $('#filtro-data-ate')?.value || '',
    status: $('#filtro-status')?.value || '',
    log_status: '',
    responsavel: $('#filtro-responsavel')?.value || '',
    loja: $('#filtro-loja')?.value || '',
    q: $('#filtro-busca')?.value || '',
    page: String(state.page),
    pageSize: String(state.pageSize),
    orderBy: state.orderBy,
    orderDir: state.orderDir
  };
}

function buildQuery(obj) {
  const u = new URLSearchParams();
  Object.entries(obj).forEach(([k,v]) => { if (v!=='' && v!=null) u.set(k,v); });
  return u.toString();
}

async function loadLogs() {
  const tbody = $('#corpo-tabela');
  tbody.innerHTML = `<tr><td colspan="6" class="celula-carregando"><div class="loading-spinner"></div> Carregando…</td></tr>`;

  try {
    const qs = buildQuery(getFilters());
    const r = await fetch(`/api/returns/logs?${qs}`);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Falha ao buscar log');

    state.total = j.total || 0;
    state.sum = j.sum_total || 0;
    state.items = Array.isArray(j.items) ? j.items : [];

    renderTable();
    renderSummary();
    renderPager();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" class="celula-carregando">Erro: ${e.message}</td></tr>`;
    toast(`Erro ao carregar: ${e.message}`);
  }
}

function renderSummary() {
  $('#total-registros').textContent = state.total.toLocaleString('pt-BR');
  $('#soma-periodo').textContent = money(state.sum);
}

function renderTable() {
  const tbody = $('#corpo-tabela');
  if (!state.items.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="celula-carregando">Nada encontrado.</td></tr>`;
    return;
  }

  tbody.innerHTML = state.items.map(it => {
    const dt = it.event_at ? new Date(it.event_at) : null;
    const dataFmt = dt ? dt.toLocaleString('pt-BR') : '—';
    const status = (it.status || '').toLowerCase();
    const tag =
      status.includes('rej') ? 'tag -neg' :
      status.includes('aprov') ? 'tag -ok' :
      status.includes('pend') ? 'tag -warn' : 'tag';

    return `
      <tr data-id="${it.return_id ?? ''}">
        <td>${dataFmt}</td>
        <td>${it.numero_pedido ?? '—'}</td>
        <td>${it.cliente_nome ?? '—'}</td>
        <td>${it.loja_nome ?? '—'}</td>
        <td><span class="${tag}">${it.status ?? '—'}</span></td>
        <td class="texto-direita">${money(it.total)}</td>
      </tr>
    `;
  }).join('');
}

function renderPager() {
  const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
  $('#info-paginacao').textContent = `Página ${state.page} de ${pages}`;
  $('#botao-anterior').disabled = state.page <= 1;
  $('#botao-proxima').disabled  = state.page >= pages;
}

// Toast
function toast(msg) {
  const el = $('#toast');
  el.querySelector('.toast-message').textContent = msg;
  el.classList.add('is-visible');
  clearTimeout(toast._t);
  toast._t = setTimeout(()=> el.classList.remove('is-visible'), 3500);
}

// Debounce helper
function debounce(fn, wait) {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(()=> fn(...args), wait); };
}

/* eventos */
document.addEventListener('DOMContentLoaded', () => {
  // tamanho da página
  $('#filtro-itens-pagina')?.addEventListener('change', (e) => {
    state.pageSize = parseInt(e.target.value, 10) || 50;
    state.page = 1;
    loadLogs();
  });

  // aplicar / limpar
  $('#botao-aplicar')?.addEventListener('click', () => { state.page = 1; loadLogs(); });
  $('#botao-limpar')?.addEventListener('click', () => {
    ['#filtro-data-de','#filtro-data-ate','#filtro-status','#filtro-responsavel','#filtro-loja','#filtro-busca']
      .forEach(sel => { const el = $(sel); if (el) el.value = ''; });
    state.page = 1;
    loadLogs();
  });

  // ordenar por cabeçalho
  $$('th[data-col]').forEach(th => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      const col = th.getAttribute('data-col');
      if (state.orderBy === col) {
        state.orderDir = state.orderDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.orderBy = col;
        state.orderDir = 'asc';
      }
      // aria-sort feedback visual
      $$('th[data-col]').forEach(h => h.setAttribute('aria-sort','none'));
      th.setAttribute('aria-sort', state.orderDir === 'asc' ? 'ascending' : 'descending');
      loadLogs();
    });
  });

  // paginação
  $('#botao-anterior')?.addEventListener('click', () => { if (state.page > 1) { state.page--; loadLogs(); } });
  $('#botao-proxima')?.addEventListener('click',  () => { state.page++; loadLogs(); });

  // export CSV
  $('#botao-exportar')?.addEventListener('click', async () => {
    try {
      const qs = buildQuery({ ...getFilters(), page: '1', pageSize: '1000' });
      const r = await fetch(`/api/returns/logs?${qs}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Falha ao exportar.');

      const rows = Array.isArray(j.items) ? j.items : [];
      const head = ['Data','Pedido','Cliente','Loja','Status','Total'];
      const csv = [
        head.join(';'),
        ...rows.map(x => [
          (x.event_at ? new Date(x.event_at).toISOString() : ''),
          x.numero_pedido ?? '',
          String(x.cliente_nome ?? '').replace(/;/g, ','),
          String(x.loja_nome ?? '').replace(/;/g, ','),
          x.status ?? '',
          String(x.total ?? '0').replace('.', ',')
        ].join(';'))
      ].join('\r\n');

      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `log-de-custos-${new Date().toISOString().slice(0,10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast('Exportação concluída');
    } catch (e) { toast(e.message || 'Falha ao exportar'); }
  });

  // ======== Importar CSV (com dry-run) ========
  const input = document.getElementById('inputCsv');
  const btn   = document.getElementById('btnImportarCsv');
  const dryEl = document.getElementById('chkDryRun');

  btn?.addEventListener('click', () => input?.click());

  input?.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      const dry  = dryEl?.checked ? '1' : '0';

      const r = await fetch(`/api/csv/upload?dry=${dry}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv; charset=utf-8' },
        body: text
      });

      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Falha ao importar.');

      toast(`Importação ${dry==='1' ? '(SIMULAÇÃO) ' : ''}ok: linhas lidas ${j.linhas_lidas}, conciliadas ${j.conciliadas}, ignoradas ${j.ignoradas}`);
      loadLogs();
    } catch (e) {
      toast('Erro ao importar CSV: ' + (e.message || e));
    } finally {
      input.value = '';
    }
  });

  // Busca com debounce para melhor alinhamento de UX
  const onSearch = debounce(() => { state.page = 1; loadLogs(); }, 350);
  $('#filtro-busca')?.addEventListener('input', onSearch);

  // Primeira carga
  loadLogs();
});
