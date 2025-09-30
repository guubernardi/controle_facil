// registros.js — Sistema de Registros (com motivo codificado e cálculo de prejuízo)

// ===============================
// Persistência em localStorage
// ===============================
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

// Banco local
let registros = loadRegistros();
let proximoId = registros.length ? Math.max(...registros.map(r => r.id)) + 1 : 1;
let registroEditando = null;

// ===============================
// Helpers de status (mapa front ⇄ back)
// ===============================
function mapServerStatusToRegistroStatus(s = 'pendente') {
  if (s === 'aprovado') return 'ativo';
  if (s === 'rejeitado') return 'finalizado';
  return 'pendente';
}
function mapRegistroStatusToServerStatus(s = 'pendente') {
  if (s === 'ativo') return 'aprovado';
  if (s === 'finalizado') return 'rejeitado';
  return 'pendente';
}

// ===============================
// Inicialização
// ===============================
document.addEventListener('DOMContentLoaded', function () {
  (async () => {
    await carregarRegistrosDoServidorSeVazio();
    atualizarEstatisticas();
    renderizarRegistros();

    const campoPesquisa = document.getElementById('campoPesquisa');
    if (campoPesquisa) campoPesquisa.addEventListener('input', debounce(renderizarRegistros, 200));
    document.getElementById('filtroStatus')?.addEventListener('change', renderizarRegistros);
    document.getElementById('filtroTipo')?.addEventListener('change', renderizarRegistros);
  })();
});

// ===============================
// Debounce
// ===============================
function debounce(fn, ms = 250) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

// ===============================
// Seed condicional do servidor (paginado)
// ===============================
async function carregarRegistrosDoServidorSeVazio() {
  if (registros && registros.length) return;
  try {
    const resp = await fetch('/api/returns?page=1&pageSize=200');
    if (!resp.ok) return;
    const j = await resp.json().catch(() => null);
    const items = Array.isArray(j?.items) ? j.items : (Array.isArray(j) ? j : []);

    registros = items.map(it => ({
      id: Number(it.id),
      id_venda: it.id_venda || null,
      numeroPedido: it.id_venda ? String(it.id_venda) : (it.nfe_numero || null),
      nomeCliente: it.cliente_nome || null,
      produto: it.sku || null,
      sku: it.sku || null,
      nfe_numero: it.nfe_numero || null,
      nfe_chave: it.nfe_chave || null,
      tipo: it.tipo_reclamacao || 'devolucao',
      valor: Number(it.valor_produto || 0),
      valorFrete: Number(it.valor_frete || 0),    // NOVO
      status: mapServerStatusToRegistroStatus(it.status || 'pendente'),
      descricao: it.reclamacao || '',
      motivoCodigo: it.motivo_codigo || '',       // NOVO
      dataRegistro: it.data_compra || it.created_at || null,
      dataAtualizacao: it.updated_at || null,
      lojaNome: it.loja_nome || null,
      _remote: true,
      _raw: it,
    }));

    // enriquecimento leve via NFe / sales
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
          if (!r.nomeCliente && r.id_venda) {
            const rr = await fetch(`/api/sales/${encodeURIComponent(r.id_venda)}`);
            if (rr.ok) {
              const d = await rr.json().catch(() => null);
              if (d) {
                r.lojaNome = r.lojaNome || d.lojaNome || null;
                r.numeroPedido = r.numeroPedido || d.numeroPedido || String(d.idVenda || r.id_venda);
              }
            }
          }
        } catch (err) {
          console.debug('Enriquecimento falhou para', r.id, err?.message);
        }
      })
    );

    proximoId = registros.length ? Math.max(...registros.map(r => r.id)) + 1 : 1;
    saveRegistros();
  } catch (e) {
    console.warn('Falha ao buscar registros do servidor:', e);
  }
}

