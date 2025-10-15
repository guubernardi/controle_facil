/* public/docs/docs.js */
'use strict';

(function () {
  // --------- Definição dos guias ----------
  const guides = {
    ml: {
      title: 'Guia · Mercado Livre',
      sections: [
        {
          id: 'visao',
          h: 'Visão geral',
          html: '<p>OAuth do Mercado Livre com tokens e refresh automático.</p>',
        },
        {
          id: 'env',
          h: 'Variáveis',
          html: `<ul>
            <li><code>ML_CLIENT_ID</code></li>
            <li><code>ML_CLIENT_SECRET</code></li>
            <li><code>ML_REDIRECT_URI</code> → <code>/auth/ml/callback</code></li>
          </ul>`,
        },
        {
          id: 'urls',
          h: 'URLs úteis',
          html: `<pre>/auth/ml/login
/auth/ml/callback
/api/ml/status
/api/ml/me</pre>`,
        },
      ],
    },
    bling: {
      title: 'Guia · Bling (ERP)',
      sections: [
        {
          id: 'visao',
          h: 'Visão geral',
          html: '<p>Conexão via OAuth do Bling para pedidos, clientes e NF.</p>',
        },
        {
          id: 'env',
          h: 'Variáveis',
          html: `<ul>
            <li><code>BLING_CLIENT_ID</code></li>
            <li><code>BLING_CLIENT_SECRET</code></li>
            <li><code>BLING_REDIRECT_URI</code></li>
          </ul>`,
        },
        {
          id: 'urls',
          h: 'URLs úteis',
          html: `<pre>/auth/bling/login
/auth/bling/callback
/api/bling/status</pre>`,
        },
      ],
    },
    // shopee: { ...quando tiver... }
  };

  function onReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  onReady(() => {
    const params = new URLSearchParams(location.search);
    const key = (params.get('g') || 'ml').toLowerCase();
    const guide = guides[key] || guides.ml;

    // Título
    const titleEl = document.getElementById('doc-title');
    if (titleEl) titleEl.textContent = guide.title;

    // TOC
    const tocEl = document.getElementById('toc');
    if (tocEl) {
      tocEl.innerHTML = guide.sections
        .map((s) => `<a href="#${s.id}" data-id="${s.id}">${s.h}</a>`)
        .join('');
    }

    // Conteúdo
    const contentEl = document.getElementById('content');
    if (contentEl) {
      contentEl.innerHTML = guide.sections
        .map(
          (s) =>
            `<section id="${s.id}" class="doc-section">
               <h2>${s.h}</h2>
               ${s.html}
             </section>`
        )
        .join('');
    }

    // Destaque do TOC conforme a âncora
    function markActive() {
      const hash = location.hash || (guide.sections[0] ? '#' + guide.sections[0].id : '');
      const links = document.querySelectorAll('#toc a');
      links.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === hash));
    }
    window.addEventListener('hashchange', markActive);
    markActive();

    // Se veio sem hash, rola para a primeira seção
    if (!location.hash && guide.sections[0]) {
      // não muda a URL (só scroll)
      const first = document.getElementById(guide.sections[0].id);
      if (first && typeof first.scrollIntoView === 'function') {
        first.scrollIntoView({ behavior: 'instant', block: 'start' });
      }
    }
  });
})();
