// helper pra pegar valor por id
const v = id => document.getElementById(id).value.trim();

// Quando digitar o ID da venda, busca no Bling e preenche a loja
document.getElementById('id_venda').addEventListener('change', async (e) => {
  const id = e.target.value.trim();
  if (!id) return;
  try {
    const r = await fetch(`/api/sales/${encodeURIComponent(id)}?account=${encodeURIComponent('Conta de Teste')}`);
    const j = await r.json();
    if (r.ok) {
      document.getElementById('loja_auto').value = j.lojaNome || '';
      window.__ultimaVenda = j; // guarda para enviar no POST
    } else {
      alert(j.error || 'Não achei a venda.');
    }
  } catch {
    alert('Falha ao consultar venda.');
  }
});

// Clique em Salvar: envia a devolução ao backend
document.getElementById('btnSalvar').addEventListener('click', async () => {
  const vendaInfo = window.__ultimaVenda || {};
  const payload = {
    data_compra: v('data_compra') || null,
    id_venda: v('id_venda'),
    loja_id: vendaInfo.lojaId ?? null,
    loja_nome: document.getElementById('loja_auto').value || vendaInfo.lojaNome || null,
    sku: v('sku') || null,
    tipo_reclamacao: v('tipo_reclamacao') || null,
    status: v('status') || null,
    valor_produto: v('valor_produto') || null,
    valor_frete: v('valor_frete') || null,
    reclamacao: v('reclamacao') || null,
    created_by: 'gustavo'
  };

  if (!payload.id_venda) return alert('Informe o ID da venda.');

  try {
    const r = await fetch('/api/returns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const j = await r.json();
    if (!r.ok) return alert(j.error || 'Falha ao salvar.');
    alert('Devolução salva! id=' + j.id);
    carregarLista();
  } catch {
    alert('Erro de rede ao salvar.');
  }
});

// Carrega lista de devoluções
async function carregarLista() {
  try {
    const r = await fetch('/api/returns?limit=20');
    const lista = await r.json();
    const tbody = document.getElementById('lista');
    tbody.innerHTML = '';
    for (const d of lista) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${d.id}</td>
        <td>${d.data_compra ?? '-'}</td>
        <td>${d.id_venda}</td>
        <td>${d.loja_nome ?? '-'}</td>
        <td>${d.sku ?? '-'}</td>
        <td>${d.tipo_reclamacao ?? '-'}</td>
        <td>${d.status ?? '-'}</td>
        <td>${d.valor_produto ?? '-'}</td>
        <td>${d.valor_frete ?? '-'}</td>
        <td>${new Date(d.created_at).toLocaleString()}</td>
      `;
      tbody.appendChild(tr);
    }
  } catch (e) {
    console.warn('Falha ao carregar lista', e);
  }
}

// Carregar ao abrir
carregarLista();
