<script>
const guides = {
  ml: {
    title: "Guia · Mercado Livre",
    sections: [
      { id:"visao",  h:"Visão geral", html:"<p>OAuth do Mercado Livre com tokens e refresh automático.</p>" },
      { id:"env",    h:"Variáveis",   html:`<ul>
        <li><code>ML_CLIENT_ID</code></li>
        <li><code>ML_CLIENT_SECRET</code></li>
        <li><code>ML_REDIRECT_URI</code> → <code>/auth/ml/callback</code></li>
      </ul>`},
      { id:"urls",   h:"URLs úteis",  html:`<pre>/auth/ml/login
/auth/ml/callback
/api/ml/status
/api/ml/me</pre>`}
    ]
  },
  bling: {
    title: "Guia · Bling (ERP)",
    sections: [
      { id:"visao", h:"Visão geral", html:"<p>Conexão via OAuth do Bling para pedidos, clientes e NF.</p>" },
      { id:"env",   h:"Variáveis",   html:`<ul>
        <li><code>BLING_CLIENT_ID</code></li>
        <li><code>BLING_CLIENT_SECRET</code></li>
        <li><code>BLING_REDIRECT_URI</code></li>
      </ul>`},
      { id:"urls",  h:"URLs úteis",  html:`<pre>/auth/bling/login
/auth/bling/callback
/api/bling/status</pre>`}
    ]
  },
  // shopee: { ...quando tiver... }
};

const qp = new URLSearchParams(location.search);
const key = qp.get("g") || "ml";
const g = guides[key] || guides.ml;

document.getElementById("doc-title").textContent = g.title;

// TOC
const toc = document.getElementById("toc");
toc.innerHTML = g.sections.map(s => `<a href="#${s.id}">${s.h}</a>`).join("");

// Content
const content = document.getElementById("content");
content.innerHTML = g.sections.map(s =>
  `<section id="${s.id}"><h2>${s.h}</h2>${s.html}</section>`
).join("");
</script>
