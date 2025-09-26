/*
  dashboard.js — usa Chart.js para renderizar gráficos interativos.
  - inicializa 4 charts (dia, mês, 6 meses, status)
  - busca /api/dashboard?from=...&to=...&limitTop=...
  - atualiza resumos e ranking
*/

let chartDay = null;
let chartMes = null;
let chart6Mes = null;
let chartStatus = null;

function escapeHtml(s='') { return String(s).replace(/[&<>'"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }

function getCssVar(name, fallback) {
  try { const v = getComputedStyle(document.documentElement).getPropertyValue(name); return v ? v.trim() : fallback; } catch(e){ return fallback; }
}

function initCharts() {
  const accent = getCssVar('--accent', '#ff7a00');
  const destructive = getCssVar('--destructive', '#e11d48');
  const primary = getCssVar('--primary', '#0b5fff');

  const ctxDay = document.getElementById('chart-prejuizo-dia')?.getContext('2d');
  const ctxMes = document.getElementById('chart-prejuizo-mes')?.getContext('2d');
  const ctx6 = document.getElementById('chart-prejuizo-6mes')?.getContext('2d');
  const ctxStatus = document.getElementById('chart-status')?.getContext('2d');

  if (ctxDay) chartDay = new Chart(ctxDay, {
    type: 'bar',
    data: { labels: [], datasets: [{ label: 'Prejuízo (R$)', data: [], backgroundColor: destructive }] },
    options: { 
      responsive:true, maintainAspectRatio:false, 
      scales:{ y:{ ticks:{ callback: v => v ? Number(v).toLocaleString('pt-BR', {minimumFractionDigits:2, maximumFractionDigits:2}) : '0,00' } } },
      plugins:{ legend:{ display:false }, tooltip:{ callbacks:{ label: ctx => `R$ ${Number(ctx.parsed.y||0).toLocaleString('pt-BR', {minimumFractionDigits:2})}` } } }
    }
  });

  if (ctxMes) chartMes = new Chart(ctxMes, {
    type: 'bar',
    data: { labels: [], datasets: [{ label: 'Prejuízo (R$)', data: [], backgroundColor: destructive }] },
    options: { 
      responsive:true, maintainAspectRatio:false, 
      scales:{ 
        x:{ ticks:{ maxRotation:45, minRotation:0, callback: function(val, idx){ const label = this.getLabelForValue(val) || ''; return label.length>12? label.slice(0,12)+'…': label } } },
        y:{ ticks:{ callback: v => v ? Number(v).toLocaleString('pt-BR', {minimumFractionDigits:2}) : '0,00' } }
      },
      plugins:{ legend:{ display:false }, tooltip:{ callbacks:{ label: ctx => `R$ ${Number(ctx.parsed.y||0).toLocaleString('pt-BR', {minimumFractionDigits:2})}` } } }
    }
  });

  if (ctx6) chart6Mes = new Chart(ctx6, {
    type: 'bar',
    data: { labels: [], datasets: [{ label: 'Prejuízo (R$)', data: [], backgroundColor: destructive }] },
    options: { 
      responsive:true, maintainAspectRatio:false, 
      scales:{ y:{ ticks:{ callback: v => v ? Number(v).toLocaleString('pt-BR', {minimumFractionDigits:2}) : '0,00' } } },
      plugins:{ legend:{ display:false }, tooltip:{ callbacks:{ label: ctx => `R$ ${Number(ctx.parsed.y||0).toLocaleString('pt-BR', {minimumFractionDigits:2})}` } } }
    }
  });

  if (ctxStatus) chartStatus = new Chart(ctxStatus, {
    type: 'pie',
    data: { labels: [], datasets: [{ data: [], backgroundColor: [primary, accent, destructive, '#6b7280'] }] },
    options: { responsive:true, maintainAspectRatio:false, plugins:{ tooltip:{ callbacks:{ label: ctx => `${ctx.label}: ${Number(ctx.parsed||0).toLocaleString('pt-BR')}` } } } }
  });
}

// atualiza os charts com os dados do endpoint
function updateCharts(data) {
  // day (últimos 30 dias)
  if (chartDay) {
    const pontos = (data.daily || []).slice(-30);
    const labels = pontos.map(d => d.date || d.day || d.label || '');
    const valores = pontos.map(d => Number(d.prejuizo || 0));
    chartDay.data.labels = labels;
    chartDay.data.datasets[0].data = valores;
    chartDay.update();
  }

  // mês (agrupa por dia)
  if (chartMes) {
    const series = data.daily || [];
    const grouped = {};
    series.forEach(d => { const k = (d.date||d.day||d.label||''); grouped[k] = (grouped[k]||0) + Number(d.prejuizo||0); });
    const keys = Object.keys(grouped).sort();
    chartMes.data.labels = keys;
    chartMes.data.datasets[0].data = keys.map(k => grouped[k]);
    chartMes.update();
  }

  // últimos 6 meses
  if (chart6Mes) {
    const months = data.monthly || [];
    const labels = months.map(m => m.month || m.label || `${m.year}-${m.month}`);
    const valores = months.map(m => Number(m.prejuizo || 0));
    chart6Mes.data.labels = labels;
    chart6Mes.data.datasets[0].data = valores;
    chart6Mes.update();
  }

  // status pie
  if (chartStatus) {
    const statusObj = data.status || {};
    const entries = Object.entries(statusObj);
    chartStatus.data.labels = entries.map(e => e[0]);
    chartStatus.data.datasets[0].data = entries.map(e => Number(e[1]||0));
    chartStatus.update();
  }
}

// ranking como tabela compacta
function preencherRanking(items) {
  const el = document.getElementById('ranking-lista');
  el.innerHTML = '';
  if (!items || !items.length) { el.innerHTML = `<div class="descricao-card">Nenhum item no período.</div>`; return; }

  const sorted = items.slice().sort((a,b) => (b.devolucoes||0) - (a.devolucoes||0));
  // Render como lista de blocos para melhor visual
  el.setAttribute('role', 'list');
  sorted.forEach((it, idx) => {
    const pos = idx + 1;
    const raw = String(it.sku || it.nome || it.title || '—');
    const sku = escapeHtml(raw);
    const devol = Number(it.devolucoes || 0);
    const preju = Number(it.prejuizo || 0);
    const valorFormatado = preju.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

    const item = document.createElement('div');
    item.className = 'ranking-item' + (pos <= 3 ? ` top-${pos}` : '');
    item.setAttribute('role', 'listitem');
    item.innerHTML = `
      <div class="meta">
        <div class="pos">#${pos}</div>
        <div class="nome" title="${sku}">${sku.length > 40 ? sku.slice(0,40) + '…' : sku}</div>
      </div>
      <div class="stats">
        <div class="devol">${devol}x</div>
        <div class="valor">${valorFormatado}</div>
      </div>
    `;
    el.appendChild(item);
  });
}

function preencherResumo(totals) {
  const el = document.getElementById('resumo-periodo');
  el.innerHTML = `
    <div class="resumo-item"><span class="label">Devoluções:</span><span class="valor">${totals.total||0}</span></div>
    <div class="resumo-item"><span class="label">Pendentes:</span><span class="valor">${totals.pendentes||0}</span></div>
    <div class="resumo-item"><span class="label">Aprovadas:</span><span class="valor">${totals.aprovadas||0}</span></div>
    <div class="resumo-item"><span class="label">Rejeitadas:</span><span class="valor">${totals.rejeitadas||0}</span></div>
    <div class="resumo-item"><span class="label">Prejuízo total:</span><span class="valor" style="color:var(--destructive)">R$ ${Number(totals.prejuizo_total||0).toFixed(2).replace('.', ',')}</span></div>`;
}

async function carregarDashboard({ from = null, to = null, limitTop = 5 } = {}) {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  params.set('limitTop', String(limitTop));

  let data = null;
  try{
    const r = await fetch(`/api/dashboard?${params.toString()}`);
    if (!r.ok) throw new Error('Falha ao carregar dashboard');
    data = await r.json();
  }catch(e){
    console.warn('Falha ao buscar /api/dashboard, usando mock local para desenvolvimento.', e);
    data = mockDashboardData();
  }

  // se data vazio, usar mock
  if(!data || Object.keys(data).length===0) data = mockDashboardData();

  // atualizar resumos rápidos
  document.getElementById('dash-total').textContent = data.totals.total || 0;
  document.getElementById('dash-pend').textContent = data.totals.pendentes || 0;
  document.getElementById('dash-aprov').textContent = data.totals.aprovadas || 0;
  document.getElementById('dash-rej').textContent = data.totals.rejeitadas || 0;

  preencherRanking(data.top_items || []);
  preencherResumo(data.totals || {});
  updateCharts(data);
}

// mock para desenvolvimento (executado quando API falha ou retorna vazio)
function mockDashboardData(){
  const today = new Date();
  const daily = Array.from({length:30}).map((_,i)=>{
    const d = new Date(today.getTime() - (29-i)*24*3600*1000);
    const label = d.toISOString().slice(0,10);
    return { date: label, prejuizo: Math.round(Math.random()*2000 - 200) };
  });
  const monthly = Array.from({length:6}).map((_,i)=>{
    const dt = new Date(today.getFullYear(), today.getMonth()-5+i, 1);
    return { month: dt.toLocaleString('pt-BR',{month:'short', year:'numeric'}), prejuizo: Math.round(Math.random()*8000) };
  });
  const status = { pendente: 12, aprovado: 34, rejeitado: 7 };
  const top_items = Array.from({length:5}).map((_,i)=>({ sku: 'SKU-'+(1000+i), devolucoes: Math.floor(Math.random()*20)+1, prejuizo: Math.round(Math.random()*1500) }));
  const totals = { total: 120, pendentes: 12, aprovadas: 80, rejeitadas: 28, prejuizo_total: monthly.reduce((s,m)=>s+Number(m.prejuizo||0),0) };
  return { daily, monthly, status, top_items, totals };
}

document.addEventListener('DOMContentLoaded', () => {
  initCharts();

  // filtros: padrão mês atual
  const hoje = new Date();
  const from = new Date(hoje.getFullYear(), hoje.getMonth(), 1).toISOString().slice(0,10);
  const to   = new Date(hoje.getFullYear(), hoje.getMonth()+1, 1).toISOString().slice(0,10);
  document.getElementById('filtro-from').value = from;
  document.getElementById('filtro-to').value = to;

  const showOnly = (id) => {
    ['chart-prejuizo-dia','chart-prejuizo-mes','chart-prejuizo-6mes','chart-status']
      .forEach(k => { const el = document.getElementById(k); if (el) el.style.display = (k===id? 'block' : 'none'); });
  };

  document.getElementById('btn-graf-dia')?.addEventListener('click', () => showOnly('chart-prejuizo-dia'));
  document.getElementById('btn-graf-mes')?.addEventListener('click', () => showOnly('chart-prejuizo-mes'));
  document.getElementById('btn-graf-6mes')?.addEventListener('click', () => showOnly('chart-prejuizo-6mes'));
  document.getElementById('btn-graf-status')?.addEventListener('click', () => showOnly('chart-status'));

  // carregar dados iniciais
  carregarDashboard({ from, to }).catch(console.error);

  document.getElementById('btn-aplicar')?.addEventListener('click', () => {
    const f = document.getElementById('filtro-from').value || null;
    const t = document.getElementById('filtro-to').value || null;
    carregarDashboard({ from: f, to: t }).catch(console.error);
  });
});
