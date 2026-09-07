import MarkdownIt from 'markdown-it';
import { createHash } from 'node:crypto';
import { routes, navigation } from './routes.mjs';
import { readInternalNotes, markInternalTokens } from './internal-notes.mjs';

export const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export const slug = value => value.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');

export function validateConfig(config) {
  const allowed = ['mode', 'siteName', 'operatorName', 'origin', 'contactEmail', 'applicationsOpen', 'externalServicesEnabled'];
  if (Object.keys(config).some(key => !allowed.includes(key))) throw new Error('Unknown operator setting');
  if (config.mode !== 'local-preview' || config.applicationsOpen !== false || config.externalServicesEnabled !== false || config.contactEmail !== null) {
    throw new Error('This release supports disconnected local previews only');
  }
  for (const key of ['siteName', 'operatorName']) {
    if (typeof config[key] !== 'string' || !config[key].trim() || config[key].length > 100) throw new Error(`Invalid ${key}`);
  }
  const origin = new URL(config.origin);
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname) || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error('Preview origin must be a loopback HTTP origin');
  }
  return config;
}

export function parseManual(source) {
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
  const { content, ranges } = readInternalNotes(source);
  const tokens = md.parse(content, {});
  markInternalTokens(tokens, ranges, content);
  const sections = [];
  const ids = new Set();
  let section;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type === 'heading_open') {
      const title = tokens[index + 1].content;
      const base = slug(title);
      let id = base, n = 1;
      while (ids.has(id)) id = `${base}-${n++}`;
      ids.add(id);
      token.attrSet('id', id);
      if (token.tag === 'h2') {
        section = { id, title, tokens: [] };
        sections.push(section);
      }
    }
    if (section) section.tokens.push(token);
  }
  if (!sections.length) throw new Error('Manual has no sections');
  for (const item of sections) {
    if (!item.tokens.some(token => token.type === 'inline' && ['**Status: Agreed**', '**Status: Draft for review**'].includes(token.content))) throw new Error(`Missing content status: ${item.title}`);
  }
  const sectionById = new Map(sections.map(item => [item.id, item]));
  const primary = new Map();
  for (const route of routes.filter(route => route.sections !== '*')) {
    for (const id of route.sections) {
      if (!sectionById.has(id)) throw new Error(`Missing mapped section: ${id}`);
      if (primary.has(id)) throw new Error(`Conflicting section mapping: ${id}`);
      primary.set(id, route.path);
    }
  }
  const headingDestinations = new Map();
  for (const item of sections) {
    for (const token of item.tokens.filter(token => token.type === 'heading_open')) {
      headingDestinations.set(token.attrGet('id'), primary.get(item.id) || '/manual');
    }
  }
  return { md, sections, sectionById, headingDestinations, internalNoteCount: ranges.length, digest: createHash('sha256').update(source).digest('hex') };
}

