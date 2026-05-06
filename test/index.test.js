'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  readInput, requireEnv, resolveTargets, validateEntry, resolveTimeoutMinutes,
  fetchOidcToken, parseJwtExpiry, buildPayload, postDeployment, fetchDeploymentStatus, pollDeploymentStatus,
  writeStepSummary, formatTarget, main,
} = require('../src/index.js');

const TOKEN = 'test-oidc-token-value-xyz';
const CHART = 'oci://ghcr.io/example/myapp';
const VERSION = '1.2.3';
const TARGET_A = { kind: 'management', tenant: 'ci' };
const TARGET_B = { kind: 'management', tenant: 'nav' };
const TARGETS_JSON = JSON.stringify([
  { target: TARGET_A, wait: true },
  { target: TARGET_B, wait: false },
]);
const TARGETS_NO_WAIT_JSON = JSON.stringify([
  { target: TARGET_A, wait: false },
  { target: TARGET_B, wait: false },
]);
const OWNER = 'nais';
const REPO_FULL = 'nais/fasit-deploy';
const SHA = 'abc123def456';
const DEPLOYMENT_ID_A = '11111111-1111-4111-8111-111111111111';
const DEPLOYMENT_ID_B = '22222222-2222-4222-8222-222222222222';

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function spawnScript(env) {
  return new Promise((resolve) => {
    const script = path.join(__dirname, '..', 'src', 'index.js');
    const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('readInput', async (t) => {
  await t.test('reads INPUT_FOO for name "foo"', () => {
    process.env['INPUT_FOO'] = 'bar';
    assert.equal(readInput('foo'), 'bar');
    delete process.env['INPUT_FOO'];
  });
  await t.test('preserves hyphens: INPUT_TARGETS-FILE for "targets-file"', () => {
    process.env['INPUT_TARGETS-FILE'] = '/tmp/x.json';
    assert.equal(readInput('targets-file'), '/tmp/x.json');
    delete process.env['INPUT_TARGETS-FILE'];
  });
  await t.test('returns empty string when unset', () => {
    delete process.env['INPUT_MISSING_XYZ'];
    assert.equal(readInput('missing_xyz'), '');
  });
});

test('requireEnv', async (t) => {
  await t.test('returns value when set', () => {
    process.env['TEST_REQ_ENV_XYZ'] = 'hello';
    assert.equal(requireEnv('TEST_REQ_ENV_XYZ'), 'hello');
    delete process.env['TEST_REQ_ENV_XYZ'];
  });
  await t.test('throws with var name in message when unset', () => {
    delete process.env['TEST_MISSING_ENV_XYZ'];
    assert.throws(() => requireEnv('TEST_MISSING_ENV_XYZ'), (err) => {
      assert.ok(err.message.includes('TEST_MISSING_ENV_XYZ'));
      return true;
    });
  });
});

test('validateEntry', async (t) => {
  await t.test('accepts valid entry', () => {
    assert.doesNotThrow(() => validateEntry({ target: { k: 'v' }, wait: true }, 0, 'src'));
    assert.doesNotThrow(() => validateEntry({ target: {}, wait: false }, 0, 'src'));
  });
  await t.test('defaults wait to false when omitted', () => {
    const entry = { target: { k: 'v' } };
    assert.doesNotThrow(() => validateEntry(entry, 0, 'src'));
    assert.strictEqual(entry.wait, false);
  });
  await t.test('rejects non-object entry', () => {
    for (const v of [null, [], 'x', 42]) {
      assert.throws(() => validateEntry(v, 0, 'src'), /target/);
    }
  });
  await t.test('rejects bad target', () => {
    assert.throws(() => validateEntry({ target: null, wait: true }, 1, 'src'), /target/);
    assert.throws(() => validateEntry({ target: [], wait: true }, 1, 'src'), /target/);
    assert.throws(() => validateEntry({ target: 'x', wait: true }, 1, 'src'), /target/);
  });
  await t.test('rejects non-boolean wait when set', () => {
    assert.throws(() => validateEntry({ target: {}, wait: 'true' }, 2, 'src'), /wait/);
    assert.throws(() => validateEntry({ target: {}, wait: 1 }, 2, 'src'), /wait/);
    assert.throws(() => validateEntry({ target: {}, wait: null }, 2, 'src'), /wait/);
  });
});

test('resolveTargets', async (t) => {
  await t.test('parses inline JSON', () => {
    const result = resolveTargets(TARGETS_JSON, '');
    assert.deepEqual(result, JSON.parse(TARGETS_JSON));
  });

  await t.test('reads from file', () => {
    const tmp = path.join(os.tmpdir(), `targets-${Date.now()}.json`);
    fs.writeFileSync(tmp, TARGETS_JSON);
    try {
      const result = resolveTargets('', tmp);
      assert.deepEqual(result, JSON.parse(TARGETS_JSON));
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  await t.test('throws when both set', () => {
    assert.throws(() => resolveTargets(TARGETS_JSON, '/some/path'), /mutually exclusive/);
  });

  await t.test('throws when neither set', () => {
    assert.throws(() => resolveTargets('', ''), /required/);
    assert.throws(() => resolveTargets('   ', '  '), /required/);
  });

  await t.test('throws on invalid JSON', () => {
    assert.throws(() => resolveTargets('not-json', ''), /not valid JSON/);
  });

  await t.test('throws on non-array', () => {
    assert.throws(() => resolveTargets('{}', ''), /JSON array/);
    assert.throws(() => resolveTargets('null', ''), /JSON array/);
    assert.throws(() => resolveTargets('"x"', ''), /JSON array/);
  });

  await t.test('throws on empty array', () => {
    assert.throws(() => resolveTargets('[]', ''), /at least one entry/);
  });

  await t.test('throws when file does not exist', () => {
    assert.throws(() => resolveTargets('', '/nonexistent/path/xyz.json'), /Failed to read targets-file/);
  });

  await t.test('error includes index for bad entry', () => {
    const bad = JSON.stringify([{ target: TARGET_A, wait: true }, { target: 'oops', wait: true }]);
    assert.throws(() => resolveTargets(bad, ''), /\[1\]\.target/);
  });
});

test('formatTarget', () => {
  assert.equal(formatTarget({}), '{}');
  assert.equal(formatTarget({ kind: 'management', tenant: 'nav' }), '{kind: management, tenant: nav}');
  assert.equal(formatTarget({ b: 2, a: 1 }), '{a: 1, b: 2}');
});

test('buildPayload', () => {
  const result = buildPayload({ chart: CHART, version: VERSION, target: TARGET_A, owner: OWNER, repo: 'fasit-deploy', sha: SHA });
  assert.deepEqual(result, {
    target: TARGET_A,
    chart: CHART,
    version: VERSION,
    ref: { owner: OWNER, repo: 'fasit-deploy', ref: SHA },
  });
});

test('buildPayload omits ci field', () => {
  const result = buildPayload({ chart: CHART, version: VERSION, target: TARGET_A, owner: OWNER, repo: 'fasit-deploy', sha: SHA });
  assert.equal(result.ci, undefined);
});

test('resolveTimeoutMinutes', async (t) => {
  await t.test('defaults to 10 when empty', () => {
    assert.equal(resolveTimeoutMinutes(''), 10);
    assert.equal(resolveTimeoutMinutes('   '), 10);
  });
  await t.test('parses positive numbers', () => {
    assert.equal(resolveTimeoutMinutes('1'), 1);
    assert.equal(resolveTimeoutMinutes('30'), 30);
    assert.equal(resolveTimeoutMinutes('0.5'), 0.5);
  });
  await t.test('rejects non-numeric', () => {
    assert.throws(() => resolveTimeoutMinutes('abc'), /positive number/);
  });
  await t.test('rejects zero and negative', () => {
    assert.throws(() => resolveTimeoutMinutes('0'), /positive number/);
    assert.throws(() => resolveTimeoutMinutes('-5'), /positive number/);
  });
});

test('fetchOidcToken', async (t) => {
  await t.test('returns token on success and checks auth header', async () => {
    let receivedAuth;
    const server = await startServer((req, res) => {
      receivedAuth = req.headers['authorization'];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ value: TOKEN }));
    });
    t.after(() => new Promise((r) => server.close(r)));
    const port = server.address().port;
    const result = await fetchOidcToken(`http://127.0.0.1:${port}`, 'test-request-token');
    assert.equal(result, TOKEN);
    assert.equal(receivedAuth, 'bearer test-request-token');
  });

  await t.test('throws on 401 without leaking request token', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(401);
      res.end('Unauthorized');
    });
    t.after(() => new Promise((r) => server.close(r)));
    const port = server.address().port;
    await assert.rejects(
      () => fetchOidcToken(`http://127.0.0.1:${port}`, 'secret-request-token'),
      (err) => {
        assert.ok(err.message.includes('401'));
        assert.ok(!err.message.includes('secret-request-token'));
        return true;
      }
    );
  });

  await t.test('throws when value is null', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ value: null }));
    });
    t.after(() => new Promise((r) => server.close(r)));
    const port = server.address().port;
    await assert.rejects(() => fetchOidcToken(`http://127.0.0.1:${port}`, 'tok'));
  });
});

