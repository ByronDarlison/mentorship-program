// Focused tests for the one-time mailbox authorization bootstrap.
// All identifiers, tokens and secrets below are fictional; nothing touches the
// network and nothing is written inside the repository.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CLI_FAILURE_MESSAGE,
  OWNER_EMAIL,
  PROFILE_ENDPOINT,
  REDIRECT_URI,
  REPO_ROOT,
  SCOPES,
  TOKEN_ENDPOINT,
  buildAuthUrl,
  completeAuthorization,
  createPkce,
  createRequestHandler,
  createState,
  loadClientConfig,
  main,
  resolveOutsideRepo,
  verifyGrantedScopes,
  writeCredentials,
} from '../scripts/authorize-mailbox.mjs';

const CONFIG = {
  clientId: '111111111111-fake.apps.googleusercontent.com',
  clientSecret: 'FAKE-client-secret',
};

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function fakeFetch({ token, profile }) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, init });
    if (target === TOKEN_ENDPOINT) return jsonResponse(200, token);
    if (target === PROFILE_ENDPOINT) return jsonResponse(200, profile);
    throw new Error(`unexpected request to ${target}`);
  };
  return { impl, calls };
}

function goodToken(overrides = {}) {
  return {
    access_token: 'fake-access-token',
    refresh_token: '1//fake-refresh-token',
    scope: SCOPES.join(' '),
    ...overrides,
  };
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'authorize-mailbox-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const SECRET_MARKERS = ['1//fake-refresh-token', 'FAKE-client-secret', 'super-secret'];

function assertNoSecret(text) {
  for (const marker of SECRET_MARKERS) {
    assert.ok(!String(text).includes(marker), `leaked ${marker}`);
  }
}

function newSession() {
  return { state: createState(), claimed: false, ...createPkce() };
}

function fakeReq(url) {
  return { method: 'GET', url };
}

// Minimal ServerResponse stand-in: records the status/body and runs the end
// callback the handler relies on for flush ordering.
function fakeRes() {
  const res = {
    statusCode: 0,
    headers: null,
    body: '',
    ended: false,
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = headers;
      return res;
    },
    end(chunk, cb) {
      res.body = typeof chunk === 'string' ? chunk : '';
      res.ended = true;
      if (typeof cb === 'function') cb();
    },
  };
  return res;
}

function callbackUrl(state, code) {
  return `/oauth2callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`;
}

function writeClientFile(dir) {
  const path = join(dir, 'client.json');
  writeFileSync(
    path,
    JSON.stringify({
      web: {
        client_id: CONFIG.clientId,
        client_secret: CONFIG.clientSecret,
        redirect_uris: [REDIRECT_URI],
      },
    }),
  );
  return path;
}

test('PKCE uses S256 and the auth URL requests only the two Gmail scopes', () => {
  const { verifier, challenge, method } = createPkce();
  assert.equal(method, 'S256');
  assert.ok(verifier.length >= 43);
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));

  const url = new URL(buildAuthUrl({ clientId: CONFIG.clientId, state: 'st', challenge }));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.deepEqual(url.searchParams.get('scope').split(' ').sort(), [...SCOPES].sort());
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('login_hint'), OWNER_EMAIL);
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(url.searchParams.get('code_challenge'), challenge);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
});

test('the code verifier is sent to the token endpoint', async () => {
  const { impl, calls } = fakeFetch({
    token: goodToken(),
    profile: { emailAddress: OWNER_EMAIL },
  });
  await completeAuthorization({ config: CONFIG, verifier: 'v-fake', code: 'c-fake' }, impl);
  const body = new URLSearchParams(calls[0].init.body);
  assert.equal(calls[0].url, TOKEN_ENDPOINT);
  assert.equal(body.get('code_verifier'), 'v-fake');
  assert.equal(body.get('redirect_uri'), REDIRECT_URI);
});

test('a non-owner mailbox is rejected', async () => {
  const { impl } = fakeFetch({
    token: goodToken(),
    profile: { emailAddress: 'someone.else@example.com' },
  });
  await assert.rejects(
    completeAuthorization({ config: CONFIG, verifier: 'v', code: 'c' }, impl),
    /not the mentorship mailbox/,
  );
});

test('missing and extra scopes are both rejected', async () => {
  const missing = fakeFetch({
    token: goodToken({ scope: SCOPES[0] }),
    profile: { emailAddress: OWNER_EMAIL },
  });
  await assert.rejects(
    completeAuthorization({ config: CONFIG, verifier: 'v', code: 'c' }, missing.impl),
    /missing a required Gmail scope/,
  );

  const extra = fakeFetch({
    token: goodToken({
      scope: `${SCOPES.join(' ')} https://www.googleapis.com/auth/gmail.modify`,
    }),
    profile: { emailAddress: OWNER_EMAIL },
  });
  await assert.rejects(
    completeAuthorization({ config: CONFIG, verifier: 'v', code: 'c' }, extra.impl),
    /not requested/,
  );

  assert.throws(() => verifyGrantedScopes(''), /missing a required Gmail scope/);
});

