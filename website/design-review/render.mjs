import { parseManual, renderSite, escape } from '../src/render.mjs';
import { routes } from '../src/routes.mjs';
import { renderApplicationBody } from './applications.mjs';
import { conversationIllustration, addTrainingVisuals } from './visuals.mjs';

function document(title, body, bodyClass = '') {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>${escape(title)} | Example Chapter Mentorship</title>
<link rel="stylesheet" href="/design.css"><script src="/review.js" defer></script></head>
<body class="${bodyClass}">${body}</body></html>`;
}

function logo() {
  // Present the unchanged official PNG at its visible artwork size. The viewport
  // removes excess transparent canvas only and preserves the surrounding clearspace.
  return '<span class="neutral-wordmark">Mentorship</span>';
}

function header(reference = false) {
  return `<header class="site-header"><div class="draft-banner">Draft, subject to Example Chapter Board approval.</div><div class="container header-inner">
<div class="header-identity"><a class="brand-link" href="/home" aria-label="Example Chapter Mentorship home">${logo()}</a><p class="header-program-name">Mentorship Program</p></div>
<button class="menu-toggle" type="button" aria-expanded="false" aria-controls="main-navigation">Menu</button>
<nav id="main-navigation" aria-label="Main navigation">
<a href="/home">About the program</a><a href="/apply/mentee">Mentees</a><a href="/apply/mentor">Mentors</a><a href="/training">Training</a>
</nav></div></header>`;
}

function footer() {
  return `<footer class="site-footer"><div class="footer-band"><div class="container footer-inner">
<p>Questions <a href="mailto:mentorship@example.invalid">mentorship@example.invalid</a></p>
<nav aria-label="Supporting links"><a href="/terms">Program Terms</a><a href="/privacy">Privacy Notice</a></nav>
</div></div></footer>`;
}

export function renderDesignReview(source, options = {}) {
  const manual = parseManual(source);
  const groups = new Map();
  const home = manual.sectionById.get('home').tokens;
  let group;
  for (let index = 0; index < home.length; index++) {
    const token = home[index];
    if (token.type === 'heading_open' && token.tag === 'h3') {
      const title = home[index + 1].content;
      if (groups.has(title)) throw new Error(`Duplicate Home group: ${title}`);
      group = { title, tokens: [] };
      groups.set(title, group);
      index += 2;
    } else if (group) group.tokens.push(token);
  }
  const expected = [
    'One-to-one mentorship for meaningful business progress.', 'For mentees',
    'For mentors', 'How mentorship works',
    'The commitment'
  ];
  if (JSON.stringify([...groups.keys()]) !== JSON.stringify(expected)) {
    throw new Error('Approved Home structure changed. Review the mockup mapping before rendering.');
  }
  manual.md.renderer.rules.link_open = (tokens, index, options, env, self) => {
    const token = tokens[index];
    const href = token.attrGet('href');
    if (!href?.startsWith('#')) throw new Error('Home review accepts canonical internal links only');
    const destination = manual.headingDestinations.get(href.slice(1));
    if (!destination) throw new Error(`Unknown canonical link: ${href}`);
    token.attrSet('href', destination === '/' ? href : `${destination}${href}`);
    return self.renderToken(tokens, index, options);
  };
  const content = title => manual.md.renderer.render(groups.get(title).tokens, manual.md.options, {});
  function subsections(title, expectedTitles) {
    const sections = new Map();
    let section;
    for (let index = 0; index < groups.get(title).tokens.length; index++) {
      const token = groups.get(title).tokens[index];
      if (token.type === 'heading_open' && token.tag === 'h4') {
        const subsectionTitle = groups.get(title).tokens[index + 1].content;
        if (sections.has(subsectionTitle)) throw new Error(`Duplicate ${title} subsection: ${subsectionTitle}`);
        section = { title: subsectionTitle, tokens: [] };
        sections.set(subsectionTitle, section);
        index += 2;
      } else if (section) section.tokens.push(token);
      else throw new Error(`${title} content must begin with a subsection`);
    }
    if (JSON.stringify([...sections.keys()]) !== JSON.stringify(expectedTitles)) {
      throw new Error(`${title} structure changed. Review the homepage mapping before rendering.`);
    }
    return sections;
  }
  function card(title, role) {
    const html = content(title).replace(/<h4\b/g, '<h3').replaceAll('</h4>', '</h3>')
      .replace('<p>If helpful,', '<p class="optional-tool">If helpful,');
    const action = /<p><a href="[^"]+">Apply<\/a><\/p>/g;
    if ([...html.matchAll(action)].length !== 1) throw new Error(`Expected one Apply action for ${role}`);
    const optionalPattern = /<p class="optional-tool">[\s\S]*?<\/p>/g;
    const optional = [...html.matchAll(optionalPattern)];
    if (optional.length !== (role === 'Mentees' ? 1 : 0)) throw new Error(`Unexpected optional-tool content for ${role}`);
    // Keep the resource in the mentee section and reading order, outside the
    // coloured panel so it does not create an empty footer in the mentor panel.
    const panel = html.replace(optionalPattern, '').replace(action,
      `<div class="card-action"><a class="apply" href="/apply/${role === 'Mentees' ? 'mentee' : 'mentor'}">Apply</a></div>`);
    return `<section class="role-card" id="${role.toLowerCase()}" aria-labelledby="${role.toLowerCase()}-heading">
<div class="role-panel"><h2 id="${role.toLowerCase()}-heading">${role}</h2>${panel}</div>${optional[0]?.[0] || ''}</section>`;
  }
  const commitment = subsections('The commitment', ['Both participants', 'As a mentee', 'As a mentor']);
  const commitmentGroup = (title, className) => `<section class="commitment-group ${className}"><h3>${escape(title)}</h3>${manual.md.renderer.render(commitment.get(title).tokens, manual.md.options, {})}</section>`;
  const body = `<div class="site-surface"><a class="skip-link" href="#main">Skip to content</a>${header()}
<main id="main" tabindex="-1">
<div class="container opening"><div class="intro">
<div class="headline-row"><h1>${escape(expected[0])}</h1>${conversationIllustration()}</div>${content(expected[0])}</div>
<div class="role-grid">${card('For mentees', 'Mentees')}${card('For mentors', 'Mentors')}</div></div>
<section class="container process-section" id="how-mentorship-works" aria-labelledby="process-heading"><h2 id="process-heading">How mentorship works</h2>${content('How mentorship works')}</section>
<section class="commitment-section" aria-labelledby="commitment-heading"><div class="container"><h2 id="commitment-heading">The commitment</h2>
<div class="commitment-content">${commitmentGroup('Both participants', 'commitment-shared')}<hr><div class="commitment-roles">${commitmentGroup('As a mentee', 'commitment-mentee')}${commitmentGroup('As a mentor', 'commitment-mentor')}</div></div></div></section>
</main>${footer()}</div>`;
  const pages = new Map([
    ['/', document('Example Chapter Mentorship', body, 'review-page')],
    ['/home', document('Example Chapter Mentorship', body, 'review-page')]
  ]);
  for (const role of ['mentee', 'mentor']) {
    const title = role === 'mentee' ? 'Mentee application' : 'Mentor application';
    pages.set(`/apply/${role}`, document(title, `<div class="site-surface"><a class="skip-link" href="#main">Skip to content</a>${header(true)}<main id="main" class="container application-page" tabindex="-1">${renderApplicationBody(manual, role)}</main>${footer()}</div>`, 'review-page'));
  }
  // Render only the current supporting pages. Applications already use their own layout.
  const reference = renderSite(source, {
    mode: 'local-preview', siteName: 'Example Chapter Mentorship', operatorName: 'Example Chapter',
    origin: 'http://127.0.0.1:4318', contactEmail: null,
    applicationsOpen: false, externalServicesEnabled: false
  }, undefined, {mode:options.mode});
  for (const [route, html] of reference.pages) {
    if (route === '/' || route.startsWith('/apply/')) continue;
    const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1];
    if (!main) throw new Error(`Reference content missing: ${route}`);
    let referenceBody = main.replaceAll('href="/"', 'href="/home"').replace(/<a href="(https:[^"]+)"/g, '<a target="_blank" rel="noopener noreferrer" href="$1"');
    if (['/terms', '/privacy'].includes(route)) referenceBody = referenceBody
      .replace(/<aside class="on-this-page">[\s\S]*?<\/aside>/, '')
      .replace(/<p class="eyebrow">[\s\S]*?<\/p>/, '')
      .replace(/<div class="related">[\s\S]*?<\/div>/, '');
    const training = route === '/training';
    if (training) referenceBody = addTrainingVisuals(referenceBody, manual);
    const pageTitle = routes.find(item => item.path === route)?.title ?? 'Page not found';
    // Put the repeated section's anchor on its visible page heading.
    const repeated = referenceBody.match(/(<section\b[^>]*>)\s*<h2([^>]*)>([\s\S]*?)<\/h2>/);
    if (repeated && (repeated[3].trim() === escape(pageTitle) || route === '/privacy') && referenceBody.includes('<h1>')) {
      referenceBody = referenceBody.replace(repeated[0], repeated[1]).replace('<h1>', `<h1${repeated[2]}>`);
    }
    pages.set(route, document(pageTitle, `<div class="site-surface"><a class="skip-link" href="#main">Skip to content</a>${header(true)}<main id="main" class="container reference-main${training ? ' training-page' : ''}" tabindex="-1">${referenceBody}</main>${footer()}</div>`, 'review-page'));
  }
  for (const [route, html] of pages) {
    pages.set(route, html.replace(/<a href="\/owners-outcome(?:#[^"]*)?"/g, '$& target="_blank" rel="noopener noreferrer"'));
  }
  if (options.connected) {
    for (const [route, html] of pages) {
      pages.set(route, html.replace('</head>', '<script src="/application.js" defer></script></head>')
        .replace('class="application-form"', `class="application-form" data-connected="${options.mode??'review'}"`)
        .replace('type="submit"', 'type="submit" disabled'));
    }
  }
  return { pages, manualSHA256: manual.digest };
}