test('parseJwtExpiry', async (t) => {
  const makeJwt = (payload) => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${header}.${body}.signature`;
  };

  await t.test('returns exp in milliseconds', () => {
    const jwt = makeJwt({ exp: 1700000000, sub: 'test' });
    assert.equal(parseJwtExpiry(jwt), 1700000000 * 1000);
  });

  await t.test('returns null when token is not a JWT', () => {
    assert.equal(parseJwtExpiry('not-a-jwt'), null);
    assert.equal(parseJwtExpiry('one.two'), null);
    assert.equal(parseJwtExpiry(''), null);
  });

  await t.test('returns null when payload is not valid JSON', () => {
    const jwt = `header.${Buffer.from('garbage').toString('base64url')}.sig`;
    assert.equal(parseJwtExpiry(jwt), null);
  });

  await t.test('returns null when exp is missing or non-numeric', () => {
    assert.equal(parseJwtExpiry(makeJwt({ sub: 'test' })), null);
    assert.equal(parseJwtExpiry(makeJwt({ exp: 'soon' })), null);
  });
});

test('postDeployment', async (t) => {
  await t.test('sends correct headers and body, returns id from response', async () => {
    let capturedHeaders, capturedBody;
    const server = await startServer((req, res) => {
      capturedHeaders = req.headers;
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        capturedBody = body;
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: DEPLOYMENT_ID_A }));
      });
    });
    t.after(() => new Promise((r) => server.close(r)));
    const port = server.address().port;
    const payload = buildPayload({ chart: CHART, version: VERSION, target: TARGET_A, owner: OWNER, repo: 'fasit-deploy', sha: SHA });
    const id = await postDeployment(`http://127.0.0.1:${port}`, TOKEN, payload);
    assert.equal(id, DEPLOYMENT_ID_A);
    assert.equal(capturedHeaders['authorization'], `Bearer ${TOKEN}`);
    assert.ok(capturedHeaders['content-type'].includes('application/json'));
    assert.deepEqual(JSON.parse(capturedBody), payload);
  });

  await t.test('throws on 500 with status and body but not token', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(500);
      res.end('upstream broken');
    });
    t.after(() => new Promise((r) => server.close(r)));
    const port = server.address().port;
    await assert.rejects(
      () => postDeployment(`http://127.0.0.1:${port}`, TOKEN, {}),
      (err) => {
        assert.ok(err.message.includes('500'));
        assert.ok(err.message.includes('upstream broken'));
        assert.ok(!err.message.includes(TOKEN));
        return true;
      }
    );
  });

  await t.test('throws when response has no id', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ foo: 'bar' }));
    });
    t.after(() => new Promise((r) => server.close(r)));
    const port = server.address().port;
    await assert.rejects(
      () => postDeployment(`http://127.0.0.1:${port}`, TOKEN, {}),
      /id/
    );
  });
});

