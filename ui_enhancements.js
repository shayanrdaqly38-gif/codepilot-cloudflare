// ============================
//  UI/UX ENHANCEMENTS — a11y, mobile, animations, empty states
// ============================

// Skip link for keyboard users
function injectSkipLink() {
  if (document.getElementById('skipLink')) return;
  const link = document.createElement('a');
  link.id = 'skipLink';
  link.href = '#chat';
  link.className = 'skip-link';
  link.textContent = 'برو به گفتگو';
  link.style.cssText = 'position:absolute;top:-100%;left:50%;transform:translateX(-50%);background:var(--accent);color:#fff;padding:8px 16px;border-radius:0 0 8px 8px;z-index:9999;transition:top .2s';
  link.addEventListener('focus', () => link.style.top = '0');
  link.addEventListener('blur', () => link.style.top = '-100%');
  document.body.prepend(link);
}

// Focus trap for modals
let lastFocusedElement = null;
function trapFocus(modal) {
  lastFocusedElement = document.activeElement;
  const focusable = modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  modal._focusHandler = (e) => {
    if (e.key !== 'Tab') return;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  modal.addEventListener('keydown', modal._focusHandler);
  first?.focus();
}
function releaseFocus(modal) {
  modal.removeEventListener('keydown', modal._focusHandler);
  lastFocusedElement?.focus();
}

// Announce to screen readers
function announce(message, polite = 'polite') {
  const region = document.getElementById('a11y-region') || (() => {
    const r = document.createElement('div');
    r.id = 'a11y-region';
    r.setAttribute('aria-live', polite);
    r.setAttribute('aria-atomic', 'true');
    r.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden';
    document.body.appendChild(r);
    return r;
  })();
  region.setAttribute('aria-live', polite);
  region.textContent = '';
  requestAnimationFrame(() => region.textContent = message);
}

// Reduced motion respect
function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Staggered entrance animation for lists
function staggerChildren(container, selector = '.stagger-item', baseDelay = 40) {
  if (prefersReducedMotion()) return;
  const items = container.querySelectorAll(selector);
  items.forEach((el, i) => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    el.style.transition = 'opacity .3s ease, transform .3s ease';
    requestAnimationFrame(() => {
      setTimeout(() => {
        el.style.opacity = '1';
        el.style.transform = 'translateY(0)';
      }, i * baseDelay);
    });
  });
}

// Empty state helper
function renderEmptyState(container, { icon = '📭', title = 'خالی', description = 'هیچ موردی یافت نشد', actionLabel, actionFn } = {}) {
  container.innerHTML = `
    <div class="empty-state" style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 20px;text-align:center;color:var(--muted);gap:12px">
      <div style="font-size:48px;opacity:.6">${icon}</div>
      <h3 style="margin:0;font-size:16px;font-weight:600;color:var(--text)">${title}</h3>
      <p style="margin:0;font-size:13px;max-width:280px">${description}</p>
      ${actionLabel && actionFn ? `<button class="btn primary" onclick="${actionFn}" style="margin-top:8px">${actionLabel}</button>` : ''}
    </div>`;
}

// Micro-interaction: button press ripple
function addRipple(button) {
  if (prefersReducedMotion()) return;
  button.addEventListener('pointerdown', (e) => {
    const rect = button.getBoundingClientRect();
    const ripple = document.createElement('span');
    ripple.style.cssText = `
      position:absolute;left:${e.clientX - rect.left}px;top:${e.clientY - rect.top}px;
      width:0;height:0;border-radius:50%;background:currentColor;opacity:.3;
      transform:translate(-50%,-50%);animation:ripple .4s ease-out forwards;pointer-events:none;z-index:1
    `;
    button.style.position = 'relative';
    button.style.overflow = 'hidden';
    button.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove());
  });
}

// Inject ripple keyframes once
if (!document.getElementById('ripple-style')) {
  const style = document.createElement('style');
  style.id = 'ripple-style';
  style.textContent = `
    @keyframes ripple { to { width:300px; height:300px; opacity:0 } }
    .skip-link:focus { top: 0 !important; }
  `;
  document.head.appendChild(style);
}

// Enhanced toast with icon + action
function toast(message, options = {}) {
  const { duration = 3000, type = 'info', actionLabel, actionFn, icon } = options;
  const icons = { info: 'ℹ️', success: '✅', warn: '⚠️', error: '❌', loading: '⏳' };
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.style.cssText = `
    position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(100px);
    background:var(--panel);border:1px solid var(--line);padding:12px 16px;border-radius:12px;
    display:flex;align-items:center;gap:10px;max-width:90vw;z-index:9999;
    box-shadow:0 8px 32px rgba(0,0,0,.3);opacity:0;transition:transform .3s cubic-bezier(.2,.8,.2,1),opacity .2s;
    font-size:14px;direction:rtl
  `;
  el.innerHTML = `<span>${icon || icons[type] || ''}</span><span>${message}</span>${actionLabel && actionFn ? `<button onclick="${actionFn};this.closest('.toast').remove()" style="margin-right:auto;padding:4px 10px;border:1px solid var(--line);border-radius:6px;background:transparent;color:var(--text);font-size:12px;cursor:pointer">${actionLabel}</button>` : ''}`;
  document.body.appendChild(el);
  requestAnimationFrame(() => { el.style.transform = 'translateX(-50%) translateY(0)'; el.style.opacity = '1'; });
  const remove = () => { el.style.transform = 'translateX(-50%) translateY(100px)'; el.style.opacity = '0'; setTimeout(() => el.remove(), 300); };
  if (duration > 0) setTimeout(remove, duration);
  return { remove };
}

// Smooth scroll polyfill for mobile
function smoothScrollTo(element, offset = 0) {
  if (!element) return;
  const target = element.getBoundingClientRect().top + window.scrollY + offset;
  window.scrollTo({ top: target, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

// Initialize all UI/UX enhancements
function initUIEnhancements() {
  injectSkipLink();
  
  // Add ripple to all buttons
  document.querySelectorAll('button:not([data-no-ripple])').forEach(addRipple);
  
  // Observe new buttons for ripple
  new MutationObserver(() => {
    document.querySelectorAll('button:not([data-no-ripple]):not([data-ripple-added])').forEach(btn => {
      btn.dataset.rippleAdded = 'true';
      addRipple(btn);
    });
  }).observe(document.body, { childList: true, subtree: true });
  
  // Keyboard navigation hint
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') document.body.classList.add('keyboard-nav');
  });
  document.addEventListener('mousedown', () => document.body.classList.remove('keyboard-nav'));
  
  // Respect prefers-reduced-motion globally
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  mq.addEventListener('change', () => {
    document.body.classList.toggle('reduce-motion', mq.matches);
  });
  document.body.classList.toggle('reduce-motion', mq.matches);
  
  // Announce page changes
  announce('برنامه بارگذاری شد');
}