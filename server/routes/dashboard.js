/* server/routes/dashboard.js
 * API agregada para o dashboard — soma prejuízos, conta status, séries e ranking.
 */
'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../db');

function parseDateYMD(s) {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0,10);
}

function buildPrejuizoExpr() {
  // calcula por linha a regra de prejuízo (mesma lógica do front)
  // - se status indicar rejeitado/negado => 0
  // - se motivo indicar cliente/arrependimento => 0
  // - se log_status for recebido_cd ou em_inspecao => frete
  // - caso contrário => produto + frete
  return `CASE
      WHEN LOWER(COALESCE(status,'')) LIKE '%rej%' OR LOWER(COALESCE(status,'')) LIKE '%neg%' THEN 0
      WHEN LOWER(COALESCE(tipo_reclamacao, motivo, reclamacao, '')) LIKE '%cliente%' OR LOWER(COALESCE(tipo_reclamacao, motivo, reclamacao, '')) LIKE '%arrepend%' THEN 0
      WHEN LOWER(COALESCE(log_status,'')) IN ('recebido_cd','em_inspecao') THEN COALESCE(valor_frete,0)
      ELSE COALESCE(valor_produto,0) + COALESCE(valor_frete,0)
    END`;
}

router.get('/', async (req, res) => {
  try {
    const from = parseDateYMD(req.query.from);
    const to   = parseDateYMD(req.query.to);
    const limitTop = Math.max(1, Math.min(parseInt(req.query.limitTop||'5',10)||5, 100));

    const where = [];
    const params = [];
    if (from && to) {
      params.push(from); params.push(to);
      where.push(`(COALESCE(created_at::date, (data_compra::date)) BETWEEN $${params.length-1} AND $${params.length})`);
    } else if (from) {
      params.push(from); where.push(`(COALESCE(created_at::date, (data_compra::date)) >= $${params.length})`);
    } else if (to) {
      params.push(to); where.push(`(COALESCE(created_at::date, (data_compra::date)) <= $${params.length})`);
    }

    const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';

    const prejuExpr = buildPrejuizoExpr();

    // KPIs + prejuízo total
    const kpiSql = `SELECT
        COUNT(*)::int AS total,
        SUM(${prejuExpr})::numeric AS prejuizo_total,
        SUM(CASE WHEN LOWER(COALESCE(status,'')) LIKE '%pend%' THEN 1 ELSE 0 END)::int AS pendentes,
        SUM(CASE WHEN LOWER(COALESCE(status,'')) LIKE '%aprov%' THEN 1 ELSE 0 END)::int AS aprovadas,
        SUM(CASE WHEN LOWER(COALESCE(status,'')) LIKE '%rej%' OR LOWER(COALESCE(status,'')) LIKE '%neg%' THEN 1 ELSE 0 END)::int AS rejeitadas
      FROM devolucoes
      ${whereSql}`;

    const kpiQ = await query(kpiSql, params);
    const kpis = kpiQ.rows[0] || { total:0, prejuizo_total:0, pendentes:0, aprovadas:0, rejeitadas:0 };

    // série diária
    const dailySql = `SELECT day::text AS dia, SUM(prej)::numeric AS prejuizo FROM (
        SELECT COALESCE((COALESCE(created_at, data_compra))::date, NULL) AS day, ${prejuExpr} AS prej
        FROM devolucoes
        ${whereSql}
      ) t
      WHERE day IS NOT NULL
      GROUP BY day
      ORDER BY day ASC`;
    const dailyQ = await query(dailySql, params);

    // status distribution
    const statusSql = `SELECT key, SUM(cnt)::int AS qtd FROM (
       SELECT CASE
         WHEN LOWER(COALESCE(status,'')) LIKE '%pend%' THEN 'pendente'
         WHEN LOWER(COALESCE(status,'')) LIKE '%aprov%' THEN 'aprovado'
         WHEN LOWER(COALESCE(status,'')) LIKE '%rej%' OR LOWER(COALESCE(status,'')) LIKE '%neg%' THEN 'rejeitado'
         ELSE 'outros' END AS key,
         1 AS cnt
       FROM devolucoes
       ${whereSql}
    ) s GROUP BY key`;
    const statusQ = await query(statusSql, params);

    // ranking: top SKUs por quantidade + custo + motivo mais comum
    const rankingSql = `SELECT sku, qtd, custo, motivo_comum FROM (
      SELECT d.sku AS sku,
             COUNT(*)::int AS qtd,
             SUM(${prejuExpr})::numeric AS custo,
             (
               SELECT COALESCE(mot, '—') FROM (
                 SELECT COALESCE(tipo_reclamacao,motivo,reclamacao) AS mot, COUNT(*) AS c
                 FROM devolucoes r2
                 WHERE COALESCE(r2.sku,'') = COALESCE(d.sku,'') ${where.length ? 'AND ' + where.join(' AND ') : ''}
                 GROUP BY mot
                 ORDER BY c DESC LIMIT 1
               ) mm
             ) AS motivo_comum
      FROM devolucoes d
      ${whereSql}
      GROUP BY d.sku
      ORDER BY qtd DESC, custo DESC
      LIMIT $${params.length+1}
    ) t`;
    const rankingParams = params.concat([limitTop]);
    const rankingQ = await query(rankingSql, rankingParams);

    // montar resposta compatível (várias formas para front-end)
    const response = {
      ok: true,
      totals: {
        total: Number(kpis.total || 0),
        pendentes: Number(kpis.pendentes || 0),
        aprovadas: Number(kpis.aprovadas || 0),
        rejeitadas: Number(kpis.rejeitadas || 0),
        prejuizo_total: Number(kpis.prejuizo_total || 0)
      },
      // compat com versão antiga
      kpis: {
        total: Number(kpis.total || 0),
        pendentes: Number(kpis.pendentes || 0),
        autorizadas: Number(kpis.aprovadas || 0),
        rejeitadas: Number(kpis.rejeitadas || 0),
        prejuizo_total: Number(kpis.prejuizo_total || 0)
      },
      charts: {
        by_day: dailyQ.rows.map(r => ({ dia: r.dia, prejuizo: Number(r.prejuizo || 0) })),
        by_status: statusQ.rows.map(r => ({ status: r.key, qtd: Number(r.qtd || 0) }))
      },
      // forma alternativa usada pelo código novo
      daily: dailyQ.rows.map(r => ({ date: r.dia, prejuizo: Number(r.prejuizo || 0) })),
      monthly: [],
      status: statusQ.rows.reduce((acc, r) => { acc[r.key] = Number(r.qtd||0); return acc; }, {}),
      top_items: rankingQ.rows.map(r => ({ sku: r.sku, qtd: Number(r.qtd||0), prejuizo: Number(r.custo||0), motivo_comum: r.motivo_comum }))
    };

    // calcular monthly agregado a partir de daily (simples)
    const monthlyMap = {};
    for (const row of response.daily) {
      const ym = row.date.slice(0,7);
      monthlyMap[ym] = (monthlyMap[ym] || 0) + Number(row.prejuizo || 0);
    }
    response.monthly = Object.keys(monthlyMap).sort().map(k => ({ month: k, prejuizo: monthlyMap[k] }));

    res.json(response);
  } catch (e) {
    console.error('[dashboard] erro:', e);
    res.status(500).json({ error: 'Falha ao montar dashboard', detail: e?.message || String(e) });
  }
});

module.exports = router;
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
