/**
 * RadialProgress — donut loader/progress em JS puro (ESM).
 *
 * • Auto-init: adiciona progresso em todo elemento com [data-rp]
 *   Atributos suportados:
 *     - data-value="0..100"          (determinado)
 *     - data-indeterminate="true"    (spinner)
 *     - data-size="96"               (px)
 *     - data-thickness="10"          (px)
 *     - data-color="#0b5fff"         (cor do progresso; padrão: var(--primary) ou azul)
 *     - data-track="#e5e7eb"         (cor da trilha; padrão: var(--border))
 *     - data-label="true|false"      (mostra porcentagem no centro; padrão: true se determinado)
 *     - data-duration="700"          (ms para animar a mudança de valor)
 *
 * • API:
 *     const inst = RadialProgress.create(elOrSelector, opts?)      // cria/monta
 *     inst.set(value, opts?)                                       // atualiza (anima)
 *     RadialProgress.scan(context?)                                // melhora [data-rp]
 *     RadialProgress.destroy(elOrSelector)                         // remove listeners/refs
 *
 * • Acessibilidade: role="progressbar" + aria-valuenow/min/max.
 */

const ONE_STYLE_ID = 'radial-progress-css-v1';
injectOnce(`
.rp { position:relative; display:inline-grid; place-items:center; }
.rp svg { display:block; transform: rotate(-90deg); }
.rp .rp-label { position:absolute; inset:auto; font-weight:600; color: var(--muted-foreground,#6b7280); }
.rp .rp-ring { transition: stroke-dashoffset .2s ease; transform-origin: 50% 50%; }
.rp[data-indeterminate="true"] .rp-ring {
  stroke-dasharray: 80 300;
  animation: rp-spin 1.2s linear infinite;
}
@keyframes rp-spin { to { transform: rotate(360deg); } }
`);

function injectOnce(css) {
  if (document.getElementById(ONE_STYLE_ID)) return;
  const tag = document.createElement('style');
  tag.id = ONE_STYLE_ID;
  tag.textContent = css;
  document.head.appendChild(tag);
}

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const pick = (v, d) => (v === undefined || v === null || v === '') ? d : v;

class RP {
  constructor(el, opts = {}) {
    this.el = typeof el === 'string' ? document.querySelector(el) : el;
    if (!this.el) throw new Error('RadialProgress: elemento não encontrado');

    const ds = this.el.dataset || {};
    this.size      = Number(pick(opts.size, ds.size, 96));
    this.thickness = Number(pick(opts.thickness, ds.thickness, 10));
    this.color     = String(pick(opts.color, ds.color, getCss('--primary', '#0b5fff')));
    this.track     = String(pick(opts.track, ds.track, getCss('--border', '#e5e7eb')));
    this.duration  = Number(pick(opts.duration, ds.duration, 700));
    this.indet     = toBool(pick(opts.indeterminate, ds.indeterminate, false));
    this.labelOn   = toBool(pick(opts.label, ds.label, !this.indet));
    this.value     = this.indet ? 0 : clamp(Number(pick(opts.value, ds.value, 0)), 0, 100);

    // marca de modo
    if (this.indet) this.el.setAttribute('data-indeterminate', 'true'); else this.el.removeAttribute('data-indeterminate');

    // constrói DOM
    this._build();

    // inicial
    if (!this.indet) this._apply(0, this.value, 0); // sem anim inicial
  }