// Força sincronização
function forcarSincronizacao() {
  try {
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
// Estatísticas
// ===============================
function formatBRL(v = 0) {
  return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// regra de prejuízo (registro)
function calcularPrejuizoRegistro(r) {
  const statusVoltouCD = ['recebido_cd', 'em_inspecao'];
  const MOTIVOS_CLIENTE_COBRE = new Set([
    'arrependimento', 'compra_errada', 'nao_serviu', 'mudou_de_ideia',
    'endereco_errado_cliente', 'ausencia_receptor', 'cancelou_antes_envio'
  ]);
  const motivoClienteRegex = /(arrepend|compra errad|tamanho|cor errad|desist|engano|nao serviu|não serviu|mudou de ideia)/i;

  const produto = Number(r?.valor || 0);
  const frete   = Number(r?.valorFrete || 0);
  const status  = String(r?.status || '').toLowerCase();
  const cod     = String(r?.motivoCodigo || '').toLowerCase();
  const texto   = String(r?.descricao || '');

  if (statusVoltouCD.includes(status)) return frete; // voltou CD => só frete
  if (MOTIVOS_CLIENTE_COBRE.has(cod) || motivoClienteRegex.test(texto)) return 0; // cliente => 0
  return produto + frete;
}

function grupoStatus(status) {
  if (['aprovado'].includes(status)) return 'aprovado';
  if (['rejeitado'].includes(status)) return 'rejeitado';
  if (['concluido'].includes(status)) return 'finalizado';
  return 'pendente';
}

function atualizarEstatisticas() {
  const total = registros.length;
  const pendentes   = registros.filter(r => grupoStatus(r.status) === 'pendente').length;
  const aprovados   = registros.filter(r => grupoStatus(r.status) === 'aprovado').length;
  const rejeitados  = registros.filter(r => grupoStatus(r.status) === 'rejeitado').length;
  const finalizados = registros.filter(r => grupoStatus(r.status) === 'finalizado').length;

  document.getElementById('totalRegistros').textContent = total;
  document.getElementById('registrosAtivos').textContent = aprovados;      // renomeie o card se desejar
  document.getElementById('registrosPendentes').textContent = pendentes;
  document.getElementById('registrosFinalizados').textContent = finalizados;

  // Se houver um elemento para prejuízo total na página de registros, atualize-o:
  const prejuizoTotal = registros.reduce((s, r) => s + calcularPrejuizoRegistro(r), 0);
  const alvo = document.getElementById('registrosValorTotal');
  if (alvo) alvo.textContent = formatBRL(prejuizoTotal);
}

// ===============================
// Renderização da lista
// ===============================
function renderizarRegistros() {
  const container = document.getElementById('listaRegistros');
  const mensagemVazia = document.getElementById('mensagemVazia');

  const registrosFiltrados = filtrarRegistrosPorCriterios()
    .sort((a, b) => {
      const Ab = new Date(b.dataAtualizacao || b.dataRegistro || 0).getTime();
      const Aa = new Date(a.dataAtualizacao || a.dataRegistro || 0).getTime();
      return Ab - Aa;
    });

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
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                        d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>
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
              <span class="badge ${obterClasseBadgeStatus(registro.status)}" aria-label="${obterTextoStatus(registro.status)}">
                ${obterTextoStatus(registro.status)}
              </span>
              <button class="botao botao-outline" onclick="editarRegistro(${registro.id})" title="Editar registro">
                <svg class="icone" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                        d="M11 5H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
                </svg>
              </button>
              <button class="botao botao-outline" onclick="excluirRegistro(${registro.id})" title="Excluir registro">
                <svg class="icone" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                </svg>
              </button>
            </div>
          </div>

          <div class="devolucao-conteudo">
            <div class="campo-info">
              <svg class="icone" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                      d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"/>
              </svg>
              <span class="campo-label">Tipo:</span>
              <span class="campo-valor">${obterTextoTipo(registro.tipo)}</span>
            </div>

            <div class="campo-info">
              <svg class="icone" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                      d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1"/>
              </svg>
              <span class="campo-label">Valor:</span>
              <span class="campo-valor valor-destaque">${formatBRL(registro.valor || 0)}</span>
            </div>

            <div class="campo-info">
              <svg class="icone" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                      d="M3 7h18M6 7v13a2 2 0 002 2h8a2 2 0 002-2V7"/>
              </svg>
              <span class="campo-label">Produto / SKU:</span>
              <span class="campo-valor">${registro.produto || registro.sku || '—'}</span>
            </div>

            <div class="campo-info">
              <svg class="icone" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                      d="M8 7V3a1 1 0 011-1h6a1 1 0 011 1v4h3a1 1 0 011 1v8a1 1 0 01-1 1H5a1 1 0 01-1-1V8a1 1 0 011-1h3z"/>
              </svg>
              <span class="campo-label">Status:</span>
              <span class="campo-valor">${obterTextoStatus(registro.status)}</span>
            </div>

            <div class="campo-info">
              <svg class="icone" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                      d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
              <span class="campo-label">Última Atualização:</span>
              <span class="campo-valor">${formatarDataCompleta(registro.dataAtualizacao)}</span>
            </div>

            <div style="grid-column: 1 / -1;">
              <div class="campo-info">
                <svg class="icone" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
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
  setTimeout(() => document.getElementById('nomeCliente')?.focus(), 50);
}

function editarRegistro(id) {
  const registro = registros.find(r => r.id === id);
  if (!registro) return;

  registroEditando = registro;
  document.getElementById('tituloModal').textContent = 'Editar Registro';

  document.getElementById('nomeCliente').value = registro.nomeCliente || '';
  document.getElementById('tipoRegistro').value = registro.tipo || 'devolucao';
  document.getElementById('valorRegistro').value = Number(registro.valor || 0);
  document.getElementById('statusRegistro').value = registro.status || 'pendente';
  document.getElementById('descricaoRegistro').value = registro.descricao || '';

  document.getElementById('modalRegistro').style.display = 'flex';
}

function fecharModalRegistro() {
  document.getElementById('modalRegistro').style.display = 'none';
  registroEditando = null;
}

async function salvarRegistro(event) {
  event.preventDefault();

  const dados = {
    nomeCliente: document.getElementById('nomeCliente').value.trim(),
    tipo: document.getElementById('tipoRegistro').value,
    valor: parseFloat(document.getElementById('valorRegistro').value || '0') || 0,
    status: document.getElementById('statusRegistro').value,
    descricao: document.getElementById('descricaoRegistro').value.trim(),
    // se quiser, pode ter um select equivalente no modal de registros e ler aqui:
    motivoCodigo: document.getElementById('motivoCodigoRegistro')?.value || '', // opcional
  };

  if (registroEditando) {
    const index = registros.findIndex(r => Number(r.id) === Number(registroEditando.id));
    if (index === -1) return;

    if (registroEditando._remote) {
      try {
        const id = registroEditando.id;
        const body = {
          status: mapRegistroStatusToServerStatus(dados.status || registroEditando.status),
          valor_produto: dados.valor || registroEditando.valor || 0,
          reclamacao: dados.descricao || registroEditando.descricao || null,
          motivo_codigo: dados.motivoCodigo || null,   // envia se tiver
          updated_by: 'front-registros'
        };
        const r = await fetch(`/api/returns/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error('Falha ao salvar no servidor');
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

    // tenta criar no servidor (fallback local se falhar)
    try {
      const body = {
        id_venda: null,
        loja_id: null,
        loja_nome: null,
        sku: null,
        status: mapRegistroStatusToServerStatus(dados.status),
        valor_produto: dados.valor || 0,
        reclamacao: dados.descricao || null,
        motivo_codigo: dados.motivoCodigo || null,   // envia se tiver
        created_by: 'front-registros'
      };
      const r = await fetch('/api/returns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (r.ok) {
        const json = await r.json().catch(() => ({}));
        novoRegistro.id = Number(json.id ?? novoRegistro.id);
        novoRegistro._remote = true;
      }
    } catch (e) {
      console.warn('[registros] create fallback local', e?.message);
    }

    registros.unshift(novoRegistro);
    mostrarToast('Sucesso!', 'Novo registro criado.');
  }

  saveRegistros();
  fecharModalRegistro();
  atualizarEstatisticas();
  renderizarRegistros();
}

async function excluirRegistro(id) {
  if (!confirm('Tem certeza que deseja excluir este registro? Esta ação não pode ser desfeita.')) return;
  const reg = registros.find(x => x.id === id);
  try {
    if (reg?._remote) {
      const res = await fetch(`/api/returns/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Falha ao excluir no servidor');
    }
    registros = registros.filter(r => r.id !== id);
    saveRegistros();
    atualizarEstatisticas();
    renderizarRegistros();
    mostrarToast('Sucesso!', 'Registro excluído com sucesso.');
  } catch (e) {
    console.error(e);
    mostrarToast('Erro', 'Não foi possível excluir no servidor.');
  }
}

// ===============================
// Exportação CSV
// ===============================
function toCSV(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const esc = v => {
    if (v == null) return '';
    const s = String(v);
    return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))].join('\n');
}

function exportarRegistros() {
  const dados = filtrarRegistrosPorCriterios().map(r => ({
    ID: r.id,
    Cliente: r.nomeCliente || '',
    Tipo: obterTextoTipo(r.tipo),
    Status: obterTextoStatus(r.status),
    ValorProduto: Number(r.valor || 0),
    ValorFrete: Number(r.valorFrete || 0),
    Prejuizo: calcularPrejuizoRegistro(r),           // NOVO
    Pedido: r.numeroPedido || '',
    NFe: r.nfe_numero || '',
    AtualizadoEm: r.dataAtualizacao || '',
    Loja: r.lojaNome || '',
    Descricao: r.descricao || '',
    MotivoCodigo: r.motivoCodigo || ''
  }));
  const csv = toCSV(dados);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  a.download = 'registros.csv';
  a.click();
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
  const map = {
    em_analise: 'Em análise',
    aguardando_cliente: 'Aguardando cliente',
    aguardando_logistica: 'Aguardando logística',
    recebido_cd: 'Recebido no CD',
    em_inspecao: 'Em inspeção',
    aprovado: 'Aprovado',
    rejeitado: 'Rejeitado',
    concluido: 'Concluído',
    pendente: 'Pendente',
    ativo: 'Ativo',
    finalizado: 'Finalizado',
  };
  return map[status] || status || '—';
}

function obterClasseBadgeStatus(status) {
  const cls = {
    em_analise: 'badge-pendente',
    aguardando_cliente: 'badge-pendente',
    aguardando_logistica: 'badge-pendente',
    recebido_cd: 'badge-info',
    em_inspecao: 'badge-info',
    aprovado: 'badge-aprovado',
    rejeitado: 'badge-rejeitado',
    concluido: 'badge-neutral',
    pendente: 'badge-pendente',
    ativo: 'badge-aprovado',
    finalizado: 'badge-rejeitado',
  };
  return `badge ${cls[status] || 'badge-pendente'}`;
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
