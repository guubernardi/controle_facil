// /js/devolucao-editar.js
;(() => {
  // ===== Helpers =====
  const $ = (id) => document.getElementById(id);
  const qs = new URLSearchParams(location.search);
  // aceita ?return_id= ou ?id=
  const returnId = qs.get("return_id") || qs.get("id");

  // normaliza "12,50" -> 12.5, ignora milhares
  const toNumber = (v) => {
    if (v == null || v === "") return 0;
    const s = String(v).replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  };

  const moneyBRL = (v) =>
    Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  // escapa HTML (timeline)
  const esc = (s = "") =>
    String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

  const toast = (msg, type = "info") => {
    const t = $("toast");
    if (!t) {
      alert(msg);
      return;
    }
    t.className = "toast " + (type || "info");
    t.textContent = msg;
    requestAnimationFrame(() => {
      t.classList.add("show");
      setTimeout(() => t.classList.remove("show"), 3000);
    });
  };

  // ===== Labels (opcional via labels.js) =====
  const L = (path) => window.Labels?.get(path) ?? path;

  // mapeia códigos do backend para chaves do dicionário de labels
  const mapLogCodeToKey = (code) => {
    const c = String(code || '').toLowerCase();
    if (c === 'recebido_cd') return 'received_cd';
    if (c === 'em_inspecao' || c === 'inspecionado') return 'in_inspection';
    if (c.includes('neg') || c.includes('rej') || c.includes('reprov')) return 'denied';
    return null;
  };

  const labelForLog = (code) => {
    const key = mapLogCodeToKey(code);
    return key ? L(`status.${key}.label`) : (code || '—');
  };

  const hintForLog = (code) => {
    const key = mapLogCodeToKey(code);
    return key ? L(`status.${key}.hint`) : '';
  };

  const getLogPillEl = () => $("pill-log") || $("log_status_pill");

  function setLogPill(code) {
    const el = getLogPillEl();
    if (!el) return;

    const s = String(code || "").toLowerCase();
    let cls = "pill -neutro";
    if (!code) cls = "pill -neutro";
    else if (s.includes("pend")) cls = "pill -pendente";
    else if (s.includes("aprov")) cls = "pill -aprovado";
    else if (s.includes("rej") || s.includes("neg") || s.includes("reprov")) cls = "pill -rejeitado";
    else if (s.includes("recebido") || s.includes("inspec")) cls = "pill -aprovado"; // ou outra classe se tiver

    el.className = cls;
    el.textContent = labelForLog(code);
    el.title = hintForLog(code);
  }

  const setCdInfo = ({ log_status = "" } = {}) => {
    const pill = $("pill-cd");
    const resp = $("cd-resp");
    const when = $("cd-when");
    const sep = $("cd-sep");
    if (!pill) return;

    const isReceived = String(log_status || "").toLowerCase() === "recebido_cd";

    if (!isReceived) {
      pill.className = "pill -neutro";
      pill.textContent = L('misc.not_received') || "não recebido";
      if (resp) resp.hidden = true;
      if (when) when.hidden = true;
      if (sep) sep.hidden = true;
      return;
    }

    pill.className = "pill -aprovado";
    pill.textContent = L('misc.received') || "recebido";
    if (resp) {
      resp.textContent = `Resp.: cd`;
      resp.hidden = false;
    }
    if (when) {
      when.textContent = `Quando: —`;
      when.hidden = false;
    }
    if (sep) sep.hidden = false;
  };

  // ===== Regras de cálculo =====
  function calcTotalByRules(d) {
    const st  = String(d.status || "").toLowerCase();
    const mot = String(d.tipo_reclamacao || d.reclamacao || "").toLowerCase();
    const lgs = String(d.log_status || "").toLowerCase();
    const vp  = toNumber(d.valor_produto || 0);
    const vf  = toNumber(d.valor_frete || 0);

    if (st.includes("rej") || st.includes("neg")) return 0; // devolução negada
    if (mot.includes("cliente")) return 0;                  // motivo do cliente
    if (lgs === "recebido_cd" || lgs === "em_inspecao" || lgs === "inspecionado") return vf; // só frete
    return vp + vf; // padrão
  }

  // ===== Estado =====
  let current = {};

  // ===== Resumo =====
  function updateSummary(d) {
    const rs = $("resumo-status");
    const rl = $("resumo-log");
    const rc = $("resumo-cd");
    const rp = $("resumo-prod");
    const rf = $("resumo-frete");
    const rt = $("resumo-total");

    if (rs) rs.textContent = d.status || "—";
    if (rl) rl.textContent = labelForLog(d.log_status || '');
    if (rc) rc.textContent =
      String(d.log_status || "").toLowerCase() === "recebido_cd"
        ? (L('misc.received') || "recebido")
        : (L('misc.not_received') || "não recebido");
    if (rp) rp.textContent = moneyBRL(toNumber(d.valor_produto));
    if (rf) rf.textContent = moneyBRL(toNumber(d.valor_frete));
    if (rt) rt.textContent = moneyBRL(calcTotalByRules(d));
  }

  function capture() {
    return {
      id_venda: $("id_venda")?.value.trim() || null,
      cliente_nome: $("cliente_nome")?.value.trim() || null,
      loja_nome: $("loja_nome")?.value.trim() || null,
      data_compra: $("data_compra")?.value || null,
      status: $("status")?.value || null,
      sku: $("sku")?.value.trim() || null,
      tipo_reclamacao: $("tipo_reclamacao")?.value || null,
      nfe_numero: $("nfe_numero")?.value.trim() || null,
      nfe_chave: $("nfe_chave")?.value.trim() || null,
      reclamacao: $("reclamacao")?.value.trim() || null,
      valor_produto: toNumber($("valor_produto")?.value),
      valor_frete: toNumber($("valor_frete")?.value),
      log_status: current.log_status || null,
    };
  }

  function recalc() {
    const d = capture();
    const eProd = $("ml-prod");
    const eFrete = $("ml-frete");
    const eTotal = $("ml-total");
    if (eProd) eProd.textContent = moneyBRL(d.valor_produto);
    if (eFrete) eFrete.textContent = moneyBRL(d.valor_frete);
    if (eTotal) eTotal.textContent = moneyBRL(calcTotalByRules({ ...current, ...d }));

    updateSummary({ ...current, ...d });
  }

  function fill(d) {
    const dvId = $("dv-id");
    if (dvId) dvId.textContent = d.id ? `#${d.id}` : "";

    if ($("id_venda")) $("id_venda").value = d.id_venda || "";
    if ($("cliente_nome")) $("cliente_nome").value = d.cliente_nome || "";
    if ($("loja_nome")) $("loja_nome").value = d.loja_nome || "";
    if ($("data_compra")) $("data_compra").value = d.data_compra ? String(d.data_compra).slice(0, 10) : "";
    if ($("status")) $("status").value = d.status || "";
    if ($("sku")) $("sku").value = d.sku || "";
    if ($("tipo_reclamacao")) $("tipo_reclamacao").value = d.tipo_reclamacao || "";
    if ($("nfe_numero")) $("nfe_numero").value = d.nfe_numero || "";
    if ($("nfe_chave")) $("nfe_chave").value = d.nfe_chave || "";
    if ($("reclamacao")) $("reclamacao").value = d.reclamacao || "";
    if ($("valor_produto"))
      $("valor_produto").value = (d.valor_produto ?? "") === "" ? "" : String(d.valor_produto);
    if ($("valor_frete"))
      $("valor_frete").value = (d.valor_frete ?? "") === "" ? "" : String(d.valor_frete);

    setLogPill(d.log_status || "—");
    setCdInfo({ log_status: d.log_status || "" });

    updateSummary(d);
    recalc();
  }

  async function reloadCurrent() {
    if (!returnId) return;
    const r = await fetch(`/api/returns/${encodeURIComponent(returnId)}`);
    if (!r.ok) throw new Error("Falha ao recarregar registro.");
    current = await r.json();
    fill(current);
  }

  async function save() {
    try {
      const body = capture();
      const r = await fetch(`/api/returns/${encodeURIComponent(current.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, updated_by: "frontend" }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => null);
        throw new Error(e?.error || "Falha ao salvar");
      }
      await reloadCurrent();
      toast("Salvo!", "success");
      await refreshTimeline(current.id);
    } catch (e) {
      toast(e.message || "Erro ao salvar", "error");
    }
  }

  // ===== Ações: Inspeção Aprovar/Reprovar =====
  async function runInspect(result, observacao) {
    try {
      disableHead(true);

      // 1) marca etapa (backend já cria evento)
      await fetch(`/api/returns/${encodeURIComponent(current.id)}/inspect`, { method: "POST" });

      // 2) atualiza status conforme ação
      const status = result === "aprovado" ? "aprovado" : "rejeitado";
      await fetch(`/api/returns/${encodeURIComponent(current.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, updated_by: "frontend" }),
      });

      // 3) adiciona nota (opcional)
      if (observacao?.trim()) {
        await fetch(`/api/returns/${encodeURIComponent(current.id)}/note`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: result === "aprovado" ? "Inspeção aprovada" : "Inspeção reprovada",
            message: observacao.trim(),
          }),
        });
      }

      await reloadCurrent();
      toast(`Inspeção registrada (${result})!`, "success");
      await refreshTimeline(current.id);
    } catch (e) {
      toast(e.message || "Erro", "error");
    } finally {
      disableHead(false);
    }
  }

  function openInspectDialog(result) {
    const dlg = $("dlg-inspecao");
    const title = $("insp-title");
    const sub = $("insp-sub");
    const txt = $("insp-text");
    const btnOk = $("insp-confirm");
    const btnNo = $("insp-cancel");

    if (!dlg) return;

    const isApprove = result === "aprovado";
    title.textContent = isApprove ? "Aprovar inspeção" : "Reprovar inspeção";
    sub.textContent = isApprove
      ? "Confirme a aprovação da inspeção. Você pode adicionar uma observação."
      : "Confirme a reprovação da inspeção. Você pode adicionar uma observação.";

    if (btnOk) {
      btnOk.className = isApprove ? "btn btn--success" : "btn btn--danger";
    }

    txt.value = "";
    dlg.showModal();

    const onSubmit = (ev) => {
      ev.preventDefault();
      const obs = txt.value.trim();
      dlg.close();
      runInspect(result, obs);
      cleanup();
    };
    const onCancel = (e) => {
      e?.preventDefault?.();
      dlg.close();
      cleanup();
    };

    function cleanup() {
      const form = $("insp-form");
      if (form) form.removeEventListener("submit", onSubmit);
      dlg.removeEventListener("cancel", onCancel);
      if (btnNo) btnNo.removeEventListener("click", onCancel);
    }

    const form = $("insp-form");
    if (form) form.addEventListener("submit", onSubmit, { once: true });
    if (btnNo) btnNo.addEventListener("click", onCancel, { once: true });
    dlg.addEventListener("cancel", onCancel, { once: true }); // ESC / cancelar

    setTimeout(() => txt?.focus(), 0);
  }

  function disableHead(disabled) {
    ["btn-salvar", "btn-insp-aprova", "btn-insp-reprova", "rq-receber", "rq-aprovar", "rq-reprovar"].forEach((id) => {
      const el = $(id);
      if (el) el.disabled = !!disabled;
    });
  }

  // ==== Dialog Recebido no CD ====
  const btnRecebido = $("rq-receber");
  const dlgR = $("dlg-recebido");
  const inpResp = $("rcd-resp"); // guardado só pra UX; backend não usa
  const inpWhen = $("rcd-when"); // guardado só pra UX; backend não usa
  const btnSaveR = $("rcd-save");
  const btnUnset = $("rcd-unset");

  const rcdCancel = $("rcd-cancel");
  if (rcdCancel) rcdCancel.addEventListener("click", () => dlgR?.close());

  const pad = (n) => String(n).padStart(2, "0");

  if (btnRecebido) {
    btnRecebido.addEventListener("click", () => {
      const lastResp = localStorage.getItem("cd_responsavel") || "";
      if (inpResp) inpResp.value = lastResp;
      const now = new Date();
      if (inpWhen) {
        inpWhen.value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(
          now.getHours()
        )}:${pad(now.getMinutes())}`;
      }
      dlgR?.showModal();
    });
  }

  if (btnSaveR) {
    btnSaveR.addEventListener("click", async (ev) => {
      ev.preventDefault();
      try {
        if (!returnId) return toast("ID da devolução não encontrado.", "error");

        const responsavel = (inpResp?.value || "").trim() || "cd";
        localStorage.setItem("cd_responsavel", responsavel);

        // backend atual: apenas marca a etapa
        const r = await fetch(`/api/returns/${encodeURIComponent(returnId)}/receive`, { method: "POST" });
        if (!r.ok) {
          const err = await r.json().catch(() => ({ error: "Falha" }));
          throw new Error(err?.error || "Falha ao registrar recebimento.");
        }

        await reloadCurrent();
        toast("Recebido no CD.", "success");
        dlgR?.close();
        await refreshTimeline(returnId);
      } catch (e) {
        toast(e.message || "Erro ao registrar recebimento.", "error");
      }
    });
  }

  if (btnUnset) {
    btnUnset.addEventListener("click", async () => {
      try {
        if (!returnId) return toast("ID da devolução não encontrado.", "error");

        // não há endpoint de "unreceive"; usamos PATCH limpando o log_status
        const r = await fetch(`/api/returns/${encodeURIComponent(returnId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ log_status: null, updated_by: "frontend" }),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({ error: "Falha" }));
          throw new Error(err?.error || "Falha ao remover marcação.");
        }

        await reloadCurrent();
        toast("Marcação de recebido removida.", "success");
        dlgR?.close();
        await refreshTimeline(returnId);
      } catch (e) {
        toast(e.message || "Erro ao remover marcação.", "error");
      }
    });
  }

  // ===== Timeline =====
  async function fetchEvents(id, limit = 100, offset = 0) {
    const url = `/api/returns/${encodeURIComponent(id)}/events?limit=${limit}&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Falha ao carregar eventos.");
    const j = await res.json();
    return Array.isArray(j.items) ? j.items : [];
  }

  const fmtRel = (iso) => {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const diffMs = Date.now() - d.getTime();
    const abs = Math.abs(diffMs);
    const min = 60 * 1000,
          hr  = 60 * min,
          day = 24 * hr;
    const s = (n, u) => `${n} ${u}${n > 1 ? "s" : ""}`;
    if (abs < hr)  return s(Math.round(abs / min) || 0, "min") + (diffMs >= 0 ? " atrás" : " depois");
    if (abs < day) return s(Math.round(abs / hr), "hora") + (diffMs >= 0 ? "s atrás" : "s depois");
    return d.toLocaleString("pt-BR");
  };

  function iconFor(type) {
    if (type === "status") return "🛈";
    if (type === "note")   return "📝";
    if (type === "warn")   return "⚠️";
    if (type === "error")  return "⛔";
    return "•";
  }

  function renderEvents(items) {
    const wrap = $("events-list");
    const elLoad = $("events-loading");
    const elEmpty = $("events-empty");
    if (!wrap) return;
    wrap.innerHTML = "";
    if (elLoad) elLoad.hidden = true;

    if (!items.length) {
      if (elEmpty) elEmpty.hidden = false;
      return;
    }
    if (elEmpty) elEmpty.hidden = true;

    const frag = document.createDocumentFragment();
    items.forEach((ev) => {
      const type = (ev.type || "status").toLowerCase();
      const meta = (ev.meta && (typeof ev.meta === "object" ? ev.meta : null)) || null;

      const item = document.createElement("article");
      item.className = `tl-item -${type}`;
      item.setAttribute("role", "article");

      const created = ev.createdAt || ev.created_at || ev.created;
      const rel = created ? fmtRel(created) : "";

      item.innerHTML = `
        <span class="tl-dot" aria-hidden="true"></span>
        <div class="tl-head">
          <span class="tl-title">${iconFor(type)} ${esc(ev.title || (type === "status" ? "Status" : "Evento"))}</span>
          <span class="tl-time" title="${esc(created || "")}">${rel}</span>
        </div>
        ${ev.message ? `<div class="tl-msg">${esc(ev.message)}</div>` : ""}
        <div class="tl-meta"></div>
      `;

      const metaBox = item.querySelector(".tl-meta");
      if (meta?.status)     metaBox.insertAdjacentHTML("beforeend", `<span class="tl-badge">status: <b>${esc(meta.status)}</b></span>`);
      if (meta?.log_status) metaBox.insertAdjacentHTML("beforeend", `<span class="tl-badge">log: <b>${esc(meta.log_status)}</b></span>`);
      if (meta?.cd?.responsavel) metaBox.insertAdjacentHTML("beforeend", `<span class="tl-badge">CD: ${esc(meta.cd.responsavel)}</span>`);
      if (meta?.cd?.receivedAt)
        metaBox.insertAdjacentHTML("beforeend", `<span class="tl-badge">recebido: ${new Date(meta.cd.receivedAt).toLocaleString("pt-BR")}</span>`);
      if (meta?.cd?.unreceivedAt)
        metaBox.insertAdjacentHTML("beforeend", `<span class="tl-badge">removido: ${new Date(meta.cd.unreceivedAt).toLocaleString("pt-BR")}</span>`);
      if (meta?.cd?.inspectedAt)
        metaBox.insertAdjacentHTML("beforeend", `<span class="tl-badge">inspecionado: ${new Date(meta.cd.inspectedAt).toLocaleString("pt-BR")}</span>`);

      frag.appendChild(item);
    });
    wrap.appendChild(frag);
  }

  async function refreshTimeline(id) {
    const elLoad = $("events-loading");
    const elList = $("events-list");
    if (elLoad) elLoad.hidden = false;
    if (elList) elList.setAttribute("aria-busy", "true");
    try {
      const items = await fetchEvents(id, 100, 0);
      renderEvents(items);
    } catch (e) {
      renderEvents([]);
      console.error(e);
    } finally {
      if (elLoad) elLoad.hidden = true;
      if (elList) elList.setAttribute("aria-busy", "false");
    }
  }

  // ===== Keyboard shortcuts =====
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      save();
    }
  });

  // ==== Load inicial ====
  async function load() {
    if (!returnId) {
      const cont = document.querySelector(".page-wrap");
      if (cont) cont.innerHTML = '<div class="card"><b>ID não informado.</b></div>';
      return;
    }
    try {
      await reloadCurrent();
      await refreshTimeline(current.id);
    } catch (e) {
      const cont = document.querySelector(".page-wrap");
      if (cont) cont.innerHTML = `<div class="card"><b>${e.message || "Falha ao carregar."}</b></div>`;
    }
  }

  // Recalcular automaticamente
  ["valor_produto", "valor_frete", "status", "tipo_reclamacao"].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("input", recalc);
    if (el.tagName === "SELECT") el.addEventListener("change", recalc);
  });

  // Botões do topo
  const btnIA = $("btn-insp-aprova");
  const btnIR = $("btn-insp-reprova");
  if (btnIA) btnIA.addEventListener("click", () => openInspectDialog("aprovado"));
  if (btnIR) btnIR.addEventListener("click", () => openInspectDialog("rejeitado"));

  const rqA = $("rq-aprovar");
  const rqR = $("rq-reprovar");
  if (rqA) rqA.addEventListener("click", () => openInspectDialog("aprovado"));
  if (rqR) rqR.addEventListener("click", () => openInspectDialog("rejeitado"));

  const btnSalvar = $("btn-salvar");
  if (btnSalvar) btnSalvar.addEventListener("click", save);

  // Carregar quando DOM estiver pronto
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", load);
  } else {
    load();
  }
})();
