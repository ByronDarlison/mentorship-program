import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { renderDesignReview } from './render.mjs';

export const origin = 'http://127.0.0.1:4318';
const directory = new URL('./', import.meta.url);
const assetTypes = new Map([
  ['/design.css', 'text/css; charset=utf-8'], ['/review.js', 'text/javascript; charset=utf-8'],
  ['/assets/roboto-regular.ttf', 'font/ttf'], ['/assets/roboto-medium.ttf', 'font/ttf'],
  ['/assets/roboto-bold.ttf', 'font/ttf']
]);
export async function loadReview() {
  const source = await readFile(new URL('../../program/program-manual.md', directory), 'utf8');
  const result = renderDesignReview(source);
  const assets = new Map();
  for (const [route, type] of assetTypes) {
    assets.set(route, { body: await readFile(new URL(route.slice(1), directory)), type });
  }
  return { ...result, assets };
}
export function createReviewServer(result, allowedHost = new URL(origin).host) {
  return createServer((request, response) => {
    const headers = {
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow',
      'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; font-src 'self'; frame-src 'self'; frame-ancestors 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'"
    };
    if (request.headers.host !== allowedHost) {
      response.writeHead(403, headers); response.end('Local design review only'); return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { ...headers, Allow: 'GET, HEAD' }); response.end('Submissions are disabled'); return;
    }
    let route;
    try { route = new URL(request.url, origin).pathname.replace(/\/$/, '') || '/'; }
    catch { response.writeHead(400, headers); response.end('Invalid request'); return; }
    let body, type = 'text/html; charset=utf-8', status = 200;
    if (result.pages.has(route) && route !== '/404') body = result.pages.get(route);
    else if (result.assets.has(route)) ({ body, type } = result.assets.get(route));
    else if (route === '/robots.txt') { body = 'User-agent: *\nDisallow: /\n'; type = 'text/plain; charset=utf-8'; }
    else { body = result.pages.get('/404'); status = 404; }
    response.writeHead(status, { ...headers, 'Content-Type': type });
    response.end(request.method === 'HEAD' ? undefined : body);
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await loadReview();
  const server = createReviewServer(result);
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(4318, '127.0.0.1', () => console.log(`Local: ${origin}/`));
}