test('fetchDeploymentStatus', async (t) => {
  await t.test('returns parsed status for given id', async () => {
    let capturedPath;
    const server = await startServer((req, res) => {
      capturedPath = req.url;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ state: 'PENDING' }));
    });
    t.after(() => new Promise((r) => server.close(r)));
    const port = server.address().port;
    const status = await fetchDeploymentStatus(`http://127.0.0.1:${port}`, TOKEN, DEPLOYMENT_ID_A);
    assert.equal(status.state, 'PENDING');
    assert.equal(capturedPath, `/github/deployment/${DEPLOYMENT_ID_A}`);
  });

  await t.test('throws on 404', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(404);
      res.end('not found');
    });
    t.after(() => new Promise((r) => server.close(r)));
    const port = server.address().port;
    await assert.rejects(
      () => fetchDeploymentStatus(`http://127.0.0.1:${port}`, TOKEN, DEPLOYMENT_ID_A),
      /404/
    );
  });

  await t.test('throws when response has no state', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({}));
    });
    t.after(() => new Promise((r) => server.close(r)));
    const port = server.address().port;
    await assert.rejects(
      () => fetchDeploymentStatus(`http://127.0.0.1:${port}`, TOKEN, DEPLOYMENT_ID_A),
      /state/
    );
  });

  await t.test('throws with unauthorized flag on 401', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(401);
      res.end('oidc: token is expired');
    });
    t.after(() => new Promise((r) => server.close(r)));
    const port = server.address().port;
    await assert.rejects(
      () => fetchDeploymentStatus(`http://127.0.0.1:${port}`, TOKEN, DEPLOYMENT_ID_A),
      (err) => err.unauthorized === true && /401/.test(err.message)
    );
  });
});