test('a response without a refresh token is rejected', async () => {
  const { impl } = fakeFetch({
    token: { access_token: 'fake-access-token', scope: SCOPES.join(' ') },
    profile: { emailAddress: OWNER_EMAIL },
  });
  await assert.rejects(
    completeAuthorization({ config: CONFIG, verifier: 'v', code: 'c' }, impl),
    /refresh token/,
  );
});

test('paths inside the repository are refused', (t) => {
  const inRepo = fileURLToPath(import.meta.url);
  assert.throws(() => loadClientConfig(inRepo), /outside the repository/);
  assert.throws(
    () => resolveOutsideRepo(join(REPO_ROOT, 'runtime', 'creds.json'), { mustExist: false }),
    /outside the repository/,
  );
  const dir = tempDir(t);
  assert.ok(resolveOutsideRepo(join(dir, 'creds.json'), { mustExist: false }));
});

test('client files must declare a web client with the exact callback', (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'client.json');

  writeFileSync(path, JSON.stringify({ installed: {} }));
  assert.throws(() => loadClientConfig(path), /"web" client/);

  rmSync(path);
  writeFileSync(
    path,
    JSON.stringify({
      web: {
        client_id: CONFIG.clientId,
        client_secret: CONFIG.clientSecret,
        redirect_uris: ['http://localhost:8765/oauth2callback'],
      },
    }),
  );
  assert.throws(() => loadClientConfig(path), /exact redirect/);

  rmSync(path);
  writeFileSync(
    path,
    JSON.stringify({
      web: { ...{ client_id: CONFIG.clientId, client_secret: CONFIG.clientSecret }, redirect_uris: [REDIRECT_URI] },
    }),
  );
  assert.deepEqual(loadClientConfig(path), CONFIG);
});

test('an existing output file is never overwritten', (t) => {
  const dir = tempDir(t);
  const out = join(dir, 'creds.json');
  writeFileSync(out, '{}');
  assert.throws(() => writeCredentials(out, { a: 1 }), /already exists/);
  assert.equal(readFileSync(out, 'utf8'), '{}');
});

test('a verified owner authorization saves only the three keys at 0600', async (t) => {
  const dir = tempDir(t);
  const out = join(dir, 'creds.json');
  const { impl } = fakeFetch({
    token: goodToken(),
    profile: { emailAddress: OWNER_EMAIL },
  });

  const credentials = await completeAuthorization(
    { config: CONFIG, verifier: 'v', code: 'c' },
    impl,
  );
  assert.deepEqual(Object.keys(credentials).sort(), [
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REFRESH_TOKEN',
  ]);
  assert.equal(credentials.GOOGLE_REFRESH_TOKEN, '1//fake-refresh-token');

  writeCredentials(out, credentials);
  assert.equal(statSync(out).mode & 0o777, 0o600);
  const saved = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(saved, credentials);
  assert.ok(!('access_token' in saved));
});

test('credentials are persisted before the browser is told the flow succeeded', async () => {
  const { impl } = fakeFetch({
    token: goodToken(),
    profile: { emailAddress: OWNER_EMAIL },
  });
  const session = newSession();
  const res = fakeRes();
  let savedBeforeResponse = null;
  let saved = null;
  const done = new Promise((resolveDone) => {
    const handle = createRequestHandler({
      config: CONFIG,
      session,
      fetchImpl: impl,
      saveCredentials: async (credentials) => {
        savedBeforeResponse = !res.ended;
        saved = credentials;
      },
      onDone: (err, credentials) => resolveDone({ err, credentials }),
    });
    handle(fakeReq(callbackUrl(session.state, 'code-1')), res);
  });

  const { err, credentials } = await done;
  assert.equal(err, null);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes('Authorization complete'));
  assert.equal(savedBeforeResponse, true);
  assert.equal(saved.GOOGLE_REFRESH_TOKEN, '1//fake-refresh-token');
  assert.equal(credentials.GOOGLE_REFRESH_TOKEN, '1//fake-refresh-token');
});

