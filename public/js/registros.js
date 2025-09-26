// ===============================
// Sistema de Registros - JavaScript (sem seed)
// ===============================

// ---- Persistência em localStorage ----
const STORAGE_KEY = 'registros_v1';

function loadRegistros() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveRegistros() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(registros));
  } catch {}
}

// "Banco" local (vazio na primeira execução)
let registros = loadRegistros();
let proximoId = registros.length ? Math.max(...registros.map(r => r.id)) + 1 : 1;
let registroEditando = null;

// Se não há registros em localStorage, tentaremos carregar do backend (paginado)
async function carregarRegistrosDoServidorSeVazio() {
  if (registros && registros.length) return;
  try {
    const resp = await fetch('/api/returns?page=1&pageSize=200');
    if (!resp.ok) return;
    const j = await resp.json().catch(() => null);
    const items = Array.isArray(j?.items) ? j.items : (Array.isArray(j) ? j : []);
    // mapeia campos essenciais e mantém os originais para enriquecimento posterior
    registros = items.map(it => ({
      id: Number(it.id),
      id_venda: it.id_venda || null,
      numeroPedido: it.id_venda ? String(it.id_venda) : (it.nfe_numero || null),
      nomeCliente: null, // será preenchido por enriquecimento (NFe ou outro)
      produto: it.sku || null,
      sku: it.sku || null,
      nfe_numero: it.nfe_numero || null,
      nfe_chave: it.nfe_chave || null,
      tipo: it.tipo_reclamacao || 'devolucao',
      valor: Number(it.valor_produto || 0),
      status: it.status || 'pendente',
      descricao: it.reclamacao || '',
      dataRegistro: it.data_compra || it.created_at || null,
      dataAtualizacao: it.updated_at || null,
      lojaNome: it.loja_nome || null,
      _remote: true,
      _raw: it,
    }));

    // enriquecimento: para registros que têm NFe (numero ou chave), tentar buscar dados (cliente, valor)
    await Promise.all(
      registros.map(async (r) => {
        try {
          if (r.nfe_numero) {
            const rr = await fetch(`/api/invoice/${encodeURIComponent(r.nfe_numero)}`);
            if (rr.ok) {
              const d = await rr.json().catch(() => null);
              if (d) {
                r.nomeCliente = r.nomeCliente || d.cliente || null;
                r.valor = r.valor || (d.valor_total != null ? Number(d.valor_total) : r.valor);
                r.lojaNome = r.lojaNome || d.lojaNome || r.lojaNome;
              }
            }
          }
          if (!r.nomeCliente && r.nfe_chave) {
            const rr = await fetch(`/api/invoice/chave/${encodeURIComponent(r.nfe_chave)}`);
            if (rr.ok) {
              const d = await rr.json().catch(() => null);
              if (d) {
                r.nomeCliente = d.cliente || null;
                r.valor = r.valor || (d.valor_total != null ? Number(d.valor_total) : r.valor);
                r.lojaNome = r.lojaNome || d.lojaNome || r.lojaNome;
              }
            }
          }

          // Se ainda não temos nomeCliente, mas existe id_venda, podemos tentar uma busca simples
          if (!r.nomeCliente && r.id_venda) {
            const rr = await fetch(`/api/sales/${encodeURIComponent(r.id_venda)}`);
            if (rr.ok) {
              const d = await rr.json().catch(() => null);
              if (d) {
                // o endpoint /api/sales retorna lojaNome e idVenda, mas não necessariamente cliente
                r.lojaNome = r.lojaNome || d.lojaNome || null;
                r.numeroPedido = r.numeroPedido || d.numeroPedido || String(d.idVenda || r.id_venda);
              }
            }
          }
        } catch (err) {
          // não bloquear o carregamento por falhas pontuais
          console.debug('Enriquecimento falhou para', r.id, err && err.message);
        }
      })
    );
    proximoId = registros.length ? Math.max(...registros.map(r => r.id)) + 1 : 1;
    // salvar em localStorage para evitar carregar sempre (comportamento anterior)
    try { saveRegistros(); console.debug('[registros] salvos em localStorage, total=', registros.length); } catch(e) { console.debug('[registros] falha ao salvar', e && e.message); }
  } catch (e) {
    console.warn('Falha ao buscar registros do servidor:', e);
  }
}

