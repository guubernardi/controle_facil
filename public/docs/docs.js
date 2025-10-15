/* ===========================
   Docs – Conteúdo dos guias
   =========================== */

const guides = {
  ml: {
    title: "Guia · Mercado Livre",
    sections: [
      {
        id: "visao",
        h: "Visão geral",
        html:
          "<p>OAuth do Mercado Livre com tokens e refresh automático.</p>" +
          "<p>Após conectar, você poderá consultar a conta ativa, listar contas salvas e desconectar pelo painel.</p>"
      },
      {
        id: "env",
        h: "Variáveis",
        html:
          "<ul>" +
            "<li><code>ML_CLIENT_ID</code></li>" +
            "<li><code>ML_CLIENT_SECRET</code></li>" +
            "<li><code>ML_REDIRECT_URI</code> → <code>/auth/ml/callback</code></li>" +
            "<li><code>ML_AUTH_URL</code></li>" +
            "<li><code>ML_TOKEN_URL</code></li>" +
            "<li><code>ML_BASE_URL</code></li>" +
            "<li><code>ML_WEBHOOK_URL</code> (URL pública para webhooks)</li>" +
          "</ul>"
      },
      {
        id: "urls",
        h: "URLs úteis",
        html:
          "<pre>/auth/ml/login\n/auth/ml/callback\n\n/api/ml/status\n/api/ml/accounts\n/api/ml/active   (POST {\"user_id\":\"...\"})\n/api/ml/disconnect   (POST)\n/api/ml/me</pre>"
      }
    ]
  },

  bling: {
    title: "Guia · Bling (ERP)",
    sections: [
      {
        id: "visao",
        h: "Visão geral",
        html:
          "<p>Conexão via OAuth do Bling para sincronizar dados (pedidos, clientes e NF) – quando habilitado.</p>"
      },
      {
        id: "env",
        h: "Variáveis",
        html:
          "<ul>" +
            "<li><code>BLING_CLIENT_ID</code></li>" +
            "<li><code>BLING_CLIENT_SECRET</code></li>" +
            "<li><code>BLING_REDIRECT_URI</code></li>" +
            "<li><code>BLING_AUTHORIZE_URL</code>, <code>BLING_TOKEN_URL</code>, <code>BLING_API_BASE</code> (padrões oficiais)</li>" +
            "<li><code>BLING_WEBHOOK_URL</code> (URL pública para webhooks)</li>" +
          "</ul>"
      },
      {
        id: "urls",
        h: "URLs úteis",
        html:
          "<pre>/auth/bling/login\n/auth/bling/callback\n/api/bling/status</pre>"
      }
    ]
  },

  /* =====================
     NOVO · Guia de API
     ===================== */
  api: {
    title: "Guia · API",
    sections: [
      {
        id: "visao",
        h: "Visão geral",
        html:
          "<p>Endpoints HTTP JSON para relatórios, KPIs e integrações internas do app.</p>" +
          "<ul>" +
            "<li>Base URL (produção): <code>https://controle-facil.onrender.com</code></li>" +
            "<li><b>Content-Type</b>: <code>application/json; charset=utf-8</code></li>" +
            "<li>Erros retornam <code>{ ok:false, error:&quot;...&quot; }</code> ou <code>{ error:&quot;...&quot; }</code>.</li>" +
          "</ul>"
      },
      {
        id: "auth",
        h: "Autenticação",
        html:
          "<p>Atualmente os endpoints são internos do painel. Se um token de API vier a ser habilitado, use o cabeçalho:</p>" +
          "<pre>Authorization: Bearer &lt;SEU_TOKEN&gt;</pre>"
      },
      {
        id: "health",
        h: "Healthcheck",
        html:
          "<pre>GET /api/health\n→ { ok: true, time: \"2025-01-01T12:34:56.000Z\" }\n\nGET /api/db/ping\n→ { ok: true, now: \"2025-01-01T12:34:56.000Z\" }</pre>"
      },
      {
        id: "returns_logs",
        h: "Logs de custos de devoluções",
        html:
          "<p>Lista o log consolidado com filtros. Retorna paginação e soma.</p>" +
          "<pre>GET /api/returns/logs?from=2025-01-01&amp;to=2025-02-01&amp;status=aprovada&amp;page=1&amp;pageSize=50</pre>" +
          "<p><b>Parâmetros (query)</b></p>" +
          "<ul>" +
            "<li><code>from</code>, <code>to</code> (YYYY-MM-DD) – intervalo de datas</li>" +
            "<li><code>status</code>, <code>log_status</code>, <code>responsavel</code>, <code>loja</code>, <code>q</code> (busca livre)</li>" +
            "<li><code>return_id</code> (numérico)</li>" +
            "<li><code>page</code>, <code>pageSize</code> (1..200), <code>orderBy</code>, <code>orderDir</code></li>" +
          "</ul>" +
          "<p><b>Resposta (exemplo)</b></p>" +
          "<pre>{\n  \"items\": [ { \"return_id\": 123, \"status\": \"aprovada\", \"total\": 49.90, ... } ],\n  \"total\": 120,\n  \"sum_total\": 3456.78,\n  \"page\": 1,\n  \"pageSize\": 50\n}</pre>"
      },
      {
        id: "return_events",
        h: "Eventos de uma devolução",
        html:
          "<pre>GET /api/returns/789/events?limit=50&amp;offset=0</pre>" +
          "<p>Retorna trilha/auditoria do <code>return_id</code> solicitado.</p>" +
          "<pre>{ \"items\": [ { \"type\":\"status\",\"title\":\"Aprovada\",\"createdAt\":\"...\" } ] }</pre>"
      },
      {
        id: "dashboard",
        h: "Dashboard",
        html:
          "<p>Dados agregados para gráficos.</p>" +
          "<pre>GET /api/dashboard?from=2025-01-01&amp;to=2025-02-01&amp;limitTop=5</pre>" +
          "<pre>{\n  \"daily\":   [ { \"date\":\"2025-01-05\",\"prejuizo\": 123.45 }, ... ],\n  \"monthly\": [ { \"month\":\"Jan 2025\",\"prejuizo\": 2345.67 }, ... ],\n  \"status\":  { \"pendente\": 12, \"aprovado\": 34, \"rejeitado\": 7 },\n  \"top_items\": [ { \"sku\":\"ABC-123\", \"devolucoes\": 8, \"prejuizo\": 199.90, \"motivo\":\"tamanho\" } ],\n  \"totals\": { \"total\": 120, \"pendentes\": 12, \"aprovadas\": 80, \"rejeitadas\": 28, \"prejuizo_total\": 9876.54 }\n}</pre>"
      },
      {
        id: "home",
        h: "Home (KPIs e pendências)",
        html:
          "<pre>GET /api/home/kpis\n→ { total, pendentes, aprovadas, rejeitadas, a_conciliar }</pre>" +
          "<pre>GET /api/home/pending\n→ { recebidos_sem_inspecao: [ ... ], sem_conciliacao_csv: [ ... ], csv_pendente: [] }</pre>" +
          "<pre>GET /api/home/announcements\n→ { items: [ \"texto...\" ] }</pre>"
      },
      {
        id: "integrations",
        h: "Saúde das integrações",
        html:
          "<pre>GET /api/integrations/health\n→ { bling: { ok: true, mode: \"oauth\" }, mercado_livre: { ok: false, mode: \"csv\" } }</pre>"
      },
      {
        id: "ml_helpers",
        h: "Apoio · Mercado Livre",
        html:
          "<pre>GET  /api/ml/status\nGET  /api/ml/accounts\nPOST /api/ml/active      {\"user_id\":\"1182709105\"}\nPOST /api/ml/disconnect\nGET  /api/ml/me</pre>" +
          "<p>Fluxo OAuth:</p>" +
          "<pre>/auth/ml/login  → redireciona para autorização\n/auth/ml/callback → troca code por tokens e persiste</pre>"
      },
      {
        id: "errors",
        h: "Modelo de erros",
        html:
          "<pre>{ \"ok\": false, \"error\": \"invalid_json\" }\n\n{ \"error\": \"Falha ao listar eventos\" }</pre>"
      }
    ]
  },

  /* =========================
     NOVO · Guia de Webhooks
     ========================= */
  webhooks: {
    title: "Guia · Webhooks",
    sections: [
      {
        id: "visao",
        h: "Visão geral",
        html:
          "<p>Endpoints HTTP para receber notificações externas (Mercado Livre, Bling, etc.).</p>" +
          "<ul>" +
            "<li>Método: <b>POST</b> (corpo JSON)</li>" +
            "<li>Resposta esperada: <code>200 OK</code> em até 2–3s</li>" +
            "<li>Recomendação: reter o <code>resource/id</code> e consultar a API de origem para obter o detalhe completo.</li>" +
          "</ul>"
      },
      {
        id: "ml",
        h: "Mercado Livre",
        html:
          "<p><b>Endpoint</b>: <code>POST /webhooks/ml</code></p>" +
          "<p><b>Env var</b>: <code>ML_WEBHOOK_URL</code> (copie essa URL pública no cadastro do app do ML).</p>" +
          "<p><b>Exemplo de payload</b> (o ML pode enviar variações por <i>topic</i>):</p>" +
          "<pre>{\n  \"resource\": \"/orders/1234567890\",\n  \"user_id\": 1182709105,\n  \"topic\": \"orders_v2\",\n  \"application_id\": 999999999999,\n  \"attempts\": 1,\n  \"sent\": \"2025-10-15T12:00:00.000Z\",\n  \"received\": \"2025-10-15T12:00:00.500Z\"\n}</pre>" +
          "<p><b>Resposta</b> esperada do servidor:</p>" +
          "<pre>{ \"ok\": true }</pre>" +
          "<p>Dica: use o <code>topic</code> para rotear; busque o detalhe via <code>GET /orders/:id</code>, <code>/shipments/:id</code>, etc., usando seu access_token válido.</p>"
      },
      {
        id: "bling",
        h: "Bling (quando habilitado)",
        html:
          "<p><b>Endpoint</b>: <code>POST /webhooks/bling</code></p>" +
          "<p><b>Env var</b>: <code>BLING_WEBHOOK_URL</code></p>" +
          "<p><b>Observações</b>:</p>" +
          "<ul>" +
            "<li>O Bling permite configurar eventos (ex.: pedido criado, nota emitida).</li>" +
            "<li>Valide a assinatura/segredo se configurado no Bling; responda 200 OK para evitar novas tentativas excessivas.</li>" +
          "</ul>"
      },
      {
        id: "security",
        h: "Segurança e validação",
        html:
          "<ul>" +
            "<li>Preferir <b>HTTPS</b> sempre.</li>" +
            "<li>Se a fonte suportar, valide assinatura HMAC (ex.: cabeçalho <code>X-Hub-Signature</code>) ou um <b>token secreto</b> no query/header.</li>" +
            "<li>Implemente <b>idempotência</b>: se um mesmo evento/payload chegar mais de uma vez, ignore duplicatas.</li>" +
          "</ul>"
      },
      {
        id: "testes",
        h: "Testes rápidos",
        html:
          "<p>Envie um POST manual:</p>" +
          "<pre>curl -i -X POST https://SEU_HOST/webhooks/ml \\ \n  -H \"Content-Type: application/json\" \\ \n  -d '{\"resource\":\"/orders/123\",\"user_id\":1182709105,\"topic\":\"orders_v2\"}'</pre>"
      }
    ]
  },

  //placeholder para Shopee
  shopee: {
    title: "Guia · Shopee",
    sections: [
      {
        id: "breve",
        h: "Em breve",
        html: "<p>Integração em desenvolvimento.</p>"
      }
    ]
  }
};

/* ===============================
   Renderização (TOC e conteúdo)
   =============================== */
const qp = new URLSearchParams(location.search);
const key = qp.get("g") || "ml";
const g = guides[key] || guides.ml;

const titleEl = document.getElementById("doc-title");
if (titleEl) titleEl.textContent = g.title;

const toc = document.getElementById("toc");
if (toc) toc.innerHTML = g.sections.map(s => `<a href="#${s.id}">${s.h}</a>`).join("");

const content = document.getElementById("content");
if (content) {
  content.innerHTML = g.sections.map(s =>
    `<section id="${s.id}">
      <h2>${s.h}</h2>
      ${s.html}
    </section>`
  ).join("");
}

