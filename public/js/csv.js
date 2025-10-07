// csv.js (substitua todo o arquivo por este)

// ---------- helpers ----------
const $ = (sel) => document.querySelector(sel);
const toastBox = $('#toastContainer');

function showToast(type, title, description = '') {
  const icons = {
    success: `<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
    error:   `<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
    info:    `<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`
  };
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `${icons[type] || ''}<div class="toast-content"><div class="toast-title">${title}</div>${description ? `<div class="toast-description">${description}</div>` : ''}</div>`;
  toastBox.appendChild(el);
  setTimeout(() => {
    el.style.animation = 'slideInRight .3s ease-out reverse';
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

async function apiGet(path, asText = false) {
  const r = await fetch(path, { headers: { 'Accept': asText ? 'text/plain' : 'application/json' } });
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
  return asText ? r.text() : r.json();
}

async function apiPostCsv(text, filename, { dryRun = false, idempBatch = '' } = {}) {
  const params = new URLSearchParams({ autocreate: '1' });
  if (dryRun) params.set('dry', '1');
  if (idempBatch) params.set('idemp_batch', idempBatch);

  const url = `/api/csv/upload?${params.toString()}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'X-Filename': filename || 'upload.csv',
      'Accept': 'application/json'
    },
    body: text
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error || `Falha ao enviar CSV (HTTP ${r.status})`;
    throw new Error(msg);
  }
  return data;
}

function fmtMoneyBRL(n) {
  const v = Number(n || 0);
  try { return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
  catch { return `R$ ${v.toFixed(2)}`; }
}

function parseStatusBadge(st) {
  const s = String(st || '').toLowerCase();
  if (s.includes('aprov')) return { label: 'Aprovado', klass: 'badge-approved' };
  if (s.includes('rej') || s.includes('neg')) return { label: 'Rejeitado', klass: 'badge-rejected' };
  return { label: 'Pendente', klass: 'badge-pending' };
}

// ---------- DOM refs ----------
const uploadArea   = $('#uploadArea');
const fileInput    = $('#fileInput');
const fileSelected = $('#fileSelected');
const fileNameEl   = $('#fileName');
const uploadBtn    = $('#uploadBtn');

const searchInput  = $('#searchInput');
const statusFilter = $('#statusFilter');
const returnsList  = $('#returnsList');
const emptyState   = $('#emptyState');
const resultsCount = $('#resultsCount');

// extras novos
const idempInput   = document.getElementById('idempBatch');
const btnTplDefault = document.getElementById('btnTplDefault');
const btnTplAC      = document.getElementById('btnTplAC');

// KPIs refs
const statTotal    = $('#stat-total');
const statPending  = $('#stat-pending');
const statApproved = $('#stat-approved');
const statRejected = $('#stat-rejected');

// state
let selectedFile = null;
let allItems = [];   // vindo da API
let filtered = [];

// ---------- UPLOAD UI ----------
uploadArea.addEventListener('click', () => fileInput.click());
uploadArea.addEventListener('dragover', (e) => {
  e.preventDefault(); uploadArea.classList.add('drag-over');
});
uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('drag-over'));
uploadArea.addEventListener('drop', (e) => {
  e.preventDefault(); uploadArea.classList.remove('drag-over');
  const f = e.dataTransfer.files?.[0];
  if (f) handleFile(f);
});
fileInput.addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (f) handleFile(f);
});

function handleFile(file) {
  if (!file.name.toLowerCase().endsWith('.csv')) {
    showToast('error','Formato inválido','Envie um arquivo .csv');
    return;
  }
  selectedFile = file;
  fileNameEl.textContent = file.name;
  fileSelected.hidden = false;
  uploadBtn.disabled = false;
  showToast('success','Arquivo carregado', file.name);
}

async function doUpload() {
  if (!selectedFile) {
    showToast('error','Nenhum arquivo selecionado');
    return;
  }
  try {
    uploadBtn.disabled = true;
    const originalHtml = uploadBtn.innerHTML;
    uploadBtn.innerHTML = `<div class="btn-spinner"></div> Processando...`;

    const text = await selectedFile.text();
    const idempBatch = (idempInput?.value || '').trim();

    // 1) Dry-run primeiro (contrato novo: total/created/updated/errors)
    const probe = await apiPostCsv(text, selectedFile.name, { dryRun: true, idempBatch });
    const resumoProbe = `Linhas: ${probe.total} • atualizaria: ${probe.updated} • criaria: ${probe.created} • erros: ${probe.errors}`;
    showToast('info','Dry-run concluído', resumoProbe);

    // lista de erros (se houver)
    if (Array.isArray(probe.errors_detail) && probe.errors_detail.length) {
      const msg = probe.errors_detail.slice(0, 5).map(e => `L${e.line}: ${e.error}`).join(' | ');
      showToast('error', 'Erros no CSV', msg + (probe.errors_detail.length > 5 ? ' ...' : ''));
      uploadBtn.innerHTML = originalHtml;
      uploadBtn.disabled = false;
      return;
    }

    // 2) Confirmar
    const apply = confirm(`Dry-run OK.\n${resumoProbe}\n\nAplicar no banco agora?`);
    if (!apply) {
      uploadBtn.innerHTML = originalHtml;
      uploadBtn.disabled = false;
      return;
    }

    // 3) Valendo
    const applied = await apiPostCsv(text, selectedFile.name, { dryRun: false, idempBatch });
    const resumoApplied = `criadas: ${applied.created} • atualizadas: ${applied.updated} • erros: ${applied.errors}`;
    if (applied.skipped) {
      showToast('info','Lote ignorado', applied.reason || 'Batch já processado');
    } else {
      showToast('success','CSV processado', resumoApplied);
    }

    // reset UI
    selectedFile = null;
    fileInput.value = '';
    fileSelected.hidden = true;
    uploadBtn.innerHTML = originalHtml;
    uploadBtn.disabled = true;

    // refresh
    await Promise.all([loadKpis(), loadReturns()]);
    render();
  } catch (e) {
    showToast('error','Falha no upload', String(e.message || e));
    uploadBtn.disabled = false;
    uploadBtn.innerHTML = `
      <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="17 8 12 3 7 8"/>
        <line x1="12" y1="3" x2="12" y2="15"/>
      </svg>
      Enviar CSV
    `;
  }
}
uploadBtn.addEventListener('click', doUpload);

// ---------- TEMPLATES ----------
async function downloadCsv(content, filename) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
}

btnTplDefault?.addEventListener('click', async () => {
  try {
    const csv = await apiGet('/api/csv/template', true);
    await downloadCsv(csv, 'modelo-ml-default.csv');
  } catch (e) {
    showToast('error','Falha ao baixar modelo default', String(e.message || e));
  }
});

btnTplAC?.addEventListener('click', async () => {
  try {
    const csv = await apiGet('/api/csv/template?layout=after_collection', true);
    await downloadCsv(csv, 'modelo-ml-after_collection.csv');
  } catch (e) {
    showToast('error','Falha ao baixar modelo after_collection', String(e.message || e));
  }
});

// ---------- LISTAGEM / KPIs ----------
async function loadKpis() {
  try {
    const k = await apiGet('/api/home/kpis');
    statTotal.textContent    = k.total ?? 0;
    statPending.textContent  = k.pendentes ?? 0;
    statApproved.textContent = k.aprovadas ?? 0;
    statRejected.textContent = k.rejeitadas ?? 0;
  } catch {}
}

function mapLogToCard(x) {
  const badge = parseStatusBadge(x.status);
  const dt = x.event_at ? new Date(x.event_at) : null;
  const datePt = dt ? dt.toLocaleDateString('pt-BR') : '-';

  return {
    id: x.return_id ?? x.numero_pedido ?? '—',
    date: datePt,
    sku: x.sku ?? '—',
    customer: x.cliente_nome ?? x.loja_nome ?? '—',
    reason: x.reclamacao ?? '—',
    status: (badge.label === 'Aprovado' ? 'approved'
           : badge.label === 'Rejeitado' ? 'rejected' : 'pending'),
    value: fmtMoneyBRL(x.total ?? (Number(x.valor_produto||0)+Number(x.valor_frete||0)))
  };
}

function createReturnCard(item) {
  const statusMap = {
    pending:  { label: 'Pendente',  cls: 'badge-pending'  },
    approved: { label: 'Aprovado',  cls: 'badge-approved' },
    rejected: { label: 'Rejeitado', cls: 'badge-rejected' }
  };
  const st = statusMap[item.status] || statusMap.pending;

  return `
  <div class="return-card">
    <div class="return-header">
      <div class="return-info">
        <div class="return-id-row">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
          </svg>
          <h3 class="return-id">Devolução #${item.id}</h3>
        </div>
        <p class="return-sku">SKU: ${item.sku}</p>
      </div>
      <span class="badge ${st.cls}">${st.label}</span>
    </div>

    <div class="return-details">
      <div class="detail-item">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
          <line x1="16" y1="2" x2="16" y2="6"/>
          <line x1="8" y1="2" x2="8" y2="6"/>
          <line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
        <span class="detail-value">${item.date}</span>
      </div>

      <div class="detail-item">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
          <circle cx="12" cy="7" r="4"/>
        </svg>
        <span class="detail-value">${item.customer}</span>
      </div>

      <div class="detail-item">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="1" x2="12" y2="23"/>
          <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
        </svg>
        <span class="detail-value highlight">${item.value}</span>
      </div>

      <div class="detail-item detail-reason">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <span class="detail-value">${item.reason}</span>
      </div>
    </div>

    <div class="flex-row" style="display:flex; gap:.5rem;">
      <button class="btn btn-outline" data-open="${item.id}">Ver Eventos</button>
      <a class="btn btn-outline" href="/api/returns/${item.id}/events?limit=100" target="_blank" rel="noopener">JSON</a>
    </div>
  </div>`;
}

async function loadReturns() {
  try {
    const data = await apiGet('/api/returns/logs?page=1&pageSize=20&orderBy=event_at&orderDir=desc');
    const items = Array.isArray(data.items) ? data.items : [];
    allItems = items.map(mapLogToCard);
  } catch {
    allItems = [];
  }
  filtered = allItems.slice();
}

function renderList() {
  const q = (searchInput.value || '').toLowerCase().trim();
  const status = statusFilter.value; // 'all' | 'pending' | 'approved' | 'rejected'

  filtered = allItems.filter(it => {
    const hit =
      it.id.toString().toLowerCase().includes(q) ||
      it.sku.toLowerCase().includes(q) ||
      it.customer.toLowerCase().includes(q);
    const stOk = status === 'all' || it.status === status;
    return hit && stOk;
  });

  if (filtered.length === 0) {
    returnsList.innerHTML = '';
    emptyState.hidden = false;
  } else {
    emptyState.hidden = true;
    returnsList.innerHTML = filtered.map(createReturnCard).join('');
  }
  resultsCount.textContent = `${filtered.length} resultado(s) encontrado(s)`;

  returnsList.querySelectorAll('[data-open]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-open');
      try {
        const data = await apiGet(`/api/returns/${id}/events?limit=100`);
        const n = (Array.isArray(data.items) ? data.items : []).length;
        showToast('info', `Eventos #${id}`, `${n} evento(s) encontrado(s). Abrindo em nova aba...`);
        window.open(`/api/returns/${id}/events?limit=100`, '_blank', 'noopener');
      } catch (e) {
        showToast('error','Falha ao abrir eventos', String(e.message || e));
      }
    });
  });
}

function render() { renderList(); }

// ---------- filtros ----------
searchInput.addEventListener('input', renderList);
statusFilter.addEventListener('change', renderList);

// ---------- boot ----------
(async function init() {
  try {
    await Promise.all([loadKpis(), loadReturns()]);
    render();
  } catch {
    render();
  }
})();
