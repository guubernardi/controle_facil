/*
  dashboard.js — usa Chart.js para renderizar gráficos interativos.
  - inicializa 4 charts (dia, mês, 6 meses, status)
  - busca /api/dashboard?from=...&to=...&limitTop=...
  - atualiza resumos e ranking
  - rótulos claros: "Abertas" e "Autorizadas p/ postagem"
*/

let chartDay = null;
let chartMes = null;
let chart6Mes = null;
let chartStatus = null;
let currentFetch = null; // AbortController

/* ------------------------------
   Utils
--------------------------------*/
function escapeHtml(s = '') {
  return String(s).replace(/[&<>'"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[c]));
}
function getCssVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return v ? v.trim() : fallback;
  } catch {
    return fallback;
  }
}
function currencyBR(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function updateLogLink(from, to) {
  const a = document.getElementById('link-log');
  if (!a) return;
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to)   qs.set('to', to);
  a.href = `/logs.html${qs.toString() ? '?' + qs.toString() : ''}`;
}

/* ------------------------------
   Texto explicativo (tooltips)
--------------------------------*/
const REGRAS_HINT =
  'Regras: Rejeitado = R$ 0,00 · Motivos do cliente = R$ 0,00 · Recebido no CD/Inspeção = só frete.';

/* ------------------------------
   Mapeamento de rótulos de status (front)
--------------------------------*/
const STATUS_LABELS = {
  pendente: 'Abertas',
  aprovado: 'Autorizadas p/ postagem',
  rejeitado: 'Rejeitadas',
  outros: 'Outros',
};

/* ------------------------------
   Cores/gradiente seguros
--------------------------------*/
function withAlphaHSL(hslColor, a = 1) {
  const c = String(hslColor || '').trim();
  if (!c) return `rgba(0,0,0,${a})`;
  if (/^hsla\(/i.test(c)) return c.replace(/hsla\(([^,]+,[^,]+,[^,]+),\s*[^)]+\)/i, (_, core) => `hsla(${core}, ${a})`);
  if (/^hsl\(/i.test(c))  return c.replace(/hsl\(([^)]+)\)/i, (_, core) => `hsla(${core}, ${a})`);
  return c;
}
function makeGradient(ctx, area, baseHsl) {
  if (!area) return withAlphaHSL(baseHsl, 0.85);
  const g = ctx.createLinearGradient(0, area.top, 0, area.bottom);
  g.addColorStop(0, withAlphaHSL(baseHsl, 0.85));
  g.addColorStop(1, withAlphaHSL(baseHsl, 0.18));
  return g;
}

/* ------------------------------
   Opções base para barras
--------------------------------*/
function baseBarOptions() {
  const gridColor = getCssVar('--border', '#e5e7eb');
  const textColor = getCssVar('--muted-foreground', '#6b7280');

  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 700, easing: 'easeOutCubic' },
    layout: { padding: { top: 8, right: 8, bottom: 0, left: 0 } },
    scales: {
      x: { grid: { display: false }, ticks: { color: textColor, maxRotation: 0, autoSkip: true } },
      y: {
        grid: { color: gridColor },
        border: { display: false },
        ticks: { color: textColor, callback: v => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 0 }) }
      }
    },
    plugins: {
      legend: { display: false },
      tooltip: { intersect: false, mode: 'index', callbacks: { label: (ctx) => currencyBR(ctx.parsed.y) } }
    }
  };
}