test('a failed save shows the failure page, never success', async () => {
  const { impl, calls } = fakeFetch({
    token: goodToken(),
    profile: { emailAddress: OWNER_EMAIL },
  });
  const session = newSession();
  const res = fakeRes();
  const done = new Promise((resolveDone) => {
    const handle = createRequestHandler({
      config: CONFIG,
      session,
      fetchImpl: impl,
      saveCredentials: () => {
        throw new Error('EACCES writing 1//fake-refresh-token to /tmp/creds.json');
      },
      onDone: (err, credentials) => resolveDone({ err, credentials }),
    });
    handle(fakeReq(callbackUrl(session.state, 'code-1')), res);
  });

  const { err, credentials } = await done;
  assert.equal(calls.length, 2);
  assert.equal(res.statusCode, 500);
  assert.ok(res.body.includes('Authorization failed'));
  assert.ok(!res.body.includes('Authorization complete'));
  assert.equal(credentials, undefined);
  assert.ok(err instanceof Error);
  assertNoSecret(err.message);
  assertNoSecret(res.body);
});

test('a raw thrown provider error never reaches the browser or the caller', async () => {
  const session = newSession();
  const res = fakeRes();
  const impl = async () => {
    throw new Error('Unexpected token in JSON: {"refresh_token":"1//fake-refresh-token"}');
  };
  const done = new Promise((resolveDone) => {
    const handle = createRequestHandler({
      config: CONFIG,
      session,
      fetchImpl: impl,
      saveCredentials: () => {
        throw new Error('must not be called');
      },
      onDone: (err) => resolveDone(err),
    });
    handle(fakeReq(callbackUrl(session.state, 'code-1')), res);
  });

  const err = await done;
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.includes('Authorization failed'));
  assertNoSecret(res.body);
  assertNoSecret(err.message);
  assert.ok(!err.message.includes('JSON'));
});

test('an invalid state and a duplicate callback make no provider calls', () => {
  const { impl, calls } = fakeFetch({
    token: goodToken(),
    profile: { emailAddress: OWNER_EMAIL },
  });
  const session = newSession();
  const seen = [];
  const handle = createRequestHandler({
    config: CONFIG,
    session,
    fetchImpl: impl,
    saveCredentials: () => {
      throw new Error('must not be called');
    },
    onDone: (err) => seen.push(err),
  });

  const mismatched = fakeRes();
  handle(fakeReq(callbackUrl('not-the-real-state', 'code-1')), mismatched);
  assert.equal(mismatched.statusCode, 400);
  assert.equal(session.claimed, true);

  // The one-shot claim rejects a replay of the genuine callback.
  const replay = fakeRes();
  handle(fakeReq(callbackUrl(session.state, 'code-1')), replay);
  assert.equal(replay.statusCode, 409);

  assert.equal(calls.length, 0);
  assert.equal(seen.length, 1);
  assert.ok(!seen[0].message.includes(session.state));
});

test('the CLI prints one generic failure and writes nothing on a flow error', async (t) => {
  const dir = tempDir(t);
  const client = writeClientFile(dir);
  const out = join(dir, 'creds.json');
  const errors = [];
  const logs = [];

  const code = await main([client, out], {
    log: (m) => logs.push(m),
    error: (m) => errors.push(m),
    runFlow: async () => {
      throw new Error(`token exchange body: super-secret 1//fake-refresh-token`);
    },
  });

  assert.equal(code, 1);
  assert.deepEqual(errors, [CLI_FAILURE_MESSAGE]);
  assertNoSecret(errors.join('\n'));
  assertNoSecret(logs.join('\n'));
  assert.equal(existsSync(out), false);
});

test('the CLI reports a bad client file generically', async (t) => {
  const dir = tempDir(t);
  const missing = join(dir, 'absent-client.json');
  const out = join(dir, 'creds.json');
  const errors = [];

  const code = await main([missing, out], {
    log: () => {},
    error: (m) => errors.push(m),
    runFlow: async () => {
      throw new Error('must not be called');
    },
  });

  assert.equal(code, 1);
  assert.deepEqual(errors, [CLI_FAILURE_MESSAGE]);
  assert.equal(existsSync(out), false);
});

test('main saves through the flow hook outside the repo at 0600', async (t) => {
  const dir = tempDir(t);
  const client = writeClientFile(dir);
  const out = join(dir, 'creds.json');
  const errors = [];
  const credentials = {
    GOOGLE_CLIENT_ID: CONFIG.clientId,
    GOOGLE_CLIENT_SECRET: CONFIG.clientSecret,
    GOOGLE_REFRESH_TOKEN: '1//fake-refresh-token',
  };
  let savedDuringFlow = false;

  const code = await main([client, out], {
    log: () => {},
    error: (m) => errors.push(m),
    runFlow: async ({ saveCredentials }) => {
      await saveCredentials(credentials);
      savedDuringFlow = existsSync(out);
      return credentials;
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  assert.equal(savedDuringFlow, true);
  assert.equal(statSync(out).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), credentials);
  assert.equal(REPO_ROOT.startsWith(dir), false);
});
