/* public/js/registros.js
 * Lista + busca + paginação + edição/remoção de devoluções
 * Depende dos elementos:
 *  - #busca, #filtro, #btnBuscar
 *  - #tabela, #paginacao
 *  - Modal de edição com ids usados em abrirEdicao()
 */

let page = 1, pageSize = 20, total = 0;
let isLoading = false;

// ---------------------- util ----------------------
const formatMoney = (v) => `R$ ${(Number(v || 0)).toFixed(2).replace('.', ',')}`;
const formatDateBR = (d) => d ? new Date(d).toLocaleDateString('pt-BR') : '-';

// helper: debounce para mudanças de status (evita PATCH em cascata)
function debounce(fn, ms = 350) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---------------------- core ----------------------
async function carregar() {
  if (isLoading) return;
  isLoading = true;

  const root = document.getElementById('tabela');
  root.innerHTML = `<div class="descricao-card">Carregando...</div>`;

  try {
    const search = document.getElementById('busca').value.trim();
    const status = document.getElementById('filtro').value; // '' | pendente | aprovado | rejeitado

    const qs = new URLSearchParams({ page, pageSize });
    if (search) qs.set('search', search);
    if (status) qs.set('status', status);

    const r = await fetch(`/api/returns?${qs.toString()}`);
    if (!r.ok) throw new Error(`Falha ao carregar (${r.status})`);
    const data = await r.json();

    total = data.total || 0;
    desenharTabela(Array.isArray(data.items) ? data.items : []);
    desenharPaginacao();
  } catch (err) {
    console.error(err);
    root.innerHTML = `<div class="descricao-card">Erro ao carregar registros.</div>`;
  } finally {
    isLoading = false;
  }
}