  _build() {
    const s = this.size;
    const t = clamp(this.thickness, 2, Math.max(2, Math.floor(s/2)));
    const r = (s/2) - t/2;                   // raio no meio do traço
    const c = 2 * Math.PI * r;               // circunferência
    this._circ = c;

    // SVG
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width',  String(s));
    svg.setAttribute('height', String(s));
    svg.setAttribute('viewBox', `0 0 ${s} ${s}`);
    svg.setAttribute('aria-hidden', 'true');

    // trilha (back)
    const back = document.createElementNS(svg.namespaceURI, 'circle');
    back.setAttribute('cx', s/2);
    back.setAttribute('cy', s/2);
    back.setAttribute('r',  r);
    back.setAttribute('fill', 'none');
    back.setAttribute('stroke', this.track);
    back.setAttribute('stroke-width', t);
    back.setAttribute('stroke-linecap', 'round');

    // frente (progress)
    const ring = document.createElementNS(svg.namespaceURI, 'circle');
    ring.classList.add('rp-ring');
    ring.setAttribute('cx', s/2);
    ring.setAttribute('cy', s/2);
    ring.setAttribute('r',  r);
    ring.setAttribute('fill', 'none');
    ring.setAttribute('stroke', this.color);
    ring.setAttribute('stroke-width', t);
    ring.setAttribute('stroke-linecap', 'round');
    ring.setAttribute('stroke-dasharray', String(c));
    ring.setAttribute('stroke-dashoffset', String(c));

    // label
    const label = document.createElement('div');
    label.className = 'rp-label';
    label.style.fontSize = Math.max(10, Math.round(s * 0.22)) + 'px';
    label.style.userSelect = 'none';
    label.textContent = this.indet ? '' : `${Math.round(this.value)}%`;
    if (!this.labelOn) label.style.display = 'none';

    // wrapper
    const wrap = document.createElement('div');
    wrap.className = 'rp';
    wrap.style.width  = s + 'px';
    wrap.style.height = s + 'px';
    if (this.indet) wrap.setAttribute('data-indeterminate','true');

    // a11y
    wrap.setAttribute('role', 'progressbar');
    wrap.setAttribute('aria-valuemin', '0');
    wrap.setAttribute('aria-valuemax', '100');
    wrap.setAttribute('aria-label', 'Progresso');

    // monta
    svg.appendChild(back);
    svg.appendChild(ring);
    wrap.appendChild(svg);
    wrap.appendChild(label);

    // limpa alvo e injeta
    this.el.innerHTML = '';
    this.el.appendChild(wrap);

    // refs
    this.wrap  = wrap;
    this.svg   = svg;
    this.ring  = ring;
    this.label = label;
  }

  set(value = 0, opts = {}) {
    if (this.indet) return this; // indeterminado não muda
    const to = clamp(Number(value), 0, 100);
    const from = clamp(Number(this.value), 0, 100);
    const dur = Number(pick(opts.duration, this.duration, 700));
    this._apply(from, to, dur);
    this.value = to;
    return this;
  }

  _apply(from, to, durationMs) {
    const c = this._circ;
    const start = performance.now();
    const lab = this.label;
    const ring = this.ring;
    const wrap = this.wrap;

    wrap.setAttribute('aria-valuenow', String(Math.round(to)));

    if (!durationMs) {
      ring.setAttribute('stroke-dashoffset', String(c * (1 - to/100)));
      if (lab && this.labelOn) lab.textContent = `${Math.round(to)}%`;
      return;
    }

    const anim = (now) => {
      const t = clamp((now - start) / durationMs, 0, 1);
      const cur = from + (to - from) * easeOutCubic(t);
      ring.setAttribute('stroke-dashoffset', String(c * (1 - cur/100)));
      if (lab && this.labelOn) lab.textContent = `${Math.round(cur)}%`;
      if (t < 1) this._raf = requestAnimationFrame(anim);
    };
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(anim);
  }

  destroy() {
    cancelAnimationFrame(this._raf);
    if (this.el) this.el.innerHTML = '';
  }
}

// Utils
function easeOutCubic(t){ return 1 - Math.pow(1 - t, 3); }
function toBool(v){ if (typeof v === 'boolean') return v; const s = String(v||'').toLowerCase().trim(); return s==='1'||s==='true'||s==='yes'; }
function getCss(name, fallback){ try{ const v = getComputedStyle(document.documentElement).getPropertyValue(name); return v?.trim() || fallback; }catch{ return fallback; } }

// ---- API pública ----
const RadialProgress = {
  create(elOrSelector, opts){ return new RP(elOrSelector, opts); },
  scan(root){
    const scope = root ? (typeof root === 'string' ? document.querySelector(root) : root) : document;
    if (!scope) return [];
    const nodes = Array.from(scope.querySelectorAll('[data-rp]:not([data-rp-initialized])'));
    return nodes.map(n => {
      n.setAttribute('data-rp-initialized','1');
      return new RP(n);
    });
  },
  destroy(elOrSelector){
    const el = typeof elOrSelector === 'string' ? document.querySelector(elOrSelector) : elOrSelector;
    if (!el) return;
    el.innerHTML = '';
  }
};

// Auto-init
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => RadialProgress.scan(document));
} else {
  RadialProgress.scan(document);
}

// expõe no window e como módulo
window.RadialProgress = RadialProgress;
export default RadialProgress;
