/* DYPOL Creator Console — motion helpers (5 Nov 2026 reskin).
   One delegated pointer listener adds a ripple to buttons, tabs and chips;
   pageEnter() plays a short fade/slide when a page renders. Everything is
   transform/opacity only and switches off with prefers-reduced-motion. */

const RIPPLE = '.btn, .icon-btn, .nav-item, .tab__fab, .tab__icon, .segbar button, .seg button, .chip, .view-btn';

const reduced = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

export function initMotion(doc = document) {
  doc.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || reduced()) return;
    const host = e.target.closest?.(RIPPLE);
    if (!host || host.disabled || host.getAttribute('aria-disabled') === 'true') return;
    host.classList.add('ripple-host');
    const r = host.getBoundingClientRect();
    const d = Math.max(r.width, r.height) * 2.2;
    const s = doc.createElement('span');
    s.className = 'rp-ripple';
    s.setAttribute('aria-hidden', 'true');
    s.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px`;
    host.appendChild(s);
    s.addEventListener('animationend', () => s.remove(), { once: true });
    setTimeout(() => s.remove(), 900); // safety net
  }, { passive: true });
}

let enterTimer = 0;
/** Fade/slide the freshly rendered page in, once (not on every re-render). */
export function pageEnter(root) {
  if (!root || reduced()) return;
  clearTimeout(enterTimer);
  root.classList.remove('page-enter');
  void root.offsetWidth; // restart the animation
  root.classList.add('page-enter');
  enterTimer = setTimeout(() => root.classList.remove('page-enter'), 650);
}
