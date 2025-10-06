function trocarAba(nome) {
  // Atualiza botões
document.querySelectorAll('.aba').forEach(b=>{
    const ativa = b.dataset.tab === nome;
    b.classList.toggle('ativa', ativa);
    b.setAttribute('aria-selected', ativa ? 'true' : 'false');
  });
  document.querySelectorAll('.tab').forEach(p=>{
    p.classList.toggle('ativo', p.id === `tab_${nome}`);
  });
}

async function carregarKpis() {
  try {
    const r = await fetch('/api/home/kpis');
    const j = await r.json();
    
    const kpiTotal = document.getElementById('kpi_total');
    const kpiPendentes = document.getElementById('kpi_pendentes');
    const kpiAprovadas = document.getElementById('kpi_aprovadas');
    const kpiRejeitadas = document.getElementById('kpi_rejeitadas');
    const kpiConciliar = document.getElementById('kpi_conciliar');
    
    if (kpiTotal) kpiTotal.textContent = j.total ?? 0;
    if (kpiPendentes) kpiPendentes.textContent = j.pendentes ?? 0;
    if (kpiAprovadas) kpiAprovadas.textContent = j.aprovadas ?? 0;
    if (kpiRejeitadas) kpiRejeitadas.textContent = j.rejeitadas ?? 0;
    if (kpiConciliar) kpiConciliar.textContent = j.a_conciliar ?? 0;
  } catch (e) {
    console.warn('KPIs erro:', e);
  }
}

async function carregarPendencias() {
  try {
    const r = await fetch('/api/home/pending');
    const j = await r.json();
    
    const qtdRcd = document.getElementById('qtd_rcd');
    const qtdSemcsv = document.getElementById('qtd_semcsv');
    const qtdCsvpend = document.getElementById('qtd_csvpend');
    
    if (qtdRcd) qtdRcd.textContent = j.recebidos_sem_inspecao?.length ?? 0;
    if (qtdSemcsv) qtdSemcsv.textContent = j.sem_conciliacao_csv?.length ?? 0;
    if (qtdCsvpend) qtdCsvpend.textContent = j.csv_pendente?.length ?? 0;
  } catch (e) {
    console.warn('Pending erro:', e);
  }
}

async function carregarIntegracoes() {
  try {
    const r = await fetch('/api/integrations/health');
    const j = await r.json();

    const intBling = document.getElementById('int_bling');
    const intMl = document.getElementById('int_ml');
    
    if (intBling) {
      intBling.textContent = j.bling?.ok ? 'OK' : 'configurar';
      intBling.className = 'tag ' + (j.bling?.ok ? '-ok' : '-warn');
    }

    if (intMl) {
      intMl.textContent = j.mercado_livre?.ok ? 'OK' : 'usar CSV';
      intMl.className = 'tag ' + (j.mercado_livre?.ok ? '-ok' : '-warn');
    }
  } catch (e) {
    console.warn('Health erro:', e);
  }
}

async function carregarAvisos() {
  try {
    const r = await fetch('/api/home/announcements');
    const j = await r.json();
    const ul = document.getElementById('ann_list');
    
    if (!ul) return;
    
    ul.innerHTML = '';
    (j.items || []).forEach(txt => {
      const li = document.createElement('li');
      li.className = 'lista-item announcement';
      li.textContent = txt;
      ul.appendChild(li);
    });
    
    // Se não houver avisos, mostra mensagem padrão
    if (!j.items || j.items.length === 0) {
      const li = document.createElement('li');
      li.className = 'lista-item announcement';
      li.textContent = 'Novos recursos em desenvolvimento...';
      ul.appendChild(li);
    }
  } catch (e) {
    console.warn('Announcements erro:', e);
  }
}

// Links na setas
document.querySelectorAll('.lista-item .seta')?.forEach((btn, i)=>{
  const destinos = ['/index.html#f=recebido_cd','/index.html#f=sem_csv','/logs.html'];
  btn.addEventListener('click', ()=> location.href = destinos[i] || '/index.html');
});


async function carregarEventosRecentes() {
  try {
    // Pega últimos 50 returns para extrair eventos
    const r2 = await fetch('/api/returns?page=1&pageSize=50');
    const { items = [] } = await r2.json();

    const feed = document.getElementById('event_feed');
    if (!feed) return;
    
    feed.innerHTML = '';

    const ultimas = [];
    for (const it of items) {
      try {
        const evr = await fetch(`/api/returns/${it.id}/events?limit=1&offset=0`);
        const { items: evs = [] } = await evr.json();
        if (evs[0]) ultimas.push({ ...evs[0], loja_nome: it.loja_nome, id: it.id });
      } catch (err) {
        // Ignora erros individuais
      }
    }
    
    // Ordena por createdAt desc
    ultimas.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    if (!ultimas.length) {
      feed.innerHTML = '<li class="lista-item">Sem eventos recentes.</li>';
      return;
    }

    ultimas.slice(0, 50).forEach(ev => {
      const li = document.createElement('li');
      li.className = 'lista-item';
      const dt = new Date(ev.createdAt).toLocaleString('pt-BR');
      const msg = ev.message || ev.title || ev.type || '(sem mensagem)';
      li.innerHTML = `
        <div>
          <b>#${ev.id}</b> — ${dt}
          <br/><small>${ev.loja_nome || ''}</small>
          <br/>${msg}
        </div>
      `;
      feed.appendChild(li);
    });
  } catch (e) {
    console.warn('Eventos erro:', e);
    const feed = document.getElementById('event_feed');
    if (feed) {
      feed.innerHTML = '<li class="lista-item">Não foi possível carregar eventos.</li>';
    }
  }
}

// Inicialização
document.addEventListener('DOMContentLoaded', () => {
  // Configura listeners de abas
  document.querySelectorAll('.aba').forEach(b => {
    b.addEventListener('click', () => trocarAba(b.dataset.tab));
  });

  // Mostra aba inicial
  trocarAba('visao');
  
  // Carrega dados
  carregarKpis();
  carregarPendencias();
  carregarIntegracoes();
  carregarAvisos();
  carregarEventosRecentes();
});
