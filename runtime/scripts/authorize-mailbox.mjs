#!/usr/bin/env node
// One-time Google web OAuth bootstrap for the mentorship mailbox.
//
//   node runtime/scripts/authorize-mailbox.mjs <clientPath> <outputPath>
//
// Both paths must live outside this repository. Nothing secret is ever printed:
// the terminal only shows the local start URL and a generic success/failure.

import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HOST = '127.0.0.1';
export const PORT = 8765;
export const START_PATH = '/start';
export const CALLBACK_PATH = '/oauth2callback';
export const REDIRECT_URI = `http://${HOST}:${PORT}${CALLBACK_PATH}`;
export const OWNER_EMAIL = 'mentorship@example.invalid';
export const SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.events.owned',
]);
export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const PROFILE_ENDPOINT =
  'https://gmail.googleapis.com/gmail/v1/users/me/profile';
export const HTTP_TIMEOUT_MS = 20_000;
export const OVERALL_TIMEOUT_MS = 10 * 60 * 1000;

export const REPO_ROOT = realpathSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'),
);

const SUCCESS_PAGE =
  '<!doctype html><meta charset="utf-8"><title>Authorization</title>' +
  '<p>Authorization complete. Return to the terminal and close this tab.</p>';
const FAILURE_PAGE =
  '<!doctype html><meta charset="utf-8"><title>Authorization</title>' +
  '<p>Authorization failed. Return to the terminal.</p>';

// The only failure text the terminal ever prints. Provider, filesystem and
// thrown-error details are deliberately dropped: they can carry tokens,
// response bodies or paths.
export const CLI_FAILURE_MESSAGE = 'Authorization failed. Nothing was saved.';

// ---------------------------------------------------------------- path safety

export function isInsideRepo(target, repoRoot = REPO_ROOT) {
  const rel = relative(repoRoot, target);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

// Resolves real parents so a symlink cannot be used to escape the check.
export function resolveOutsideRepo(input, { mustExist }) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('path is required');
  }
  const abs = resolve(input);
  let real;
  if (mustExist) {
    if (!existsSync(abs)) throw new Error('path does not exist');
    real = realpathSync(abs);
  } else {
    const parent = dirname(abs);
    if (!existsSync(parent)) throw new Error('parent directory does not exist');
    real = resolve(realpathSync(parent), basename(abs));
  }
  if (isInsideRepo(real)) {
    throw new Error('path must be outside the repository');
  }
  return real;
}

// --------------------------------------------------------------- client input

export function loadClientConfig(clientPath) {
  const real = resolveOutsideRepo(clientPath, { mustExist: true });
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(real, 'utf8'));
  } catch {
    throw new Error('client file is not valid JSON');
  }
  const web = parsed && parsed.web;
  if (!web || typeof web !== 'object') {
    throw new Error('client file must contain a "web" client');
  }
  if (typeof web.client_id !== 'string' || web.client_id === '') {
    throw new Error('client file is missing client_id');
  }
  if (typeof web.client_secret !== 'string' || web.client_secret === '') {
    throw new Error('client file is missing client_secret');
  }
  const uris = web.redirect_uris;
  if (!Array.isArray(uris) || !uris.includes(REDIRECT_URI)) {
    throw new Error(`client must register the exact redirect ${REDIRECT_URI}`);
  }
  return { clientId: web.client_id, clientSecret: web.client_secret };
}

export function writeCredentials(outputPath, credentials) {
  const body = `${JSON.stringify(credentials, null, 2)}\n`;
  try {
    writeFileSync(outputPath, body, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      throw new Error('output file already exists; refusing to overwrite');
    }
    throw new Error('could not write the output file');
  }
}

// ----------------------------------------------------------------- PKCE/state

export function createPkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, method: 'S256' };
}

export function createState() {
  return randomBytes(32).toString('base64url');
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

export function buildAuthUrl({ clientId, state, challenge }) {
  const url = new URL(AUTH_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    login_hint: OWNER_EMAIL,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

// ------------------------------------------------------------ provider calls

function requestSignal(external) {
  const timeout = AbortSignal.timeout(HTTP_TIMEOUT_MS);
  if (!external) return timeout;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([timeout, external]);
  }
  return timeout;
}

export function verifyGrantedScopes(scope) {
  const granted = new Set(String(scope ?? '').split(/\s+/).filter(Boolean));
  const missing = SCOPES.filter((s) => !granted.has(s));
  if (missing.length > 0) {
    throw new Error('granted scopes are missing a required Google scope');
  }
  const extra = [...granted].filter((s) => !SCOPES.includes(s));
  if (extra.length > 0) {
    throw new Error('granted scopes include scopes that were not requested');
  }
}

export async function exchangeCode(
  { clientId, clientSecret, code, verifier },
  fetchImpl = globalThis.fetch,
  signal,
) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
  }).toString();
  const res = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body,
    signal: requestSignal(signal),
  });
  if (!res.ok) throw new Error('token exchange was rejected by the provider');
  return res.json();
}

export async function fetchProfileEmail(
  accessToken,
  fetchImpl = globalThis.fetch,
  signal,
) {
  const res = await fetchImpl(PROFILE_ENDPOINT, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
    },
    signal: requestSignal(signal),
  });
  if (!res.ok) throw new Error('profile lookup was rejected by the provider');
  const profile = await res.json();
  return profile && profile.emailAddress;
}

