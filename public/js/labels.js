// js/labels.js
;(() => {
  const KEY = 'rf_labels_v1';

  const defaults = {
    status: {
      denied:          { label: 'Devolução negada', hint: 'Não atende à política. Total = R$ 0,00.' },
      customer_reason: { label: 'Motivo do cliente', hint: 'Arrependimento/erro do cliente. Total = R$ 0,00.' },
      received_cd:     { label: 'Recebida no CD',     hint: 'Custos logísticos. Total = só frete.' },
      in_inspection:   { label: 'Em inspeção',        hint: 'Pacote avaliado. Total = só frete.' },
      approved:        { label: 'Aprovada',           hint: 'Item aceito. Total = produto + frete.' },
      pending:         { label: 'Pendente',           hint: 'Aguardando ação.' },
      auth_post:       { label: 'Autorizada p/ postagem', hint: 'Cliente pode postar; não altera custo sozinho.' }
    },
    misc: {
      received: 'recebido',
      not_received: 'não recebido',
      rules_title: 'Regras de cálculo'
    }
  };

  const deepMerge = (a, b) => {
    const out = Array.isArray(a) ? [...a] : { ...a };
    for (const k of Object.keys(b || {})) {
      const v = b[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = deepMerge(a?.[k] || {}, v);
      else out[k] = v;
    }
    return out;
  };

  const load = () => {
    try { return deepMerge(defaults, JSON.parse(localStorage.getItem(KEY) || '{}')); }
    catch { return defaults; }
  };

  const save = (patch) => {
    const merged = deepMerge(load(), patch || {});
    localStorage.setItem(KEY, JSON.stringify(merged));
    return merged;
  };

  const get = (path) => {
    const parts = String(path).split('.');
    let cur = load();
    for (const p of parts) cur = cur?.[p];
    return cur ?? path; // fallback para o próprio path
  };

  const reset = () => localStorage.removeItem(KEY);

  // expõe globalmente
  window.Labels = { get, save, all: load, reset, defaults };
})();