/* ------------------------------
   Inicialização dos gráficos
--------------------------------*/
function initCharts() {
  const accent      = getCssVar('--accent', '#ff7a00');       // ABERTAS
  const destructive = getCssVar('--destructive', '#e11d48');  // REJEITADAS
  const primary     = getCssVar('--primary', '#0b5fff');      // AUTORIZADAS
  const mutedBorder = getCssVar('--border', '#E5E7EB');

  const elDay    = document.getElementById('chart-prejuizo-dia');
  const elMes    = document.getElementById('chart-prejuizo-mes');
  const el6      = document.getElementById('chart-prejuizo-6mes');
  const elStatus = document.getElementById('chart-status');

  // Últimos 30 dias
  if (elDay) {
    const ctx = elDay.getContext('2d');
    chartDay = new Chart(ctx, {
      type: 'bar',
      data: { labels: [], datasets: [{
        label: 'Prejuízo (R$)',
        data: [],
        backgroundColor: (c) => makeGradient(c.chart.ctx, c.chart.chartArea, destructive),
        borderColor: withAlphaHSL(destructive, 1),
        borderWidth: 1,
        borderSkipped: false,
        borderRadius: 8,
        maxBarThickness: 36
      }]},
      options: {
        ...baseBarOptions(),
        scales: {
          ...baseBarOptions().scales,
          y: { ...baseBarOptions().scales.y,
            ticks: { ...baseBarOptions().scales.y.ticks,
              callback: (v) => currencyBR(v).replace('R$', '').trim()
            }
          }
        },
        plugins: {
          ...baseBarOptions().plugins,
          title: { display: true, text: 'Prejuízo (regra aplicada)', padding: { top: 4, bottom: 8 } },
          subtitle: { display: true, text: REGRAS_HINT, padding: { bottom: 8 } },
          tooltip: { ...baseBarOptions().plugins.tooltip,
            callbacks: { label: (ctx) => `Custo efetivo: ${currencyBR(ctx.parsed.y)}` }
          }
        }
      }
    });
  }

  // Mês atual
  if (elMes) {
    const ctx = elMes.getContext('2d');
    chartMes = new Chart(ctx, {
      type: 'bar',
      data: { labels: [], datasets: [{
        label: 'Prejuízo (R$)',
        data: [],
        backgroundColor: (c) => makeGradient(c.chart.ctx, c.chart.chartArea, destructive),
        borderColor: withAlphaHSL(destructive, 1),
        borderWidth: 1,
        borderSkipped: false,
        borderRadius: 8,
        maxBarThickness: 40
      }]},
      options: {
        ...baseBarOptions(),
        scales: {
          ...baseBarOptions().scales,
          x: { ...baseBarOptions().scales.x,
            ticks: { ...baseBarOptions().scales.x.ticks,
              callback: function (val) {
                const label = this.getLabelForValue(val) || '';
                return label.length > 12 ? label.slice(0, 12) + '…' : label;
              }
            }
          },
          y: { ...baseBarOptions().scales.y,
            ticks: { ...baseBarOptions().scales.y.ticks,
              callback: (v) => currencyBR(v).replace('R$', '').trim()
            }
          }
        },
        plugins: {
          ...baseBarOptions().plugins,
          title: { display: true, text: 'Prejuízo do mês (regra aplicada)', padding: { top: 4, bottom: 8 } },
          subtitle: { display: true, text: REGRAS_HINT, padding: { bottom: 8 } },
          tooltip: { ...baseBarOptions().plugins.tooltip,
            callbacks: { label: (ctx) => `Custo efetivo: ${currencyBR(ctx.parsed.y)}` }
          }
        }
      }
    });
  }

  // Últimos 6 meses
  if (el6) {
    const ctx = el6.getContext('2d');
    chart6Mes = new Chart(ctx, {
      type: 'bar',
      data: { labels: [], datasets: [{
        label: 'Prejuízo (R$)',
        data: [],
        backgroundColor: (c) => makeGradient(c.chart.ctx, c.chart.chartArea, destructive),
        borderColor: withAlphaHSL(destructive, 1),
        borderWidth: 1,
        borderSkipped: false,
        borderRadius: 10,
        maxBarThickness: 46
      }]},
      options: {
        ...baseBarOptions(),
        scales: {
          ...baseBarOptions().scales,
          y: { ...baseBarOptions().scales.y,
            ticks: { ...baseBarOptions().scales.y.ticks,
              callback: (v) => currencyBR(v).replace('R$', '').trim()
            }
          }
        },
        plugins: {
          ...baseBarOptions().plugins,
          title: { display: true, text: 'Prejuízo (últimos 6 meses)', padding: { top: 4, bottom: 8 } },
          subtitle: { display: true, text: REGRAS_HINT, padding: { bottom: 8 } },
          tooltip: { ...baseBarOptions().plugins.tooltip,
            callbacks: { label: (ctx) => `Custo efetivo: ${currencyBR(ctx.parsed.y)}` }
          }
        }
      }
    });
  }

  // Pizza por Status
  if (elStatus) {
    const ctx = elStatus.getContext('2d');
    chartStatus = new Chart(ctx, {
      type: 'pie',
      data: {
        labels: [],
        datasets: [{
          data: [],
          borderColor: mutedBorder,
          borderWidth: 1,
          backgroundColor: []
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 700, easing: 'easeOutCubic' },
        plugins: {
          legend: { position: 'bottom', labels: { usePointStyle: true } },
          title:   { display: true, text: 'Distribuição por status' },
          subtitle:{ display: true, text: 'Ajuda a entender a fase das devoluções.', padding: { top: 0, bottom: 6 } },
          tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${Number(ctx.parsed || 0).toLocaleString('pt-BR')}` } }
        }
      }
    });
  }
}

/* ------------------------------
   Atualiza os gráficos com dados
--------------------------------*/
function updateCharts(data) {
  // 30 dias
  if (chartDay) {
    const pontos = (data.daily || []).slice(-30);
    const labels = pontos.map(d => d.date || d.day || d.label || '');
    const valores = pontos.map(d => Number(d.prejuizo || 0));
    chartDay.data.labels = labels;
    chartDay.data.datasets[0].data = valores;
    chartDay.update();
  }

  // mês (usa série diária do período aplicado)
  if (chartMes) {
    const series = data.daily || [];
    const grouped = {};
    series.forEach(d => {
      const k = (d.date || d.day || d.label || '');
      grouped[k] = (grouped[k] || 0) + Number(d.prejuizo || 0);
    });
    const keys = Object.keys(grouped).sort();
    chartMes.data.labels = keys;
    chartMes.data.datasets[0].data = keys.map(k => grouped[k]);
    chartMes.update();
  }

  // 6 meses
  if (chart6Mes) {
    const months = data.monthly || [];
    const labels = months.map(m => m.month || m.label || `${m.year}-${m.month}`);
    const valores = months.map(m => Number(m.prejuizo || 0));
    chart6Mes.data.labels = labels;
    chart6Mes.data.datasets[0].data = valores;
    chart6Mes.update();
  }

  // pizza por status
  if (chartStatus) {
    const statusObj = data.status || {};
    const order = ['pendente', 'aprovado', 'rejeitado'];
    const values = [];
    const labels = [];
    const bg = [];

    const accent      = getCssVar('--accent', '#ff7a00');      // Abertas
    const primary     = getCssVar('--primary', '#0b5fff');     // Autorizadas p/ postagem
    const destructive = getCssVar('--destructive', '#e11d48'); // Rejeitadas
    const gray        = '#6b7280';
    const colorMap = { pendente: accent, aprovado: primary, rejeitado: destructive, outros: gray };

    order.forEach(k => {
      if (statusObj[k] != null) {
        labels.push(STATUS_LABELS[k] || k);
        values.push(Number(statusObj[k] || 0));
        bg.push(colorMap[k]);
      }
    });

    const otherSum = Object.entries(statusObj)
      .filter(([k]) => !order.includes(k))
      .reduce((acc, [,v]) => acc + Number(v || 0), 0);

    if (otherSum > 0) {
      labels.push(STATUS_LABELS.outros);
      values.push(otherSum);
      bg.push(colorMap.outros);
    }

    chartStatus.data.labels = labels;
    chartStatus.data.datasets[0].data = values;
    chartStatus.data.datasets[0].backgroundColor = bg;
    chartStatus.update();
  }
}

/* ------------------------------
   Ranking (lista moderna)
--------------------------------*/
function preencherRanking(items) {
  const el = document.getElementById('ranking-lista');
  if (!el) return;
  el.innerHTML = '';
  if (!items || !items.length) {
    el.innerHTML = `<div class="descricao-card">Nenhum item no período.</div>`;
    return;
  }

  const sorted = items.slice().sort((a, b) => (b.devolucoes || 0) - (a.devolucoes || 0));
  el.setAttribute('role', 'list');

  sorted.forEach((it, idx) => {
    const pos = idx + 1;
    // aceita diversas chaves, mas PRIORIZA SKU
    const skuTxt = String(
      it.sku || it.codigo_sku || it.seller_sku || it.title || it.nome || it.item || '—'
    );
    const sku = escapeHtml(skuTxt);
    const qtd = Number(it.devolucoes || 0);
    const preju = Number(it.prejuizo || 0);
    // aceita motivo_comum vindo do builder local
    const motivo = escapeHtml(String(it.motivo || it.motivo_comum || it.tipo_reclamacao || '—'));
    const prejuFmt = currencyBR(preju);

    const item = document.createElement('div');
    item.className = 'rk-item' + (pos <= 3 ? ` top-${pos}` : '');
    item.setAttribute('role', 'listitem');

    item.innerHTML = `
      <div class="rk-left">
        <div class="rk-pos">#${pos}</div>
        <div class="rk-info">
          <div class="rk-line rk-sku">
            <svg class="rk-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 16V8l-9-5-9 5v8l9 5 9-5z"></path>
              <path d="M3.3 7.3 12 12l8.7-4.7"></path>
              <path d="M12 22V12"></path>
            </svg>
            <span title="${sku}">${sku.length > 40 ? sku.slice(0,40) + '…' : sku}</span>
          </div>
          <div class="rk-meta">
            <span class="rk-chip" title="Quantidade de devoluções">
              <svg class="rk-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="23 4 23 10 17 10"></polyline>
                <polyline points="1 20 1 14 7 14"></polyline>
                <path d="M3.51 9a9 9 0 0 1 14.13-3.36L23 10"></path>
                <path d="M20.49 15a9 9 0 0 1-14.13 3.36L1 14"></path>
              </svg>
              ${qtd}x
            </span>
            <span class="rk-chip" title="Motivo mais comum">
              <svg class="rk-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M14 2H6a2 2 0 0 0-2 2v16l4-2 4 2 4-2 4 2V8z"></path>
                <path d="M14 2v6h6"></path>
              </svg>
              ${motivo}
            </span>
          </div>
        </div>
      </div>

      <div class="rk-value" title="Custo do processo de devolução">
        <svg class="rk-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 12V7a2 2 0 0 0-2-2H5a3 3 0 0 0-3 3v9a3 3 0 0 0 3 3h14a2 2 0 0 0 2-2v-5z"></path>
          <path d="M16 12h.01"></path>
        </svg>
        ${prejuFmt}
      </div>
    `;
    el.appendChild(item);
  });
}

/* ------------------------------
   Resumo do período
--------------------------------*/
function preencherResumo(totals = {}) {
  const el = document.getElementById('resumo-periodo');
  if (!el) return;
  el.innerHTML = `
    <div class="resumo-item"><span class="label">Devoluções:</span><span class="valor">${totals.total ?? 0}</span></div>
    <div class="resumo-item"><span class="label">Abertas:</span><span class="valor">${totals.pendentes ?? 0}</span></div>
    <div class="resumo-item"><span class="label">Autorizadas p/ postagem:</span><span class="valor">${totals.aprovadas ?? 0}</span></div>
    <div class="resumo-item"><span class="label">Rejeitadas:</span><span class="valor">${totals.rejeitadas ?? 0}</span></div>
    <div class="resumo-item">
      <span class="label">Prejuízo total:</span>
      <span class="valor" style="color:var(--destructive)" title="${REGRAS_HINT}">${currencyBR(totals.prejuizo_total || 0)}</span>
    </div>`;
}

/* ------------------------------
   Carregamento / API
--------------------------------*/
async function carregarDashboard({ from = null, to = null, limitTop = 5 } = {}) {
  // aborta requisição anterior (evita race conditions)
  try { currentFetch?.abort(); } catch {}
  currentFetch = new AbortController();

  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to)   params.set('to', to);
  params.set('limitTop', String(limitTop));

  let data = null;
  try {
    const r = await fetch(`/api/dashboard?${params.toString()}`, { signal: currentFetch.signal });
    if (r.ok) {
      data = await r.json();
    } else {
      // se /api/dashboard não existir, caímos para montar a partir de /api/returns
      console.warn('/api/dashboard retornou', r.status, '— tentando compilar dados a partir de /api/returns');
      data = await buildDashboardFromReturns({ from, to, limitTop });
    }
  } catch (e) {
    if (e.name === 'AbortError') return; // requisição abortada
    console.warn('Erro ao buscar /api/dashboard, tentando /api/returns:', e);
    try {
      data = await buildDashboardFromReturns({ from, to, limitTop });
    } catch (ee) {
      console.error('Falha ao compilar dashboard a partir de /api/returns:', ee);
      data = mockDashboardData();
    }
  }

  // KPIs
  document.getElementById('dash-total') && (document.getElementById('dash-total').textContent = data.totals?.total ?? 0);
  document.getElementById('dash-pend')  && (document.getElementById('dash-pend').textContent  = data.totals?.pendentes ?? 0);
  document.getElementById('dash-aprov') && (document.getElementById('dash-aprov').textContent = data.totals?.aprovadas ?? 0);
  document.getElementById('dash-rej')   && (document.getElementById('dash-rej').textContent   = data.totals?.rejeitadas ?? 0);

  // compatibiliza chaves (API custom ou construída localmente)
  const topItems = data.top_items || data.ranking || data.top_items_local || [];
  const totals = data.totals || data.summary || data.totals_local || {};
  const chartsData = {
    daily: data.daily || data.by_day || data.daily_local || [],
    monthly: data.monthly || data.by_month || data.monthly_local || [],
    status: data.status || data.status_local || {},
  };

  preencherRanking(topItems);
  preencherResumo(totals);
  updateCharts(chartsData);
}

/* ------------------------------
   Constroi dados do dashboard a partir de /api/returns
--------------------------------*/
async function buildDashboardFromReturns({ from = null, to = null, limitTop = 5 } = {}) {
  // pede itens (tamanho grande para o período)
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  params.set('pageSize', '5000');
  params.set('page', '1');

  const url = `/api/returns/search?${params.toString()}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Falha ao buscar devoluções: ' + r.status);
  const j = await r.json();
  const items = Array.isArray(j.items) ? j.items : (j.items || []);

  // helper: regra de prejuízo — replica calcTotalByRules do front de devolucao-editar
  function calcPrejuizoFor(it) {
    const st = String(it.status || '').toLowerCase();
    const mot = String(it.tipo_reclamacao || it.motivo || it.reclamacao || '').toLowerCase();
    const lgs = String(it.log_status || '').toLowerCase();
    const vp = Number(it.valor_produto || it.valor || 0) || 0;
    const vf = Number(it.valor_frete || 0) || 0;
    if (st.includes('rej') || st.includes('neg')) return 0;
    if (mot.includes('cliente') || mot.includes('arrepend')) return 0;
    if (lgs === 'recebido_cd' || lgs === 'em_inspecao') return vf;
    return vp + vf;
  }

  // helper: seletor de SKU (prioriza campos de produto; NÃO cai no número do pedido)
  const parseMaybeJson = (x) => {
    if (!x) return null;
    if (typeof x === 'object') return x;
    try { return JSON.parse(String(x)); } catch { return null; }
  };
  const firstNonEmpty = (...vals) => {
    for (const v of vals) {
      if (v === null || v === undefined) continue;
      const s = String(v).trim();
      if (s && s.toLowerCase() !== 'null' && s.toLowerCase() !== 'undefined') return s;
    }
    return null;
  };
  function pickSku(it) {
    const meta  = parseMaybeJson(it.meta)  || {};
    const dados = parseMaybeJson(it.dados) || {};
    const info  = parseMaybeJson(it.info)  || {};

    return firstNonEmpty(
      it.sku,
      it.item_sku,
      it.seller_sku,
      it.sku_produto,
      it.bling_sku,
      it.codigo_sku,
      it.ml_seller_sku,
      it.ml_item_sku,
      it.ml_item_seller_sku,
      it.ml_listing_seller_custom_field,
      it.ml_variation_seller_custom_field,
      meta.sku, meta.seller_sku, meta.item?.seller_sku,
      dados.sku, dados.seller_sku,
      info.sku,  info.seller_sku,
      // nenhum fallback para id de venda/listing aqui (evita mostrar número do pedido)
      null
    ) || '—';
  }

  // totals e agrupamentos
  const totals = { total: 0, pendentes: 0, aprovadas: 0, rejeitadas: 0, prejuizo_total: 0 };
  const dailyMap = {};   // YYYY-MM-DD -> sum prejuizo
  const monthlyMap = {}; // YYYY-MM -> sum
  const statusMap = {};
  const skuMap = {};     // sku -> {sku, devolucoes, prejuizo, motivos{}}

  for (const it of items) {
    totals.total += 1;
    const st = String(it.status || '').toLowerCase();
    if (st.includes('pend')) totals.pendentes += 1;
    else if (st.includes('aprov')) totals.aprovadas += 1;
    else if (st.includes('rej') || st.includes('neg')) totals.rejeitadas += 1;

    const preju = calcPrejuizoFor(it);
    totals.prejuizo_total += preju;

    // data (criado em)
    const created = it.created_at || it.data_compra || it.created || null;
    let day = null;
    try { if (created) day = new Date(created).toISOString().slice(0,10); } catch(_) { day = null; }
    if (!day && it.data_compra) day = String(it.data_compra).slice(0,10);
    if (day) {
      dailyMap[day] = (dailyMap[day] || 0) + preju;
      const ym = day.slice(0,7);
      monthlyMap[ym] = (monthlyMap[ym] || 0) + preju;
    }

    // status
    const keyStatus = String(it.status || it.log_status || 'outros').toLowerCase();
    statusMap[keyStatus] = (statusMap[keyStatus] || 0) + 1;

    // sku ranking (PRIORIDADE SKU)
    const sku = pickSku(it);
    const motivo = String(it.tipo_reclamacao || it.motivo || it.reclamacao || '—');
    const s = skuMap[sku] || { sku, devolucoes: 0, prejuizo: 0, motivos: {} };
    s.devolucoes += 1;
    s.prejuizo   += preju;
    s.motivos[motivo] = (s.motivos[motivo] || 0) + 1;
    skuMap[sku] = s;
  }

  // monta arrays
  const daily = Object.keys(dailyMap).sort().map(k => ({ date: k, prejuizo: dailyMap[k] }));
  const monthly = Object.keys(monthlyMap).sort().map(k => ({ month: k, prejuizo: monthlyMap[k] }));

  // top items by devolucoes
  const top_items = Object.values(skuMap)
    .map(s => ({
      sku: s.sku,
      devolucoes: s.devolucoes,
      prejuizo: s.prejuizo,
      motivo_comum: Object.entries(s.motivos).sort((a,b)=>b[1]-a[1])[0]?.[0] || '—'
    }))
    .sort((a,b) => b.devolucoes - a.devolucoes)
    .slice(0, limitTop);

  return {
    daily, monthly, status: statusMap, top_items, totals
  };
}

/* ------------------------------
   Mock para desenvolvimento
--------------------------------*/
function mockDashboardData() {
  const today = new Date();
  const daily = Array.from({ length: 30 }).map((_, i) => {
    const d = new Date(today.getTime() - (29 - i) * 24 * 3600 * 1000);
    const label = d.toISOString().slice(0, 10);
    return { date: label, prejuizo: Math.round(Math.random() * 2000) };
  });
  const monthly = Array.from({ length: 6 }).map((_, i) => {
    const dt = new Date(today.getFullYear(), today.getMonth() - 5 + i, 1);
    return { month: dt.toLocaleString('pt-BR', { month: 'short', year: 'numeric' }), prejuizo: Math.round(Math.random() * 8000) };
  });
  const status = { pendente: 12, aprovado: 34, rejeitado: 7 };
  const top_items = Array.from({ length: 5 }).map((_, i) => ({
    sku: 'SKU-' + (1000 + i),
    devolucoes: Math.floor(Math.random() * 20) + 1,
    prejuizo: Math.round(Math.random() * 1500)
  }));
  const totals = {
    total: 120,
    pendentes: 12,
    aprovadas: 80,
    rejeitadas: 28,
    prejuizo_total: monthly.reduce((s, m) => s + Number(m.prejuizo || 0), 0)
  };
  return { daily, monthly, status, top_items, totals };
}

/* ------------------------------
   Boot
--------------------------------*/
document.addEventListener('DOMContentLoaded', () => {
  initCharts();

  // filtros: padrão mês atual
  const hoje = new Date();
  const from = new Date(hoje.getFullYear(), hoje.getMonth(), 1).toISOString().slice(0, 10);
  const to   = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 1).toISOString().slice(0, 10);
  const inpFrom = document.getElementById('filtro-from');
  const inpTo   = document.getElementById('filtro-to');
  if (inpFrom) inpFrom.value = from;
  if (inpTo)   inpTo.value = to;

  updateLogLink(inpFrom?.value || null, inpTo?.value || null);

  // Alterna gráficos (mostra só um por vez) + acessibilidade
  const toggleButtons = [
    ['btn-graf-dia','chart-prejuizo-dia'],
    ['btn-graf-mes','chart-prejuizo-mes'],
    ['btn-graf-6mes','chart-prejuizo-6mes'],
    ['btn-graf-status','chart-status']
  ];
  const showOnly = (id) => {
    ['chart-prejuizo-dia', 'chart-prejuizo-mes', 'chart-prejuizo-6mes', 'chart-status']
      .forEach(k => { const el = document.getElementById(k); if (el) el.style.display = (k === id ? 'block' : 'none'); });
    toggleButtons.forEach(([btnId, chartId]) => {
      const b = document.getElementById(btnId);
      if (b) {
        const active = id === chartId;
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', String(active));
      }
    });
  };
  document.getElementById('btn-graf-dia')?.addEventListener('click', () => showOnly('chart-prejuizo-dia'));
  document.getElementById('btn-graf-mes')?.addEventListener('click', () => showOnly('chart-prejuizo-mes'));
  document.getElementById('btn-graf-6mes')?.addEventListener('click', () => showOnly('chart-prejuizo-6mes'));
  document.getElementById('btn-graf-status')?.addEventListener('click', () => showOnly('chart-status'));
  showOnly('chart-prejuizo-dia'); // padrão

  // carregar dados iniciais
  carregarDashboard({ from, to }).catch(console.error);

  // aplicar filtros
  const aplicar = () => {
    const f = document.getElementById('filtro-from')?.value || null;
    const t = document.getElementById('filtro-to')?.value || null;
    updateLogLink(f, t);
    carregarDashboard({ from: f, to: t }).catch(console.error);
  };
  document.getElementById('btn-aplicar')?.addEventListener('click', aplicar);
  inpFrom?.addEventListener('keydown', (e) => { if (e.key === 'Enter') aplicar(); });
  inpTo?.addEventListener('keydown',   (e) => { if (e.key === 'Enter') aplicar(); });
});
