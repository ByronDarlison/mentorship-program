import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './build.mjs';

export function createPreviewServer(result) {
  const { config, pages, destination } = result;
  return createServer(async (request, response) => {
    const headers = {
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow',
      'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"
    };
    if (request.headers.host !== new URL(config.origin).host) { response.writeHead(403, headers); response.end('Local preview only'); return; }
    if (!['GET','HEAD'].includes(request.method)) { response.writeHead(405, {...headers, Allow:'GET, HEAD'}); response.end('Submissions are disabled'); return; }
    const route = new URL(request.url, config.origin).pathname.replace(/\/$/, '') || '/';
    let body, type = 'text/html; charset=utf-8', status = 200;
    if (pages.has(route) && route !== '/404') body = pages.get(route);
    else if (['/assets/site.css','/assets/site.js'].includes(route)) {
      body = await readFile(path.join(destination, route));
      type = route.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
    } else if (route === '/robots.txt') { body = 'User-agent: *\nDisallow: /\n'; type = 'text/plain'; }
    else { body = pages.get('/404'); status = 404; }
    response.writeHead(status, { ...headers, 'Content-Type': type });
    response.end(request.method === 'HEAD' ? undefined : body);
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await build(process.argv[2]);
  const server = createPreviewServer(result);
  const origin = new URL(result.config.origin);
  server.listen(Number(origin.port || 80), '127.0.0.1', () => console.log(`Local: ${result.config.origin}`));
}