test('pollDeploymentStatus', async (t) => {
  await t.test('resolves on DEPLOYED', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ state: 'DEPLOYED' }));
    });
    t.after(() => new Promise((r) => server.close(r)));
    const port = server.address().port;
    const result = await pollDeploymentStatus(`http://127.0.0.1:${port}`, async () => TOKEN, DEPLOYMENT_ID_A, { timeoutMs: 5_000, intervalMs: 1 });
    assert.equal(result.state, 'DEPLOYED');
  });

  await t.test('resolves on DISABLED', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ state: 'DISABLED' }));
    });
    t.after(() => new Promise((r) => server.close(r)));
    const port = server.address().port;
    const result = await pollDeploymentStatus(`http://127.0.0.1:${port}`, async () => TOKEN, DEPLOYMENT_ID_A, { timeoutMs: 5_000, intervalMs: 1 });
    assert.equal(result.state, 'DISABLED');
  });

  await t.test('rejects on FAILED', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ state: 'FAILED' }));
    });
    t.after(() => new Promise((r) => server.close(r)));
    const port = server.address().port;
    await assert.rejects(
      () => pollDeploymentStatus(`http://127.0.0.1:${port}`, async () => TOKEN, DEPLOYMENT_ID_A, { timeoutMs: 5_000, intervalMs: 1 }),
      /failed.*FAILED/
    );
  });

  await t.test('keeps polling through PENDING then DEPLOYED', async () => {
    const sequence = ['PENDING', 'PENDING', 'DEPLOYED'];
    let i = 0;
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ state: sequence[Math.min(i++, sequence.length - 1)] }));
    });
    t.after(() => new Promise((r) => server.close(r)));
    const port = server.address().port;
    const result = await pollDeploymentStatus(`http://127.0.0.1:${port}`, async () => TOKEN, DEPLOYMENT_ID_A, { timeoutMs: 5_000, intervalMs: 1 });
    assert.equal(result.state, 'DEPLOYED');
    assert.ok(i >= 3, `expected at least 3 polls, got ${i}`);
  });

  await t.test('times out when never reaching terminal state', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ state: 'PENDING' }));
    });
    t.after(() => new Promise((r) => server.close(r)));
    const port = server.address().port;
    await assert.rejects(
      () => pollDeploymentStatus(`http://127.0.0.1:${port}`, async () => TOKEN, DEPLOYMENT_ID_A, { timeoutMs: 50, intervalMs: 30 }),
      /Timed out.*PENDING/
    );
  });

  await t.test('refreshes token on 401 and continues polling', async () => {
    const tokens = ['stale-token', 'fresh-token'];
    let tokenIdx = 0;
    let getTokenCalls = 0;
    const getToken = async ({ refresh = false } = {}) => {
      getTokenCalls++;
      if (refresh) tokenIdx++;
      return tokens[Math.min(tokenIdx, tokens.length - 1)];
    };
    const server = await startServer((req, res) => {
      const auth = req.headers['authorization'] || '';
      if (auth === 'Bearer stale-token') {
        res.writeHead(401);
        res.end('oidc: token is expired');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ state: 'DEPLOYED' }));
    });
    t.after(() => new Promise((r) => server.close(r)));
    const port = server.address().port;
    const result = await pollDeploymentStatus(`http://127.0.0.1:${port}`, getToken, DEPLOYMENT_ID_A, { timeoutMs: 5_000, intervalMs: 1 });
    assert.equal(result.state, 'DEPLOYED');
    assert.equal(getTokenCalls, 2, 'expected initial fetch + one refresh');
  });
});

test('writeStepSummary', async (t) => {
  await t.test('appends to file when GITHUB_STEP_SUMMARY is set', () => {
    const tmpFile = path.join(os.tmpdir(), `test-summary-${Date.now()}.txt`);
    process.env.GITHUB_STEP_SUMMARY = tmpFile;
    writeStepSummary('hello\n');
    assert.equal(fs.readFileSync(tmpFile, 'utf8'), 'hello\n');
    delete process.env.GITHUB_STEP_SUMMARY;
    fs.unlinkSync(tmpFile);
  });
  await t.test('no-op when GITHUB_STEP_SUMMARY is unset', () => {
    delete process.env.GITHUB_STEP_SUMMARY;
    assert.doesNotThrow(() => writeStepSummary('hello\n'));
  });
});

function mockFasitHandler({ postState = 'DEPLOYED', postStatesById, capturedPosts, capturedPaths } = {}) {
  let postCounter = 0;
  return (req, res) => {
    if (capturedPaths) capturedPaths.push(`${req.method} ${req.url}`);
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const id = postCounter === 0 ? DEPLOYMENT_ID_A : DEPLOYMENT_ID_B;
        postCounter++;
        if (capturedPosts) capturedPosts.push({ id, payload: JSON.parse(body) });
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id }));
      });
      return;
    }
    if (req.method === 'GET') {
      const idMatch = req.url.match(/\/github\/deployment\/([^/?]+)/);
      const id = idMatch ? idMatch[1] : '';
      const state = (postStatesById && postStatesById[id]) || postState;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, state }));
      return;
    }
    res.writeHead(405);
    res.end();
  };
}

