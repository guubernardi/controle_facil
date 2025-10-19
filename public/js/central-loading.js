/**
 * Central Loading Overlay
 * - Mostra um donut/spinner sobre #mk-cards e #a-caminho até chegar conteúdo real.
 * - Se o alvo ainda não tem tamanho (vazio), cobre a área de conteúdo da .card.
 * - Ignora skeletons/placeholders.
 */
(function () {
  const STYLE_ID = 'central-loading-css';

  injectOnce(`
  .clo-card{ position:relative; }
  .clo-overlay{
    position:absolute; display:grid; place-items:center;
    pointer-events:none; z-index: 50;
    transition: opacity .18s ease, visibility .18s ease;
    opacity:1; visibility:visible;
  }
  .clo-overlay.hidden{ opacity:0; visibility:hidden; }
  .clo-overlay .fallback-spinner{
    width:48px;height:48px;border-radius:50%;
    border:4px solid rgba(0,0,0,.08);
    border-top-color: var(--primary, #0b5fff);
    animation: clo-spin 0.9s linear infinite;
  }
  @keyframes clo-spin{ to{ transform: rotate(360deg); } }
  `);

  function injectOnce(css){
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = css;
    document.head.appendChild(s);
  }

  function mountOverlay(targetSel, size = 56){
    const target = document.querySelector(targetSel);
    if (!target) return null;

    const card = target.closest('.card');
    if (!card) return null;

    card.classList.add('clo-card');

    const overlay = document.createElement('div');
    overlay.className = 'clo-overlay';
    overlay.setAttribute('data-for', targetSel);

    // donut se disponível; senão spinner
    if (window.RadialProgress && typeof window.RadialProgress.scan === 'function') {
      overlay.innerHTML = `<div data-rp data-indeterminate="true" data-size="${size}"></div>`;
      try { window.RadialProgress.scan(overlay); } catch {}
    } else {
      overlay.innerHTML = `<div class="fallback-spinner" aria-hidden="true"></div>`;
    }

    card.appendChild(overlay);

    const pad = 12;

    const reposition = () => {
      const cardRect   = card.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();

      // quando o alvo ainda não tem altura/largura, usamos a área de conteúdo do card
      const header = card.querySelector('.card-header');
      const topContent = Math.max(
        pad,
        header ? header.getBoundingClientRect().bottom - cardRect.top + 8 : pad
      );

      const useTarget =
        targetRect.width >= 80 && targetRect.height >= 40; // tamanho "usável"

      const box = useTarget
        ? {
            left: Math.max(0, targetRect.left - cardRect.left) + pad,
            top:  Math.max(0, targetRect.top  - cardRect.top ) + pad,
            width:  Math.max(0, targetRect.width  - pad*2),
            height: Math.max(0, targetRect.height - pad*2)
          }
        : {
            left: pad,
            top:  topContent,
            width:  Math.max(0, cardRect.width  - pad*2),
            height: Math.max(0, cardRect.height - topContent - pad)
          };

      Object.assign(overlay.style, {
        left:   box.left + 'px',
        top:    box.top + 'px',
        width:  box.width + 'px',
        height: box.height + 'px'
      });
    };

    const isSkeletonEl = (el) => {
      if (!el || el.nodeType !== 1) return false;
      const cls = String(el.className || '').toLowerCase();
      return (
        el.hasAttribute('data-skeleton') ||
        cls.includes('skeleton') ||
        cls.includes('sk-') ||
        cls.includes('shimmer')
      );
    };

    const hasRealContent = () => {
      if (!target.children.length) return false;
      // se todos os filhos são skeletons (ou vazios), ainda carregando
      const allSkeletons = Array.from(target.children).every((ch) => {
        if (isSkeletonEl(ch)) return true;
        const txt = (ch.textContent || '').trim();
        return txt === '' && ch.children.length === 0;
      });
      return !allSkeletons;
    };

    const show = () => overlay.classList.remove('hidden');
    const hide = () => overlay.classList.add('hidden');

    const mo = new MutationObserver(() => {
      if (hasRealContent()) hide(); else show();
      reposition();
    });
    mo.observe(target, { childList: true, subtree: false });

    const ro1 = new ResizeObserver(reposition);
    const ro2 = new ResizeObserver(reposition);
    ro1.observe(card);
    ro2.observe(target);
    window.addEventListener('resize', reposition, { passive: true });

    // estado inicial
    show();
    reposition();
    // se já veio preenchido por algum motivo
    if (hasRealContent()) hide();

    return {
      show, hide,
      destroy(){
        mo.disconnect(); ro1.disconnect(); ro2.disconnect();
        window.removeEventListener('resize', reposition);
        overlay.remove();
      }
    };
  }

  document.addEventListener('DOMContentLoaded', () => {
    mountOverlay('#mk-cards', 56);
    mountOverlay('#a-caminho', 40);
  });

  window.CentralLoading = {
    show(sel){ document.querySelector(`.clo-overlay[data-for="${sel}"]`)?.classList.remove('hidden'); },
    done(sel){ document.querySelector(`.clo-overlay[data-for="${sel}"]`)?.classList.add('hidden'); }
  };
})();
