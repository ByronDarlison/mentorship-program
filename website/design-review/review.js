const menu = document.querySelector('.menu-toggle');
const navigation = document.querySelector('#main-navigation');
const root = document.documentElement;
const surface = document.querySelector('.site-surface');
const siteHeader = surface?.querySelector('.site-header');
function updateFixedHeaderHeight() {
  if (!surface || !siteHeader) return;
  root.style.setProperty('--fixed-header-height', `${Math.ceil(siteHeader.getBoundingClientRect().height)}px`);
}
function closeMenu() {
  menu?.setAttribute('aria-expanded', 'false');
  navigation?.classList.remove('is-open');
  updateFixedHeaderHeight();
}
menu?.addEventListener('click', () => {
  const open = menu.getAttribute('aria-expanded') !== 'true';
  menu.setAttribute('aria-expanded', String(open));
  navigation.classList.toggle('is-open', open);
  updateFixedHeaderHeight();
});
navigation?.addEventListener('click', event => {
  if (event.target.closest('a')) closeMenu();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && menu?.getAttribute('aria-expanded') === 'true') {
    closeMenu();
    menu.focus();
  }
});

if (surface && siteHeader && typeof ResizeObserver === 'function') {
  // Enable the fixed/collapsible treatment only when its behavior is available.
  root.setAttribute('data-navigation-ready', '');
  new ResizeObserver(updateFixedHeaderHeight).observe(siteHeader);
  updateFixedHeaderHeight();
  if (window.location.hash) {
    const target = document.getElementById(window.location.hash.slice(1));
    target?.scrollIntoView({ block: 'start' });
  }
}

for (const form of document.querySelectorAll('.application-form')) {
  if (form.dataset?.connected) continue;
  const confirmation = form.nextElementSibling;
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!form.checkValidity()) { form.reportValidity(); return; }
    // Local rehearsal only: do not serialize, log, store or transmit the answers.
    form.reset();
    form.hidden = true;
    confirmation.hidden = false;
    confirmation.focus({ preventScroll: true });
    confirmation.scrollIntoView({ block: 'start' });
  });
  confirmation.querySelector('[data-preview-again]').addEventListener('click', () => {
    confirmation.hidden = true;
    form.hidden = false;
    form.querySelector('input').focus();
  });
  window.addEventListener('pagehide', () => form.reset());
}