test('main() happy path posts once per target (no wait)', async (t) => {
  let oidcServer, fasitServer;
  const capturedPosts = [];
  const tmpSummary = path.join(os.tmpdir(), `summary-${Date.now()}.txt`);
  const savedEnv = {};
  const envKeys = ['INPUT_ENDPOINT', 'INPUT_CHART', 'INPUT_VERSION', 'INPUT_TARGETS', 'INPUT_TARGETS-FILE', 'GITHUB_REPOSITORY', 'GITHUB_REPOSITORY_OWNER', 'GITHUB_SHA', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'GITHUB_STEP_SUMMARY'];

  t.after(async () => {
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    process.exitCode = undefined;
    if (fs.existsSync(tmpSummary)) fs.unlinkSync(tmpSummary);
    await new Promise((r) => oidcServer.close(r));
    await new Promise((r) => fasitServer.close(r));
  });

  oidcServer = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ value: TOKEN }));
  });
  fasitServer = await startServer(mockFasitHandler({ capturedPosts }));

  for (const k of envKeys) savedEnv[k] = process.env[k];

  process.env['INPUT_ENDPOINT'] = `http://127.0.0.1:${fasitServer.address().port}`;
  process.env['INPUT_CHART'] = CHART;
  process.env['INPUT_VERSION'] = VERSION;
  process.env['INPUT_TARGETS'] = TARGETS_NO_WAIT_JSON;
  delete process.env['INPUT_TARGETS-FILE'];
  process.env['GITHUB_REPOSITORY'] = REPO_FULL;
  process.env['GITHUB_REPOSITORY_OWNER'] = OWNER;
  process.env['GITHUB_SHA'] = SHA;
  process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'] = 'test-request-token';
  process.env['ACTIONS_ID_TOKEN_REQUEST_URL'] = `http://127.0.0.1:${oidcServer.address().port}`;
  process.env['GITHUB_STEP_SUMMARY'] = tmpSummary;

  const logged = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args) => logged.push(args.join(' '));
  console.error = (...args) => logged.push(args.join(' '));

  await main({ pollIntervalMs: 1 });

  console.log = origLog;
  console.error = origErr;

  assert.ok(!process.exitCode, `exitCode should be 0/undefined, got ${process.exitCode}`);

  assert.equal(capturedPosts.length, 2, 'should POST once per target');
  const expectedPayloadA = buildPayload({ chart: CHART, version: VERSION, target: TARGET_A, owner: OWNER, repo: 'fasit-deploy', sha: SHA });
  const expectedPayloadB = buildPayload({ chart: CHART, version: VERSION, target: TARGET_B, owner: OWNER, repo: 'fasit-deploy', sha: SHA });
  assert.deepEqual(capturedPosts[0].payload, expectedPayloadA);
  assert.deepEqual(capturedPosts[1].payload, expectedPayloadB);
  assert.equal(capturedPosts[0].payload.ci, undefined, 'payload must not contain ci');

  for (const entry of logged) {
    assert.ok(!entry.includes(TOKEN), `Token leaked in log: ${entry}`);
  }

  const summary = fs.readFileSync(tmpSummary, 'utf8');
  assert.ok(summary.includes('### Deployment created!'));
  assert.ok(summary.includes('kind: management'));
  assert.ok(summary.includes('tenant: ci'));
  assert.ok(summary.includes('tenant: nav'));
  assert.ok(summary.includes('fasit.nais.io/deployments'));
  assert.ok(summary.includes(`https://fasit.nais.io/deployments/${DEPLOYMENT_ID_A}`), 'summary should link to fasit deployment page per deployment');
});