function renderTokens(manual, tokens, route, config) {
  const renderer = manual.md.renderer;
  renderer.rules.link_open = (items, index, options, env, self) => {
    const item = items[index];
    const href = item.attrGet('href');
    if (href.startsWith('#')) {
      const destination = manual.headingDestinations.get(href.slice(1));
      if (!destination) throw new Error(`Unknown manual anchor: ${href}`);
      item.attrSet('href', `${route.path === '/manual' ? '/manual' : destination}${href}`);
    } else if (!/^https:\/\//.test(href)) {
      throw new Error(`Unapproved public link: ${href}`);
    }
    if (/github\.com\/ByronDarlison\//i.test(href)) throw new Error('Private repository link cannot enter site');
    return self.renderToken(items, index, options);
  };
  renderer.rules.table_open = () => '<div class="table-wrap"><table>\n';
  renderer.rules.table_close = () => '</table></div>\n';
  renderer.rules.th_open = (items, index, options, env, self) => {
    items[index].attrSet('scope', 'col');
    return self.renderToken(items, index, options);
  };
  let html = '';
  for (let start = 0; start < tokens.length;) {
    const internal = Boolean(tokens[start].meta?.internalNote);
    let end = start + 1;
    while (end < tokens.length && Boolean(tokens[end].meta?.internalNote) === internal) end++;
    if (!internal || route.path === '/manual') {
      const content = renderer.render(tokens.slice(start, end), manual.md.options, {});
      html += internal
        ? `<aside class="implementation-note" aria-label="Implementation and review note"><p class="note-label">Implementation and review note</p>${content}</aside>`
        : content;
    }
    start = end;
  }
  // Only the operator name is substituted. Source paragraphs remain canonical.
  html = html.replaceAll('Example Chapter', escape(config.operatorName));
  return html.replace(/<p><strong>Status: ([^<]+)<\/strong>/g, '<p class="content-status"><strong>Status: $1</strong>');
}

function sectionHTML(manual, section, route, config) {
  const tokens = structuredClone(section.tokens);
  // structuredClone loses markdown-it Token methods, so restore their prototypes.
  tokens.forEach((token, index) => {
    Object.setPrototypeOf(token, Object.getPrototypeOf(section.tokens[index]));
    if (token.children) token.children.forEach((child, childIndex) => Object.setPrototypeOf(child, Object.getPrototypeOf(section.tokens[index].children[childIndex])));
  });
  const start = tokens.findIndex(token => token.type === 'heading_open' && token.attrGet('id') === 'facilitator-notes');
  const end = tokens.findIndex(token => token.type === 'heading_open' && token.attrGet('id') === 'minimum-training-materials');
  let html;
  if (start >= 0 && end > start) {
    html = renderTokens(manual, tokens.slice(0, start), route, config)
      + '<details class="supporting"><summary>Facilitator notes and fictional cases</summary><div class="disclosure-content">'
      + renderTokens(manual, tokens.slice(start, end), route, config) + '</div></details>'
      + renderTokens(manual, tokens.slice(end), route, config);
  } else html = renderTokens(manual, tokens, route, config);
  if (route.path === '/training' && section.id === 'training-curriculum') {
    // The route supplies the page title; retain the canonical anchor and make
    // the six curriculum modules the next heading level for participants.
    html = html.replace('<h2 id="training-curriculum">Training curriculum</h2>', '<div id="training-curriculum"></div>')
      .replace(/<h3\b/g, '<h2').replaceAll('</h3>', '</h2>')
      .replace(/<h4\b/g, '<h3').replaceAll('</h4>', '</h3>');
    html = html.replace(/(<h3 id="(?:taking-over|helping-through-questions|helping-through-experience)">[\s\S]*?)(?=<h[23]\b)/g,
      '<section class="training-example">$1</section>');
  }
  if (['/terms', '/privacy'].includes(route.path)) {
    // Approval labels describe the specification, not final public-policy approval.
    html = html.replace(/<p class="content-status"><strong>Status: Agreed<\/strong><\/p>\n?/g, '');
  }
  if (route.path === '/mentees' && section.id === 'the-mentee-application' || route.path === '/mentors' && section.id === 'the-mentor-profile') {
    html = html.replace(/(<blockquote>\s*<p>I understand[\s\S]*?<\/blockquote>)/, '$1<p class="policy-links"><a href="/terms">Program Terms</a><span aria-hidden="true"> · </span><a href="/privacy">Privacy Notice</a></p>');
  }
  return `<section class="manual-section" data-source-section="${section.id}">${html}</section>`;
}

function shell(route, config, body, metadata, toc = '') {
  const nav = navigation.map(item => `<a href="${item.path}"${item.path === route.path ? ' aria-current="page"' : ''}>${item.title}</a>`).join('');
  const title = route.path === '/' ? config.siteName : `${route.title} | ${config.siteName}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<meta name="description" content="${escape(route.title)}. ${escape(config.siteName)} local review preview.">
<title>${escape(title)}</title><link rel="stylesheet" href="/assets/site.css"><script src="/assets/site.js" defer></script></head>
<body><a class="skip-link" href="#main">Skip to content</a>
<header class="site-header"><div class="header-inner"><a class="wordmark" href="/">${escape(config.siteName)}</a>
<button class="menu-toggle" type="button" aria-expanded="false" aria-controls="primary-navigation">Menu</button>
<nav id="primary-navigation" aria-label="Main navigation">${nav}</nav></div></header>
<div class="preview-banner"><div class="container"><span class="preview-label">Local preview</span> Program under development. No applications are open.</div></div>
<main id="main" class="container" tabindex="-1">${toc ? `<div class="reading-layout">${toc}<article>${body}</article></div>` : body}</main>
<footer class="site-footer"><div class="container"><a class="footer-title" href="/">${escape(config.siteName)}</a>
<nav aria-label="Supporting links"><a href="/terms">Program Terms</a><a href="/privacy">Privacy Notice</a><a href="/contact">Contact and support</a><a href="/licensing">Licensing and reuse</a></nav>
<p class="review-note">Local review only. Official branding and final design remain under review.</p>
<p class="source-note">Manual updated ${escape(metadata.updated)} · Source ${escape(metadata.commit.slice(0, 7))}</p></div></footer>
</body></html>`;
}

export function renderSite(source, config, metadata = { updated: '2026-09-04', commit: 'uncommitted' }, view = {}) {
  validateConfig(config);
  const manual = parseManual(source);
  const pages = new Map();
  for (const route of routes) {
    const sections = route.sections === '*' ? manual.sections : route.sections.map(id => manual.sectionById.get(id));
    const heading = `<div class="page-heading">${route.path === '/training' ? '' : `<p class="eyebrow">${route.path === '/manual' ? 'Program reference' : escape(config.siteName)}</p>`}<h1>${route.title}</h1></div>`;
    if (route.path === '/') {
      const home = sectionHTML(manual, sections[0], route, config);
      if (home.includes('id="one-to-one-mentorship-for-meaningful-business-progress"')) {
        // Keep the existing closed preview readable after approved source-copy updates.
        // Visual design remains a separate review artifact until Byron approves it.
        const closedHome = home
          .replace('<h2 id="home">Home</h2>', '<div id="home"></div>')
          .replace(/<h3 id="one-to-one-mentorship-for-meaningful-business-progress">(.*?)<\/h3>/, '<h1 id="one-to-one-mentorship-for-meaningful-business-progress">$1</h1>')
          .replace(/<p><a href="[^"]+">Apply<\/a><\/p>\n?/g, '');
        const status = sectionHTML(manual, sections[1], route, config);
        pages.set(route.path, shell(route, config, closedHome + status, metadata));
        continue;
      }
      const headline = home.match(/<h3 id="meaningful-business-results-through-trusted-mentorship">(.+?)<\/h3>/)?.[1];
      if (!headline) throw new Error('Home introduction is missing');
      const introduction = home.slice(home.indexOf('</h3>') + 5, home.indexOf('<h3 id="at-a-glance">'));
      const glance = home.slice(home.indexOf('<h3 id="at-a-glance">'), home.lastIndexOf('</section>')).replaceAll('<h3', '<h2').replaceAll('</h3>', '</h2>');
      const status = sectionHTML(manual, sections[1], route, config);
      pages.set(route.path, shell(route, config, `<div class="home-grid" id="home"><div class="home-intro"><p class="eyebrow">${escape(config.siteName)}</p><h1 id="meaningful-business-results-through-trusted-mentorship">${headline}</h1>${introduction}<a class="primary-action" href="/program">See how the program works <span aria-hidden="true">→</span></a><div class="role-links"><a href="/mentees">For mentees</a><a href="/mentors">For mentors</a></div></div><aside class="at-a-glance" aria-labelledby="at-a-glance">${glance}</aside></div><div class="current-status">${status}</div>`, metadata));
      continue;
    }
    const toc = route.path === '/training' ? '' : `<aside class="on-this-page"><details open><summary>On this page</summary><nav aria-label="On this page">${sections.map(section => `<a href="#${section.id}">${escape(section.title)}</a>`).join('')}</nav></details></aside>`;
    const statusLink = view.mode!=='operating'&&['/mentees', '/mentors'].includes(route.path) ? '<p class="application-status">Applications are not open. You can review the questions below.</p>' : '';
    const body = heading + statusLink + sections.map(section => sectionHTML(manual, section, route, config)).join('')
      + (['/manual', '/training'].includes(route.path) ? '' : '<div class="related"><a href="/training">Review the training</a></div>');
    pages.set(route.path, shell(route, config, body, metadata, toc));
  }
  const notFound = { path: '/404', title: 'Page not found' };
  pages.set('/404', shell(notFound, config, '<div class="not-found"><p class="eyebrow">404</p><h1>Page not found</h1><p><a href="/">Return to mentorship home</a></p><p><a href="/program">About the program</a> · <a href="/contact">Contact and support</a></p></div>', metadata));
  return { pages, report: { ...metadata, manualSHA256: manual.digest, internalNoteCount: manual.internalNoteCount, sections: manual.sections.map(section => ({ id: section.id, title: section.title, destination: manual.headingDestinations.get(section.id) })) } };
}
