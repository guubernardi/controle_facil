(function(){
  const qs = new URLSearchParams(location.search);
  const id = qs.get('id');
  const $ = (id) => document.getElementById(id);
  const money = v => Number(v||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});

  if(!id){
    document.querySelector('.detalhe-wrap').innerHTML =
      '<p class="muted">ID não informado.</p>';
    return;
  }

  function pill(status){
    const s = String(status||'').toLowerCase();
    let cls = '';
    if(s.includes('pend')) cls='-pendente';
    else if(s.includes('aprov')) cls='-aprovado';
    else if(s.includes('rej')||s.includes('neg')) cls='-rejeitado';
    return `<span class="pill ${cls}">${status||'—'}</span>`;
  }

  async function load(){
    // devolução
    const r = await fetch(`/api/returns/${encodeURIComponent(id)}`);
    if(!r.ok){
      document.querySelector('.detalhe-wrap').innerHTML =
        '<p class="muted">Registro não encontrado.</p>';
      return;
    }
    const d = await r.json();

    // head
    $('dt-title').textContent = `Devolução #${d.id}`;
    $('dt-pedido').textContent = d.id_venda || d.nfe_numero || '—';
    $('dt-cliente').textContent = d.cliente_nome || '—';
    $('dt-loja').textContent = d.loja_nome || '—';
    $('dt-politica').textContent = d.politica || d.regra_aplicada || '—';
    $('dt-resp').textContent = d.responsavel_custo || '—';
    $('dt-sku').textContent = d.sku || '—';
    $('dt-created').textContent = new Date(d.created_at).toLocaleString('pt-BR');

    const wrap = document.createElement('span');
    wrap.innerHTML = pill(d.status || '—');
    $('dt-status').innerHTML = '';
    $('dt-status').appendChild(wrap.firstElementChild);

    // valores
    $('dt-prod').textContent = money(d.valor_produto);
    $('dt-frete').textContent = money(d.valor_frete);
    $('dt-total').textContent = money((+d.valor_produto||0)+(+d.valor_frete||0));

    // obs
    $('dt-reclamacao').textContent = d.reclamacao || '—';

    // timeline
    try{
      const r2 = await fetch(`/api/returns/${encodeURIComponent(id)}/events?limit=100`);
      const evs = (await r2.json()).items || [];
      if(!evs.length){
        $('dt-timeline').innerHTML = '<li class="muted">Sem eventos.</li>';
      }else{
        $('dt-timeline').innerHTML = evs.map(ev=>{
          const when = new Date(ev.createdAt||ev.created_at).toLocaleString('pt-BR');
          const title = ev.title || ev.type || '';
          const msg = ev.message || '';
          return `<li><b>${when} — ${title}</b><div class="muted">${msg}</div></li>`;
        }).join('');
      }
    }catch{
      $('dt-timeline').innerHTML = '<li class="muted">Falha ao carregar eventos.</li>';
    }
  }

  document.addEventListener('DOMContentLoaded', load);
})();