test('main() polls when wait=true and resolves on DEPLOYED', async (t) => {
  let oidcServer, fasitServer;
  const capturedPosts = [];
  const capturedPaths = [];
  const savedEnv = {};
  const envKeys = ['INPUT_ENDPOINT', 'INPUT_CHART', 'INPUT_VERSION', 'INPUT_TARGETS', 'INPUT_TARGETS-FILE', 'GITHUB_REPOSITORY', 'GITHUB_REPOSITORY_OWNER', 'GITHUB_SHA', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL'];

  t.after(async () => {
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    process.exitCode = undefined;
    await new Promise((r) => oidcServer.close(r));
    await new Promise((r) => fasitServer.close(r));
  });

  oidcServer = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ value: TOKEN }));
  });
  fasitServer = await startServer(mockFasitHandler({ capturedPosts, capturedPaths, postState: 'DEPLOYED' }));

  for (const k of envKeys) savedEnv[k] = process.env[k];

  process.env['INPUT_ENDPOINT'] = `http://127.0.0.1:${fasitServer.address().port}`;
  process.env['INPUT_CHART'] = CHART;
  process.env['INPUT_VERSION'] = VERSION;
  process.env['INPUT_TARGETS'] = TARGETS_JSON;
  delete process.env['INPUT_TARGETS-FILE'];
  process.env['GITHUB_REPOSITORY'] = REPO_FULL;
  process.env['GITHUB_REPOSITORY_OWNER'] = OWNER;
  process.env['GITHUB_SHA'] = SHA;
  process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'] = 'test-request-token';
  process.env['ACTIONS_ID_TOKEN_REQUEST_URL'] = `http://127.0.0.1:${oidcServer.address().port}`;

  const origLog = console.log;
  console.log = () => {};
  await main({ pollIntervalMs: 1 });
  console.log = origLog;

  assert.ok(!process.exitCode, `exitCode should be 0, got ${process.exitCode}`);
  assert.equal(capturedPosts.length, 2);
  const getCalls = capturedPaths.filter((p) => p.startsWith('GET '));
  assert.ok(getCalls.length >= 1, 'should have polled at least once for the wait=true target');
  assert.ok(getCalls.some((p) => p.includes(DEPLOYMENT_ID_A)), 'should have polled the wait=true deployment id');
  assert.ok(!getCalls.some((p) => p.includes(DEPLOYMENT_ID_B)), 'should NOT poll the wait=false target');
});

test('main() exits non-zero when polling sees FAILED', async (t) => {
  let oidcServer, fasitServer;
  const capturedPosts = [];
  const tmpSummary = path.join(os.tmpdir(), `summary-fail-${Date.now()}.txt`);
  const savedEnv = {};
  const envKeys = ['INPUT_ENDPOINT', 'INPUT_CHART', 'INPUT_VERSION', 'INPUT_TARGETS', 'INPUT_TARGETS-FILE', 'GITHUB_REPOSITORY', 'GITHUB_REPOSITORY_OWNER', 'GITHUB_SHA', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'GITHUB_STEP_SUMMARY'];

  t.after(async () => {
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    process.exitCode = undefined;
    if (fs.existsSync(tmpSummary)) fs.unlinkSync(tmpSummary);
    await new Promise((r) => oidcServer.close(r));
    await new Promise((r) => fasitServer.close(r));
  });

  oidcServer = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ value: TOKEN }));
  });
  fasitServer = await startServer(mockFasitHandler({ capturedPosts, postState: 'FAILED' }));

  for (const k of envKeys) savedEnv[k] = process.env[k];

  process.env['INPUT_ENDPOINT'] = `http://127.0.0.1:${fasitServer.address().port}`;
  process.env['INPUT_CHART'] = CHART;
  process.env['INPUT_VERSION'] = VERSION;
  process.env['INPUT_TARGETS'] = JSON.stringify([{ target: TARGET_A, wait: true }, { target: TARGET_B, wait: true }]);
  delete process.env['INPUT_TARGETS-FILE'];
  process.env['GITHUB_REPOSITORY'] = REPO_FULL;
  process.env['GITHUB_REPOSITORY_OWNER'] = OWNER;
  process.env['GITHUB_SHA'] = SHA;
  process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'] = 'test-request-token';
  process.env['ACTIONS_ID_TOKEN_REQUEST_URL'] = `http://127.0.0.1:${oidcServer.address().port}`;
  process.env['GITHUB_STEP_SUMMARY'] = tmpSummary;

  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  await main({ pollIntervalMs: 1 });
  console.log = origLog;
  console.error = origErr;

  assert.equal(process.exitCode, 1);
  assert.equal(capturedPosts.length, 1, 'should abort after first failed poll, not POST second target');

  const summary = fs.readFileSync(tmpSummary, 'utf8');
  assert.ok(summary.includes('**Failed:**'), 'summary should mark failure');
  assert.ok(summary.includes(`https://fasit.nais.io/deployments/${DEPLOYMENT_ID_A}`), 'summary should link to fasit deployment page on failure');
});

