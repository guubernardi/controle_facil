async function carregarDashboard({ from = null, to = null, limitTop = 5 } = {}) {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  params.set('limitTop', String(limitTop));

  const r = await fetch(`/api/dashboard?${params.toString()}`);
  if (!r.ok) throw new Error('Falha ao carregar dashboard');
  const data = await r.json();

  preencherRanking(data.top_items);
  desenharGraficoPrejuizo(data.daily);
  preencherResumo(data.totals);
}

// Ranking (lista simples)
function preencherRanking(items) {
  const el = document.getElementById('ranking-lista');
  el.innerHTML = '';
  if (!items || !items.length) {
    el.innerHTML = `<div class="descricao-card">Nenhum item no período.</div>`;
    return;
  }
  items.forEach(it => {
    const div = document.createElement('div');
    div.className = 'ranking-item';
    div.innerHTML = `
      <div class="sku">${escapeHtml(it.sku)}</div>
      <div class="qtd">${it.devolucoes}x</div>
      <div class="prejuizo">R$ ${Number(it.prejuizo||0).toFixed(2).replace('.', ',')}</div>
    `;
    el.appendChild(div);
  });
}

// Gráfico SVG linha simples do prejuízo diário
function desenharGraficoPrejuizo(series) {
  const el = document.getElementById('grafico-prejuizo');
  el.innerHTML = '';
  if (!series || !series.length) {
    el.innerHTML = `<div class="descricao-card">Sem dados para o período.</div>`;
    return;
  }

  // Normaliza pontos [0..1]
  const valores = series.map(d => Number(d.prejuizo || 0));
  const max = Math.max(...valores, 1);
  const pts = valores.map((v, i) => ({
    x: i/(valores.length-1 || 1),
    y: 1 - (v/max)
  }));

  const w = 600, h = 220, pad = 20;
  const path = pts.map((p, i) => `${i?'L':'M'} ${pad + p.x*(w-2*pad)} ${pad + p.y*(h-2*pad)}`).join(' ');
  const area = pts.concat([{x:1, y:1}, {x:0, y:1}])
                  .map((p, i) => `${i?'L':'M'} ${pad + p.x*(w-2*pad)} ${pad + p.y*(h-2*pad)}`).join(' ') + ' Z';

  el.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <path d="${area}" fill="hsla(0,84%,60%,0.10)"></path>
      <path d="${path}" stroke="var(--destructive)" stroke-width="2" fill="none"></path>
    </svg>
  `;
}

// Resumo (totais + prejuízo)
function preencherResumo(totals) {
  const el = document.getElementById('resumo-periodo');
  el.innerHTML = `
    <div class="resumo-item"><span class="label">Devoluções:</span><span class="valor">${totals.total||0}</span></div>
    <div class="resumo-item"><span class="label">Pendentes:</span><span class="valor">${totals.pendentes||0}</span></div>
    <div class="resumo-item"><span class="label">Aprovadas:</span><span class="valor">${totals.aprovadas||0}</span></div>
    <div class="resumo-item"><span class="label">Rejeitadas:</span><span class="valor">${totals.rejeitadas||0}</span></div>
    <div class="resumo-item"><span class="label">Prejuízo total:</span><span class="valor" style="color:var(--destructive)">R$ ${Number(totals.prejuizo_total||0).toFixed(2).replace('.', ',')}</span></div>
  `;
}

// Utilitário simples
function escapeHtml(s='') {
  return String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

// Chamar ao carregar a página (você pode passar período)
document.addEventListener('DOMContentLoaded', () => {
  carregarDashboard().catch(console.error);
});

function escapeHtml(s=''){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}

async function carregarDashboard({ from=null, to=null, limitTop=5 } = {}) {
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to)   qs.set('to', to);
  qs.set('limitTop', String(limitTop));

  const r = await fetch(`/api/dashboard?${qs.toString()}`);
  if (!r.ok) throw new Error('Falha ao carregar dashboard');
  const data = await r.json();

  // totais
  document.getElementById('dash-total').textContent = data.totals.total || 0;
  document.getElementById('dash-pend').textContent  = data.totals.pendentes || 0;
  document.getElementById('dash-aprov').textContent = data.totals.aprovadas || 0;
  document.getElementById('dash-rej').textContent   = data.totals.rejeitadas || 0;

  // blocos
  preencherRanking(data.top_items, data.totals.total || 0);
  desenharGraficoPrejuizo(data.daily);
  preencherResumo(data.totals);
}

function preencherRanking(items, total) {
  const el = document.getElementById('ranking-lista');
  el.innerHTML = '';
  if (!items?.length) { el.innerHTML = `<div class="descricao-card">Sem dados.</div>`; return; }

  items.forEach(it => {
    const part = total ? ((it.devolucoes/total)*100) : 0;
    const div = document.createElement('div');
    div.className = 'ranking-item';
    div.innerHTML = `
      <div class="sku">${escapeHtml(it.sku)}</div>
      <div class="qtd">${it.devolucoes}x (${part.toFixed(1)}%)</div>
      <div class="prejuizo">R$ ${Number(it.prejuizo||0).toFixed(2).replace('.', ',')}</div>
    `;
    el.appendChild(div);
  });
}

function desenharGraficoPrejuizo(series) {
  const el = document.getElementById('grafico-prejuizo');
  el.innerHTML = '';
  if (!series?.length) { el.innerHTML = `<div class="descricao-card">Sem dados.</div>`; return; }

  const valores = series.map(d => Number(d.prejuizo||0));
  const max = Math.max(...valores, 1);
  const pts = valores.map((v,i)=>({x:i/(valores.length-1||1),y:1-(v/max)}));

  const w=600,h=220,p=20;
  const path = pts.map((pnt,i)=>`${i?'L':'M'} ${p + pnt.x*(w-2*p)} ${p + pnt.y*(h-2*p)}`).join(' ');
  const area = pts.concat([{x:1,y:1},{x:0,y:1}])
                  .map((pnt,i)=>`${i?'L':'M'} ${p + pnt.x*(w-2*p)} ${p + pnt.y*(h-2*p)}`).join(' ')+' Z';
  el.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <path d="${area}" fill="hsla(0,84%,60%,.10)"></path>
      <path d="${path}" stroke="var(--destructive)" stroke-width="2" fill="none"></path>
    </svg>`;
}