// Força sincronização: limpa cache local e recarrega do servidor
function forcarSincronizacao() {
  try {
    console.debug('[registros] Forçando sincronização: limpando localStorage e recarregando');
    localStorage.removeItem(STORAGE_KEY);
    registros = [];
    proximoId = 1;
    (async () => {
      await carregarRegistrosDoServidorSeVazio();
      atualizarEstatisticas();
      renderizarRegistros();
      mostrarToast('Sincronizado', 'Registros recarregados do servidor.');
    })();
  } catch (e) {
    console.error('[registros] erro ao forcar sincronizacao', e);
    mostrarToast('Erro', 'Falha ao forçar sincronização. Veja o console.');
  }
}

// ===============================
// Inicialização
// ===============================
document.addEventListener('DOMContentLoaded', function () {
  (async () => {
    await carregarRegistrosDoServidorSeVazio();
    atualizarEstatisticas();
    renderizarRegistros();
  })();
});

// ===============================
// Estatísticas
// ===============================
function atualizarEstatisticas() {
  const total = registros.length;
  const ativos = registros.filter(r => r.status === 'ativo').length;
  const pendentes = registros.filter(r => r.status === 'pendente').length;
  const finalizados = registros.filter(r => r.status === 'finalizado').length;

  document.getElementById('totalRegistros').textContent = total;
  document.getElementById('registrosAtivos').textContent = ativos;
  document.getElementById('registrosPendentes').textContent = pendentes;
  document.getElementById('registrosFinalizados').textContent = finalizados;
}

// ===============================
// Renderização da lista
// ===============================
function renderizarRegistros() {
  const container = document.getElementById('listaRegistros');
  const mensagemVazia = document.getElementById('mensagemVazia');

  const registrosFiltrados = filtrarRegistrosPorCriterios();

  if (registrosFiltrados.length === 0) {
    container.style.display = 'none';
    mensagemVazia.style.display = 'flex';
    return;
  }

  container.style.display = 'flex';
  mensagemVazia.style.display = 'none';

  container.innerHTML = registrosFiltrados
    .map(
      registro => `
        <div class="card-devolucao fade-in" data-id="${registro.id}">
          <div class="devolucao-header">
            <div class="devolucao-titulo-area">
              <h3 class="devolucao-titulo">
                <svg class="icone" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>
                </svg>
                ${registro.nomeCliente || (registro.numeroPedido ? 'Pedido ' + registro.numeroPedido : 'Registro #' + String(registro.id).padStart(4,'0'))}
              </h3>
              <p class="devolucao-subtitulo">
                Registro #${registro.id.toString().padStart(4, '0')} • ${formatarData(registro.dataRegistro)}
                ${registro.numeroPedido ? ' • Pedido: ' + registro.numeroPedido : ''}
                ${registro.nfe_numero ? ' • NFe: ' + registro.nfe_numero : ''}
              </p>
            </div>
            <div class="devolucao-acoes">
              <span class="badge ${obterClasseBadgeStatus(registro.status)}">
                ${obterTextoStatus(registro.status)}
              </span>
              <button class="botao botao-outline" onclick="editarRegistro(${registro.id})" title="Editar registro">
                <svg class="icone" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
                </svg>
              </button>
              <button class="botao botao-outline" onclick="excluirRegistro(${registro.id})" title="Excluir registro">
                <svg class="icone" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                </svg>
              </button>
            </div>
          </div>

          <div class="devolucao-conteudo">
            <div class="campo-info">
              <svg class="icone" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"/>
              </svg>
              <span class="campo-label">Tipo:</span>
              <span class="campo-valor">${obterTextoTipo(registro.tipo)}</span>
            </div>

            <div class="campo-info">
              <svg class="icone" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1"/>
              </svg>
              <span class="campo-label">Valor:</span>
              <span class="campo-valor valor-destaque">R$ ${Number(registro.valor || 0).toFixed(2).replace('.', ',')}</span>
            </div>

            <div class="campo-info">
              <svg class="icone" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7h18M6 7v13a2 2 0 002 2h8a2 2 0 002-2V7"/>
              </svg>
              <span class="campo-label">Produto / SKU:</span>
              <span class="campo-valor">${registro.produto || registro.sku || '—'}</span>
            </div>

            <div class="campo-info">
              <svg class="icone" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3a1 1 0 011-1h6a1 1 0 011 1v4h3a1 1 0 011 1v8a1 1 0 01-1 1H5a1 1 0 01-1-1V8a1 1 0 011-1h3z"/>
              </svg>
              <span class="campo-label">Status:</span>
              <span class="campo-valor">${obterTextoStatus(registro.status)}</span>
            </div>

            <div class="campo-info">
              <svg class="icone" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
              <span class="campo-label">Última Atualização:</span>
              <span class="campo-valor">${formatarDataCompleta(registro.dataAtualizacao)}</span>
            </div>

            <div style="grid-column: 1 / -1;">
              <div class="campo-info">
                <svg class="icone" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                </svg>
                <span class="campo-label">Descrição:</span>
              </div>
              <p class="motivo-texto">${registro.descricao || ''}</p>
            </div>
          </div>
        </div>
      `
    )
    .join('');
}