test('main() reads targets-file', async (t) => {
  let oidcServer, fasitServer;
  const capturedPosts = [];
  const tmpFile = path.join(os.tmpdir(), `targets-${Date.now()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify([{ target: TARGET_A, wait: false }]));

  const savedEnv = {};
  const envKeys = ['INPUT_ENDPOINT', 'INPUT_CHART', 'INPUT_VERSION', 'INPUT_TARGETS', 'INPUT_TARGETS-FILE', 'GITHUB_REPOSITORY', 'GITHUB_REPOSITORY_OWNER', 'GITHUB_SHA', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'GITHUB_STEP_SUMMARY'];

  t.after(async () => {
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    process.exitCode = undefined;
    fs.unlinkSync(tmpFile);
    await new Promise((r) => oidcServer.close(r));
    await new Promise((r) => fasitServer.close(r));
  });

  oidcServer = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ value: TOKEN }));
  });
  fasitServer = await startServer(mockFasitHandler({ capturedPosts }));

  for (const k of envKeys) savedEnv[k] = process.env[k];

  process.env['INPUT_ENDPOINT'] = `http://127.0.0.1:${fasitServer.address().port}`;
  process.env['INPUT_CHART'] = CHART;
  process.env['INPUT_VERSION'] = VERSION;
  delete process.env['INPUT_TARGETS'];
  process.env['INPUT_TARGETS-FILE'] = tmpFile;
  process.env['GITHUB_REPOSITORY'] = REPO_FULL;
  process.env['GITHUB_REPOSITORY_OWNER'] = OWNER;
  process.env['GITHUB_SHA'] = SHA;
  process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'] = 'test-request-token';
  process.env['ACTIONS_ID_TOKEN_REQUEST_URL'] = `http://127.0.0.1:${oidcServer.address().port}`;

  await main({ pollIntervalMs: 1 });

  assert.ok(!process.exitCode);
  assert.equal(capturedPosts.length, 1);
  assert.deepEqual(capturedPosts[0].payload.target, TARGET_A);
});

test('main() aborts on first POST failure', async (t) => {
  let oidcServer, fasitServer;
  let postCount = 0;
  const savedEnv = {};
  const envKeys = ['INPUT_ENDPOINT', 'INPUT_CHART', 'INPUT_VERSION', 'INPUT_TARGETS', 'INPUT_TARGETS-FILE', 'GITHUB_REPOSITORY', 'GITHUB_REPOSITORY_OWNER', 'GITHUB_SHA', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL'];

  t.after(async () => {
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    process.exitCode = undefined;
    await new Promise((r) => oidcServer.close(r));
    await new Promise((r) => fasitServer.close(r));
  });

  oidcServer = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ value: TOKEN }));
  });
  fasitServer = await startServer((req, res) => {
    postCount++;
    res.writeHead(500);
    res.end('boom');
  });

  for (const k of envKeys) savedEnv[k] = process.env[k];

  process.env['INPUT_ENDPOINT'] = `http://127.0.0.1:${fasitServer.address().port}`;
  process.env['INPUT_CHART'] = CHART;
  process.env['INPUT_VERSION'] = VERSION;
  process.env['INPUT_TARGETS'] = TARGETS_NO_WAIT_JSON;
  delete process.env['INPUT_TARGETS-FILE'];
  process.env['GITHUB_REPOSITORY'] = REPO_FULL;
  process.env['GITHUB_REPOSITORY_OWNER'] = OWNER;
  process.env['GITHUB_SHA'] = SHA;
  process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'] = 'test-request-token';
  process.env['ACTIONS_ID_TOKEN_REQUEST_URL'] = `http://127.0.0.1:${oidcServer.address().port}`;

  const origErr = console.error;
  console.error = () => {};
  await main({ pollIntervalMs: 1 });
  console.error = origErr;

  assert.equal(process.exitCode, 1);
  assert.equal(postCount, 1, 'should abort after first failure, not POST again');
});

test('smoke: subprocess happy path', async (t) => {
  let oidcServer, fasitServer;
  const capturedPosts = [];

  t.after(async () => {
    await new Promise((r) => oidcServer.close(r));
    await new Promise((r) => fasitServer.close(r));
  });

  oidcServer = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ value: TOKEN }));
  });
  fasitServer = await startServer(mockFasitHandler({ capturedPosts }));

  const { code, stdout, stderr } = await spawnScript({
    INPUT_ENDPOINT: `http://127.0.0.1:${fasitServer.address().port}`,
    INPUT_CHART: CHART,
    INPUT_VERSION: VERSION,
    INPUT_TARGETS: TARGETS_NO_WAIT_JSON,
    GITHUB_REPOSITORY: REPO_FULL,
    GITHUB_REPOSITORY_OWNER: OWNER,
    GITHUB_SHA: SHA,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-request-token',
    ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${oidcServer.address().port}`,
  });

  const evidenceDir = path.join(__dirname, '..', '.sisyphus', 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'task-2-smoke-stdout.log'), stdout);
  fs.writeFileSync(path.join(evidenceDir, 'task-2-smoke-stderr.log'), stderr);

  assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${stderr}`);
  assert.ok(!stdout.includes(TOKEN), 'Token leaked in stdout');
  assert.ok(!stderr.includes(TOKEN), 'Token leaked in stderr');

  assert.equal(capturedPosts.length, 2);
  assert.deepEqual(capturedPosts[0].payload.target, TARGET_A);
  assert.deepEqual(capturedPosts[1].payload.target, TARGET_B);
});