function preencherResumo(t) {
  const el = document.getElementById('resumo-periodo');
  el.innerHTML = `
    <div class="resumo-item"><span class="label">Devoluções:</span><span class="valor">${t.total||0}</span></div>
    <div class="resumo-item"><span class="label">Pendentes:</span><span class="valor">${t.pendentes||0}</span></div>
    <div class="resumo-item"><span class="label">Aprovadas:</span><span class="valor">${t.aprovadas||0}</span></div>
    <div class="resumo-item"><span class="label">Rejeitadas:</span><span class="valor">${t.rejeitadas||0}</span></div>
    <div class="resumo-item"><span class="label">Prejuízo total:</span>
      <span class="valor" style="color:var(--destructive)">R$ ${Number(t.prejuizo_total||0).toFixed(2).replace('.', ',')}</span>
    </div>`;
}

// filtros
document.addEventListener('DOMContentLoaded', () => {
  // mês atual por padrão
  const hoje = new Date();
  const from = new Date(hoje.getFullYear(), hoje.getMonth(), 1).toISOString().slice(0,10);
  const to   = new Date(hoje.getFullYear(), hoje.getMonth()+1, 1).toISOString().slice(0,10);
  document.getElementById('filtro-from').value = from;
  document.getElementById('filtro-to').value = to;

  carregarDashboard({from, to}).catch(console.error);

  document.getElementById('btn-aplicar').addEventListener('click', () => {
    const f = document.getElementById('filtro-from').value || null;
    const t = document.getElementById('filtro-to').value || null;
    carregarDashboard({from:f, to:t}).catch(console.error);
  });
});