// ===============================
// Filtros
// ===============================
function filtrarRegistrosPorCriterios() {
  const pesquisa = (document.getElementById('campoPesquisa')?.value || '').toLowerCase();
  const filtroStatus = document.getElementById('filtroStatus')?.value || '';
  const filtroTipo = document.getElementById('filtroTipo')?.value || '';

  return registros.filter(registro => {
    const nomeClienteSafe = String(registro.nomeCliente || '').toLowerCase();
    const descricaoSafe = String(registro.descricao || '').toLowerCase();
    const matchPesquisa =
      nomeClienteSafe.includes(pesquisa) ||
      descricaoSafe.includes(pesquisa) ||
      String(registro.id).includes(pesquisa);

    const matchStatus = !filtroStatus || registro.status === filtroStatus;
    const matchTipo = !filtroTipo || registro.tipo === filtroTipo;

    return matchPesquisa && matchStatus && matchTipo;
  });
}

function filtrarRegistros() {
  renderizarRegistros();
}

function limparFiltros() {
  document.getElementById('campoPesquisa').value = '';
  document.getElementById('filtroStatus').value = '';
  document.getElementById('filtroTipo').value = '';
  renderizarRegistros();
}

// ===============================
// Modal (novo/editar)
// ===============================
function abrirModalNovoRegistro() {
  registroEditando = null;
  document.getElementById('tituloModal').textContent = 'Novo Registro';
  document.getElementById('formRegistro').reset();
  document.getElementById('modalRegistro').style.display = 'flex';
}

function editarRegistro(id) {
  const registro = registros.find(r => r.id === id);
  if (!registro) return;

  registroEditando = registro;
  document.getElementById('tituloModal').textContent = 'Editar Registro';

  document.getElementById('nomeCliente').value = registro.nomeCliente;
  document.getElementById('tipoRegistro').value = registro.tipo;
  document.getElementById('valorRegistro').value = registro.valor;
  document.getElementById('statusRegistro').value = registro.status;
  document.getElementById('descricaoRegistro').value = registro.descricao;

  document.getElementById('modalRegistro').style.display = 'flex';
}

function fecharModalRegistro() {
  document.getElementById('modalRegistro').style.display = 'none';
  registroEditando = null;
}