test('smoke: subprocess failure paths', async (t) => {
  let oidcServer, fasitServer;
  const evidenceDir = path.join(__dirname, '..', '.sisyphus', 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });

  t.after(async () => {
    if (oidcServer) await new Promise((r) => oidcServer.close(r));
    if (fasitServer) await new Promise((r) => fasitServer.close(r));
  });

  oidcServer = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ value: TOKEN }));
  });
  fasitServer = await startServer(mockFasitHandler({}));

  const baseEnv = {
    INPUT_ENDPOINT: `http://127.0.0.1:${fasitServer.address().port}`,
    INPUT_CHART: CHART,
    INPUT_VERSION: VERSION,
    INPUT_TARGETS: TARGETS_NO_WAIT_JSON,
    GITHUB_REPOSITORY: REPO_FULL,
    GITHUB_REPOSITORY_OWNER: OWNER,
    GITHUB_SHA: SHA,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-request-token',
    ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${oidcServer.address().port}`,
  };

  const cases = [
    { name: 'missing OIDC token', env: { ...baseEnv, ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' }, keyword: 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', file: 'task-2-failure-1.log' },
    { name: 'empty chart', env: { ...baseEnv, INPUT_CHART: '' }, keyword: 'chart', file: 'task-2-failure-2.log' },
    { name: 'empty version', env: { ...baseEnv, INPUT_VERSION: '' }, keyword: 'version', file: 'task-2-failure-3.log' },
    { name: 'invalid targets JSON', env: { ...baseEnv, INPUT_TARGETS: 'not-json' }, keyword: 'targets', file: 'task-2-failure-4.log' },
    { name: 'targets is not an array', env: { ...baseEnv, INPUT_TARGETS: '{}' }, keyword: 'array', file: 'task-2-failure-5.log' },
    { name: 'empty targets array', env: { ...baseEnv, INPUT_TARGETS: '[]' }, keyword: 'at least one', file: 'task-2-failure-6.log' },
    { name: 'neither targets nor targets-file', env: { ...baseEnv, INPUT_TARGETS: '' }, keyword: 'targets', file: 'task-2-failure-7.log' },
  ];

  for (const c of cases) {
    await t.test(c.name, async () => {
      const { code, stderr } = await spawnScript(c.env);
      fs.writeFileSync(path.join(evidenceDir, c.file), stderr);
      assert.notEqual(code, 0, `Expected non-zero exit for: ${c.name}`);
      assert.ok(stderr.toLowerCase().includes(c.keyword.toLowerCase()), `Expected "${c.keyword}" in stderr for: ${c.name}. Got: ${stderr}`);
    });
  }

  await t.test('both targets and targets-file set', async () => {
    const env = { ...baseEnv, 'INPUT_TARGETS-FILE': '/some/path.json' };
    const { code, stderr } = await spawnScript(env);
    fs.writeFileSync(path.join(evidenceDir, 'task-2-failure-both.log'), stderr);
    assert.notEqual(code, 0);
    assert.ok(stderr.includes('mutually exclusive'), `Got: ${stderr}`);
  });

  await t.test('fasit returns 500', async () => {
    const failFasit = await startServer((req, res) => { res.writeHead(500); res.end('server error'); });
    t.after(() => new Promise((r) => failFasit.close(r)));
    const env = { ...baseEnv, INPUT_ENDPOINT: `http://127.0.0.1:${failFasit.address().port}` };
    const { code, stderr } = await spawnScript(env);
    fs.writeFileSync(path.join(evidenceDir, 'task-2-failure-fasit500.log'), stderr);
    assert.notEqual(code, 0);
    assert.ok(stderr.includes('500'), `Got: ${stderr}`);
  });

  await t.test('oidc returns 401', async () => {
    const failOidc = await startServer((req, res) => { res.writeHead(401); res.end('unauthorized'); });
    t.after(() => new Promise((r) => failOidc.close(r)));
    const env = { ...baseEnv, ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${failOidc.address().port}` };
    const { code, stderr } = await spawnScript(env);
    fs.writeFileSync(path.join(evidenceDir, 'task-2-failure-oidc401.log'), stderr);
    assert.notEqual(code, 0);
    assert.ok(stderr.includes('401'), `Got: ${stderr}`);
  });
});
