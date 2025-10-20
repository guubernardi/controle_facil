// /public/js/page-loader.js
(function () {
  const CSS = `
  #pageLoader{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;
    background:rgba(248,250,252,.92);backdrop-filter:saturate(120%) blur(2px);
    opacity:1;visibility:visible;transition:opacity .18s ease,visibility .18s ease}
  #pageLoader.hidden{opacity:0;visibility:hidden;pointer-events:none}
  #pageLoader .pl{width:56px;height:56px;border-radius:50%;
    border:4px solid rgba(0,0,0,.08);border-top-color:#0b5fff;animation:plspin .8s linear infinite}
  @keyframes plspin{to{transform:rotate(360deg)}}
  `;

  function injectCss() {
    if (document.getElementById('pageLoaderCSS')) return;
    const s = document.createElement('style');
    s.id = 'pageLoaderCSS';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }
  function ensure() {
    let el = document.getElementById('pageLoader');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pageLoader';
      el.innerHTML = `<div class="pl" role="status" aria-label="Carregando"></div>`;
      (document.body || document.documentElement).appendChild(el);
    }
    return el;
  }

  injectCss();
  const el = ensure(); // mostra imediatamente

  let holdUntil = 0;

  function show() {
    injectCss();
    ensure().classList.remove('hidden');
  }
  function hideNow() {
    const n = ensure();
    n.classList.add('hidden');
    setTimeout(() => { if (n && n.parentNode) n.remove(); }, 300);
  }
  function done() {
    const wait = holdUntil - Date.now();
    if (wait > 0) {
      clearTimeout(done._t);
      done._t = setTimeout(done, wait);
      return;
    }
    hideNow();
  }
  function hold(ms = 0) {
    const t = Date.now() + Math.max(0, ms | 0);
    if (t > holdUntil) holdUntil = t;
    show();
  }

  // API nova (usada pelo central.js)
  window.PageLoader = { show, hide: hideNow, hold, done };

  // Compatibilidade com versões antigas
  window.pageLoaderShow = show;
  window.pageLoaderDone = done;

  // Fallback de segurança: se ninguém chamar done() em 20s, some
  setTimeout(() => { if (document.getElementById('pageLoader')) done(); }, 20000);
})();
