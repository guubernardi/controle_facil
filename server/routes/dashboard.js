/* public/js/dashboard.js
 * Dashboard real (consome /api/dashboard)
 * - Período: usa inputs #filtro-from e #filtro-to (default: últimos 30 dias)
 * - KPIs: #dash-total, #dash-pend, #dash-aprov, #dash-rej
 * - Resumo: #resumo-periodo
 * - Gráficos: #chart-prejuizo-dia (bar), #chart-status (doughnut)
 * - Ranking: #ranking-lista
 */

(() => {
  const $ = (s, ctx=document) => ctx.querySelector(s);
  const $$ = (s, ctx=document) => Array.from(ctx.querySelectorAll(s));

  // ==== datas padrão (últimos 30 dias) ====
  function ymd(d){ return d.toISOString().slice(0,10); }
  function setDefaultDates(){
    const to = new Date();
    const from = new Date(to.getTime() - 29*24*3600*1000);
    $('#filtro-from').value = ymd(from);
    $('#filtro-to').value   = ymd(to);
  }

  let chartDia = null;
  let chartStatus = null;

  function brl(n){ return (Number(n)||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'}); }

  async function loadDashboard(){
    const from = $('#filtro-from').value;
    const to   = $('#filtro-to').value;

    const url = new URL('/api/dashboard', location.origin);
    if (from) url.searchParams.set('from', from);
    if (to)   url.searchParams.set('to', to);

    const res = await fetch(url, { headers: { 'Accept':'application/json' }});
    if (!res.ok) throw new Error('Falha ao carregar dashboard');
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'Erro');

    // ===== KPIs =====
    $('#dash-total').textContent = j.kpis.total;
    $('#dash-pend').textContent  = j.kpis.pendentes;
    $('#dash-aprov').textContent = j.kpis.autorizadas;
    $('#dash-rej').textContent   = j.kpis.rejeitadas;

    // ===== Resumo =====
    const resumo = $('#resumo-periodo');
    if (resumo) {
      resumo.innerHTML = `
        <div class="summary-row"><span>Devoluções:</span><b>${j.kpis.total}</b></div>
        <div class="summary-row"><span>Abertas:</span><b>${j.kpis.pendentes}</b></div>
        <div class="summary-row"><span>Autorizadas p/ postagem:</span><b>${j.kpis.autorizadas}</b></div>
        <div class="summary-row"><span>Rejeitadas:</span><b>${j.kpis.rejeitadas}</b></div>
        <hr/>
        <div class="summary-row total"><span>Prejuízo total:</span><b>${brl(j.kpis.prejuizo_total)}</b></div>
      `;
    }

    // ===== Gráfico: prejuízo por dia =====
    const labels = j.charts.by_day.map(x => x.dia);
    const values = j.charts.by_day.map(x => x.prejuizo);

    const ctxDia = $('#chart-prejuizo-dia').getContext('2d');
    if (chartDia) chartDia.destroy();
    chartDia = new Chart(ctxDia, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Prejuízo (regra aplicada)',
          data: values,
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: { y: { beginAtZero: true } },
        plugins: { legend: { display: false } }
      }
    });

    // ===== Gráfico: por status =====
    const statusLabels = j.charts.by_status.map(x => x.status);
    const statusValues = j.charts.by_status.map(x => x.qtd);

    const ctxSt = $('#chart-status').getContext('2d');
    if (chartStatus) chartStatus.destroy();
    chartStatus = new Chart(ctxSt, {
      type: 'doughnut',
      data: {
        labels: statusLabels,
        datasets: [{ data: statusValues }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom' } }
      }
    });

    // ===== Ranking: itens que mais voltam =====
    const list = $('#ranking-lista');
    if (list) {
      list.innerHTML = '';
      if (!j.ranking.length) {
        list.innerHTML = '<div class="ranking-empty">Sem dados no período.</div>';
      } else {
        j.ranking.forEach((r) => {
          const el = document.createElement('div');
          el.className = 'ranking-item';
          el.innerHTML = `
            <div class="rk-left">
              <div class="rk-sku">${r.sku}</div>
              <div class="rk-meta">
                <span>${r.qtd} devoluções</span>
                <span>•</span>
                <span>${r.motivo_comum || '—'}</span>
              </div>
            </div>
            <div class="rk-right">
              <div class="rk-custo">${brl(r.custo)}</div>
            </div>
          `;
          list.appendChild(el);
        });
      }
    }
  }

  // Botões de modo de gráfico (mantém seu layout)
  function bindChartToggles(){
    const btnDia = $('#btn-graf-dia');
    const btnMes = $('#btn-graf-mes');
    const btn6   = $('#btn-graf-6mes');
    const btnSt  = $('#btn-graf-status');

    const canvDia = $('#chart-prejuizo-dia');
    const canvMes = $('#chart-prejuizo-mes');
    const canv6   = $('#chart-prejuizo-6mes');
    const canvSt  = $('#chart-status');

    function showOnly(el){
      [canvDia, canvMes, canv6, canvSt].forEach(c => { if(c) c.style.display='none'; });
      el.style.display = '';
      // estado de botão
      [btnDia, btnMes, btn6, btnSt].forEach(b => b && b.classList.remove('active'));
    }

    if (btnDia) btnDia.addEventListener('click', () => { showOnly(canvDia); btnDia.classList.add('active'); });
    if (btnMes) btnMes.addEventListener('click', () => { showOnly(canvMes); btnMes.classList.add('active'); });
    if (btn6)   btn6.addEventListener('click',   () => { showOnly(canv6);   btn6.classList.add('active');   });
    if (btnSt)  btnSt.addEventListener('click',  () => { showOnly(canvSt);  btnSt.classList.add('active');  });

    // default
    showOnly(canvDia);
    btnDia && btnDia.classList.add('active');
  }

  function bindApply(){
    $('#btn-aplicar')?.addEventListener('click', () => {
      loadDashboard().catch(err => alert(err.message || 'Erro ao atualizar'));
    });
  }

  function init(){
    if (!$('#filtro-from').value || !$('#filtro-to').value) setDefaultDates();
    bindApply();
    bindChartToggles();
    loadDashboard().catch(err => alert(err.message || 'Erro ao carregar'));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