function salvarRegistro(event) {
  event.preventDefault();

  const dados = {
    nomeCliente: document.getElementById('nomeCliente').value.trim(),
    tipo: document.getElementById('tipoRegistro').value,
    valor: parseFloat(document.getElementById('valorRegistro').value || '0') || 0,
    status: document.getElementById('statusRegistro').value,
    descricao: document.getElementById('descricaoRegistro').value.trim(),
  };

  if (registroEditando) {
    const index = registros.findIndex(r => Number(r.id) === Number(registroEditando.id));
    if (index === -1) return;

    // Se o registro veio do servidor, faz PATCH; senão atualiza localStorage
    if (registroEditando._remote) {
      (async () => {
        try {
          const id = registroEditando.id;
          const body = {
            status: dados.status || registroEditando.status,
            valor_produto: dados.valor || registroEditando.valor || 0,
            reclamacao: dados.descricao || registroEditando.descricao || null,
            updated_by: 'front-registros'
          };
          const r = await fetch(`/api/returns/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!r.ok) throw new Error('Falha ao salvar no servidor');
          // opcional: obter resposta
          await r.json().catch(() => ({}));
          registros[index] = {
            ...registros[index],
            ...dados,
            dataAtualizacao: new Date().toISOString(),
          };
          saveRegistros();
          atualizarEstatisticas();
          renderizarRegistros();
          mostrarToast('Sucesso!', 'Registro atualizado no servidor.');
        } catch (err) {
          console.error(err);
          mostrarToast('Erro', 'Falha ao atualizar no servidor.');
        }
      })();
    } else {
      registros[index] = {
        ...registros[index],
        ...dados,
        dataAtualizacao: new Date().toISOString(),
      };
      saveRegistros();
      mostrarToast('Sucesso!', 'Registro atualizado com sucesso.');
    }
  } else {
    const novoRegistro = {
      id: proximoId++,
      ...dados,
      dataRegistro: new Date().toISOString(),
      dataAtualizacao: new Date().toISOString(),
    };
    registros.unshift(novoRegistro);
    mostrarToast('Sucesso!', 'Novo registro criado com sucesso.');
  }

  saveRegistros();
  fecharModalRegistro();
  atualizarEstatisticas();
  renderizarRegistros();
}

function excluirRegistro(id) {
  if (confirm('Tem certeza que deseja excluir este registro? Esta ação não pode ser desfeita.')) {
    registros = registros.filter(r => r.id !== id);
    saveRegistros();
    atualizarEstatisticas();
    renderizarRegistros();
    mostrarToast('Sucesso!', 'Registro excluído com sucesso.');
  }
}

// ===============================
// Utilitários
// ===============================
function formatarData(dataISO) {
  if (!dataISO) return '—';
  const data = new Date(dataISO);
  return data.toLocaleDateString('pt-BR');
}

function formatarDataCompleta(dataISO) {
  if (!dataISO) return '—';
  const data = new Date(dataISO);
  return (
    data.toLocaleDateString('pt-BR') +
    ' às ' +
    data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  );
}

function obterTextoTipo(tipo) {
  const tipos = {
    devolucao: 'Devolução',
    troca: 'Troca',
    reembolso: 'Reembolso',
  };
  return tipos[tipo] || tipo || '—';
}

function obterTextoStatus(status) {
  const statuses = {
    ativo: 'Ativo',
    pendente: 'Pendente',
    finalizado: 'Finalizado',
  };
  return statuses[status] || status || '—';
}

function obterClasseBadgeStatus(status) {
  const classes = {
    ativo: 'badge-aprovado',
    pendente: 'badge-pendente',
    finalizado: 'badge-rejeitado',
  };
  return `badge ${classes[status] || 'badge-pendente'}`;
}

// ===============================
// Toast
// ===============================
function mostrarToast(titulo, descricao) {
  document.getElementById('toastTitulo').textContent = titulo;
  document.getElementById('toastDescricao').textContent = descricao;

  const toast = document.getElementById('toast');
  toast.style.display = 'block';

  setTimeout(() => {
    toast.style.display = 'none';
  }, 4000);
}

// Fechar modal com ESC
document.addEventListener('keydown', function (event) {
  if (event.key === 'Escape') {
    fecharModalRegistro();
  }
});