// Returns only the three values that may be persisted.
export async function completeAuthorization(
  { config, verifier, code },
  fetchImpl = globalThis.fetch,
  signal,
) {
  const token = await exchangeCode(
    {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      verifier,
    },
    fetchImpl,
    signal,
  );
  if (typeof token?.access_token !== 'string' || token.access_token === '') {
    throw new Error('provider response did not include an access token');
  }
  verifyGrantedScopes(token.scope);
  if (typeof token.refresh_token !== 'string' || token.refresh_token === '') {
    throw new Error(
      'provider response did not include a refresh token; revoke the app and retry',
    );
  }
  const email = await fetchProfileEmail(token.access_token, fetchImpl, signal);
  if (email !== OWNER_EMAIL) {
    throw new Error('the authorized account is not the mentorship mailbox');
  }
  return {
    GOOGLE_CLIENT_ID: config.clientId,
    GOOGLE_CLIENT_SECRET: config.clientSecret,
    GOOGLE_REFRESH_TOKEN: token.refresh_token,
  };
}

// ---------------------------------------------------------------- local server

// `done` runs after the body has been flushed to the socket, so the caller can
// close the server without truncating the browser response.
function respond(res, status, html, extraHeaders = {}, done) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    connection: 'close',
    ...extraHeaders,
  });
  res.end(html, () => {
    if (typeof done === 'function') done();
  });
}

export function createRequestHandler({
  config,
  session,
  fetchImpl,
  signal,
  saveCredentials,
  onDone,
}) {
  return function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, `http://${HOST}:${PORT}`);
    } catch {
      respond(res, 400, FAILURE_PAGE);
      return;
    }
    if (req.method !== 'GET') {
      respond(res, 405, FAILURE_PAGE);
      return;
    }
    if (url.pathname === START_PATH) {
      const location = buildAuthUrl({
        clientId: config.clientId,
        state: session.state,
        challenge: session.challenge,
      });
      respond(res, 302, '', { location });
      return;
    }
    if (url.pathname !== CALLBACK_PATH) {
      respond(res, 404, FAILURE_PAGE);
      return;
    }

    // One-shot claim, taken synchronously before any await.
    if (session.claimed) {
      respond(res, 409, FAILURE_PAGE);
      return;
    }
    session.claimed = true;

    const state = url.searchParams.get('state') ?? '';
    if (!safeEqual(state, session.state)) {
      respond(res, 400, FAILURE_PAGE, {}, () =>
        onDone(new Error('callback state did not match')),
      );
      return;
    }
    if (url.searchParams.has('error')) {
      respond(res, 400, FAILURE_PAGE, {}, () =>
        onDone(new Error('authorization was denied at the consent screen')),
      );
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      respond(res, 400, FAILURE_PAGE, {}, () =>
        onDone(new Error('callback did not include an authorization code')),
      );
      return;
    }

    // Persist first: the browser only sees success once the credentials are on
    // disk. Thrown errors are discarded rather than propagated, because a
    // provider parse/transport failure can carry response content.
    completeAuthorization(
      { config, verifier: session.verifier, code },
      fetchImpl,
      signal,
    ).then(
      async (credentials) => {
        try {
          await saveCredentials(credentials);
        } catch {
          respond(res, 500, FAILURE_PAGE, {}, () =>
            onDone(new Error('the credentials could not be saved')),
          );
          return;
        }
        respond(res, 200, SUCCESS_PAGE, {}, () => onDone(null, credentials));
      },
      () => {
        respond(res, 400, FAILURE_PAGE, {}, () =>
          onDone(new Error('authorization did not complete')),
        );
      },
    );
  };
}

export function runServerFlow({
  config,
  saveCredentials,
  fetchImpl = globalThis.fetch,
  log = console.log,
}) {
  const session = { state: createState(), claimed: false, ...createPkce() };
  const controller = new AbortController();
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let server;
    let timer;

    // Ordinary finishes run after the response flushed, so only idle sockets are
    // dropped. Timeouts and bind failures still force every connection closed.
    const cleanup = (force) => {
      clearTimeout(timer);
      controller.abort();
      if (!server) return;
      if (force && typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      } else if (typeof server.closeIdleConnections === 'function') {
        server.closeIdleConnections();
      }
      server.close();
    };
    const finish = (err, credentials, { force = false } = {}) => {
      if (settled) return;
      settled = true;
      cleanup(force);
      if (err) rejectPromise(err);
      else resolvePromise(credentials);
    };

    server = createServer(
      createRequestHandler({
        config,
        session,
        fetchImpl,
        signal: controller.signal,
        saveCredentials,
        onDone: finish,
      }),
    );
    server.on('error', () =>
      finish(new Error('could not bind 127.0.0.1:8765'), undefined, { force: true }),
    );
    server.listen(PORT, HOST, () => {
      log(`Open http://${HOST}:${PORT}${START_PATH} in a browser signed in as the mentorship mailbox.`);
    });

    timer = setTimeout(() => {
      session.claimed = true;
      finish(new Error('authorization timed out after 10 minutes'), undefined, {
        force: true,
      });
    }, OVERALL_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

export async function main(argv, deps = {}) {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const [clientPath, outputPath] = argv;
  if (!clientPath || !outputPath) {
    error('usage: authorize-mailbox.mjs <clientPath> <outputPath>');
    return 2;
  }
  let config;
  let outPath;
  try {
    config = loadClientConfig(clientPath);
    outPath = resolveOutsideRepo(outputPath, { mustExist: false });
    if (existsSync(outPath)) {
      throw new Error('output file already exists; refusing to overwrite');
    }
  } catch {
    error(CLI_FAILURE_MESSAGE);
    return 1;
  }
  try {
    const runFlow = deps.runFlow ?? runServerFlow;
    await runFlow({
      config,
      saveCredentials: (credentials) => writeCredentials(outPath, credentials),
      fetchImpl: deps.fetch ?? globalThis.fetch,
      log,
    });
    log('Authorization complete. Credentials saved with 0600 permissions.');
    return 0;
  } catch {
    error(CLI_FAILURE_MESSAGE);
    return 1;
  }
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
