document.documentElement.classList.add('js');
const menu = document.querySelector('.menu-toggle');
const navigation = document.querySelector('#primary-navigation');
function closeMenu(returnFocus = false) {
  navigation.classList.remove('is-open');
  menu.setAttribute('aria-expanded', 'false');
  if (returnFocus) menu.focus();
}
menu.addEventListener('click', () => {
  const open = menu.getAttribute('aria-expanded') !== 'true';
  menu.setAttribute('aria-expanded', String(open));
  navigation.classList.toggle('is-open', open);
});
navigation.addEventListener('click', event => { if (event.target.closest('a')) closeMenu(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') closeMenu(true); });
function revealAnchor() {
  let id;
  try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
  const target = document.getElementById(id);
  if (!target) return;
  let parent = target.parentElement;
  let opened = false;
  while (parent) {
    if (parent.tagName === 'DETAILS' && !parent.open) { parent.open = true; opened = true; }
    parent = parent.parentElement;
  }
  if (opened) target.scrollIntoView();
}
window.addEventListener('hashchange', revealAnchor);
revealAnchor();
let previouslyClosed = [];
window.addEventListener('beforeprint', () => {
  previouslyClosed = [...document.querySelectorAll('details:not([open])')];
  previouslyClosed.forEach(element => { element.open = true; });
});
window.addEventListener('afterprint', () => { previouslyClosed.forEach(element => { element.open = false; }); });