function desenharTabela(items) {
  const root = document.getElementById('tabela');

  if (!items.length) {
    root.innerHTML = `<div class="descricao-card">Nenhum registro encontrado.</div>`;
    return;
  }

  const rows = items.map(it => `
    <tr>
      <td>${it.id}</td>
      <td>${formatDateBR(it.data_compra)}</td>
      <td>${it.id_venda ?? '-'}</td>
      <td>${it.loja_nome ?? '-'}</td>
      <td>${it.sku ?? '-'}</td>
      <td>${it.nfe_numero ?? '-'}</td>
      <td>
        <select data-id="${it.id}" class="status-select">
          ${['pendente','aprovado','rejeitado'].map(s =>
            `<option value="${s}" ${String(it.status||'').toLowerCase()===s?'selected':''}>${s}</option>`
          ).join('')}
        </select>
      </td>
      <td>${formatMoney(it.valor_produto)}</td>
      <td>${formatMoney(it.valor_frete)}</td>
      <td>
        <button class="botao botao-outline btn-editar"  data-id="${it.id}">Editar</button>
        <button class="botao botao-outline btn-excluir" data-id="${it.id}">Excluir</button>
      </td>
    </tr>
  `).join('');

  root.innerHTML = `
    <div style="overflow:auto;">
      <table style="width:100%; border-collapse:collapse;">
        <thead>
          <tr>
            <th>ID</th><th>Compra</th><th>Venda</th><th>Loja</th><th>SKU</th><th>NF</th>
            <th>Status</th><th>R$ Prod</th><th>R$ Frete</th><th>Ações</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;

  // listeners de ações na tabela
  wireTableActions(root);
}

function wireTableActions(root) {
  // PATCH status com debounce (1 chamada por mudança estabilizada)
  const doPatchStatus = debounce(async (id, status) => {
    try {
      const r = await fetch(`/api/returns/${id}`, {
        method:'PATCH',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ status, updated_by: 'ui' })
      });
      if (!r.ok) throw new Error('Falha ao atualizar status');
    } catch (e) {
      alert('Erro ao atualizar status.');
      console.error(e);
      // recarrega pra voltar estado visual correto
      carregar();
    }
  }, 300);

  root.querySelectorAll('.status-select').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const id = e.target.getAttribute('data-id');
      const status = e.target.value;
      doPatchStatus(id, status);
    });
  });

  root.querySelectorAll('.btn-excluir').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      if (!confirm('Excluir este registro?')) return;
      try {
        const r = await fetch(`/api/returns/${id}`, { method:'DELETE' });
        if (!r.ok) throw new Error('Falha ao excluir');
        carregar();
      } catch (e) {
        alert('Erro ao excluir.');
        console.error(e);
      }
    });
  });

  root.querySelectorAll('.btn-editar').forEach(btn => {
    btn.addEventListener('click', () => abrirEdicao(btn.getAttribute('data-id')));
  });
}

function desenharPaginacao() {
  const root = document.getElementById('paginacao');
  const pages = Math.max(Math.ceil(total / pageSize), 1);

  root.innerHTML = `
    <button class="botao botao-outline" ${page<=1?'disabled':''} id="prev">Anterior</button>
    <div style="padding:.5rem 1rem;">Página ${page} de ${pages}</div>
    <button class="botao botao-outline" ${page>=pages?'disabled':''} id="next">Próxima</button>
  `;

  root.querySelector('#prev')?.addEventListener('click', () => {
    if (page > 1) { page--; carregar(); }
  });
  root.querySelector('#next')?.addEventListener('click', () => {
    const pages = Math.ceil(total / pageSize);
    if (page < pages) { page++; carregar(); }
  });
}

// ---------------------- Modal de edição ----------------------
function openModalEditar() {
  const m = document.getElementById('modal-editar');
  m.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeModalEditar() {
  const m = document.getElementById('modal-editar');
  m.style.display = 'none';
  document.body.style.overflow = '';
  document.getElementById('form-editar').reset();
}

function toDateInputValue(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth()+1).padStart(2,'0');
  const dd = String(dt.getDate()).padStart(2,'0');
  return `${yyyy}-${mm}-${dd}`;
}

async function abrirEdicao(id) {
  try {
    const r = await fetch(`/api/returns/${id}`);
    if (!r.ok) throw new Error();
    const it = await r.json();

    // Preenche o form
    document.getElementById('edit-id').value           = it.id;
    document.getElementById('edit-status').value       = (it.status || 'pendente').toLowerCase();
    document.getElementById('edit-data').value         = toDateInputValue(it.data_compra);
    document.getElementById('edit-loja').value         = it.loja_nome || '';
    document.getElementById('edit-sku').value          = it.sku || '';
    document.getElementById('edit-valor-prod').value   = it.valor_produto ?? '';
    document.getElementById('edit-valor-frete').value  = it.valor_frete ?? '';
    document.getElementById('edit-tipo').value         = it.tipo_reclamacao || '';
    document.getElementById('edit-nfe-num').value      = it.nfe_numero || '';
    document.getElementById('edit-nfe-chave').value    = it.nfe_chave || '';
    document.getElementById('edit-reclamacao').value   = it.reclamacao || '';

    openModalEditar();
  } catch {
    alert('Falha ao carregar registro para edição.');
  }
}

// listeners do modal (fechar / submit)
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('fechar-editar')?.addEventListener('click', closeModalEditar);
  document.getElementById('cancelar-editar')?.addEventListener('click', closeModalEditar);

  // ESC fecha modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('modal-editar')?.style.display === 'flex') {
      closeModalEditar();
    }
  });

  // PATCH do form
  document.getElementById('form-editar')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('edit-id').value;

    const body = {
      status:          document.getElementById('edit-status').value,
      data_compra:     document.getElementById('edit-data').value || null,
      loja_nome:       document.getElementById('edit-loja').value || null,
      sku:             document.getElementById('edit-sku').value || null,
      valor_produto:   parseFloat(document.getElementById('edit-valor-prod').value || '0') || 0,
      valor_frete:     parseFloat(document.getElementById('edit-valor-frete').value || '0') || 0,
      tipo_reclamacao: document.getElementById('edit-tipo').value || null,
      nfe_numero:      document.getElementById('edit-nfe-num').value || null,
      nfe_chave:       document.getElementById('edit-nfe-chave').value || null,
      reclamacao:      document.getElementById('edit-reclamacao').value || null,
      updated_by:      'ui'
    };

    // Validação leve: NF-e chave costuma ter 44 dígitos (ignora máscara)
    if (body.nfe_chave && body.nfe_chave.replace(/\D/g,'').length !== 44) {
      const ok = confirm('A chave NF-e não parece ter 44 dígitos. Deseja continuar mesmo assim?');
      if (!ok) return;
    }

    try {
      const r = await fetch(`/api/returns/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify(body)
      });
      if (!r.ok) {
        const err = await r.json().catch(()=>({}));
        throw new Error(err.error || r.statusText);
      }
      closeModalEditar();
      carregar(); // atualiza a lista mantendo filtros
    } catch (e) {
      alert('Falha ao salvar: ' + (e.message || 'Erro desconhecido'));
    }
  });
});

// ---------------------- busca/página inicial ----------------------
document.addEventListener('DOMContentLoaded', () => {
  // botão buscar
  document.getElementById('btnBuscar')?.addEventListener('click', () => {
    page = 1; carregar();
  });

  // enter no campo de busca
  document.getElementById('busca')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      page = 1;
      carregar();
    }
  });

  // mudar filtro de status dispara busca
  document.getElementById('filtro')?.addEventListener('change', () => {
    page = 1; carregar();
  });

  // primeira carga
  carregar();
});
