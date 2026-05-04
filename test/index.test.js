'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  readInput, parseBoolean, parseTarget, requireEnv,
  fetchOidcToken, buildPayload, postDeployment, writeStepSummary, main,
} = require('../src/index.js');

const TOKEN = 'test-oidc-token-value-xyz';
const CHART = 'oci://ghcr.io/example/myapp';
const VERSION = '1.2.3';
const TARGET = { kind: 'management', tenant: 'nav' };
const TARGET_STR = '{"kind":"management","tenant":"nav"}';
const OWNER = 'nais';
const REPO_FULL = 'nais/fasit-deploy';
const SHA = 'abc123def456';

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
  await t.test('preserves hyphens: INPUT_MY-INPUT for "my-input"', () => {
    process.env['INPUT_MY-INPUT'] = 'true';
    assert.equal(readInput('my-input'), 'true');
    delete process.env['INPUT_MY-INPUT'];
  });
  await t.test('returns empty string when unset', () => {
    delete process.env['INPUT_MISSING_XYZ'];
    assert.equal(readInput('missing_xyz'), '');
  });
});

test('parseBoolean', async (t) => {
  await t.test('parses "true" variants', () => {
    assert.equal(parseBoolean('true', 'f'), true);
    assert.equal(parseBoolean('TRUE', 'f'), true);
    assert.equal(parseBoolean('True', 'f'), true);
  });
  await t.test('parses "false" variants', () => {
    assert.equal(parseBoolean('false', 'f'), false);
    assert.equal(parseBoolean('FALSE', 'f'), false);
  });
  await t.test('throws on invalid values with fieldName in message', () => {
    for (const v of ['', 'yes', '1', 'foo']) {
      assert.throws(() => parseBoolean(v, 'myfield'), (err) => {
        assert.ok(err.message.includes('myfield'), `message should contain fieldName for value "${v}"`);
        return true;
      });
    }
  });
});

test('parseTarget', async (t) => {
  await t.test('accepts valid objects', () => {
    assert.deepEqual(parseTarget('{}'), {});
    assert.deepEqual(parseTarget('{"k":"v"}'), { k: 'v' });
    assert.deepEqual(parseTarget('  {"a":1}  '), { a: 1 });
  });
  await t.test('throws on invalid inputs with "target" in message', () => {
    for (const v of ['', '   ', 'not-json', '[]', 'null', '"string"', '42']) {
      assert.throws(() => parseTarget(v), (err) => {
        assert.ok(err.message.toLowerCase().includes('target'), `message should contain "target" for input "${v}"`);
        return true;
      });
    }
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

test('buildPayload', () => {
  const result = buildPayload({ chart: CHART, version: VERSION, target: TARGET, wait: true, owner: OWNER, repo: 'fasit-deploy', sha: SHA });
  assert.deepEqual(result, {
    ci: { wait: true },
    target: TARGET,
    chart: CHART,
    version: VERSION,
    ref: { owner: OWNER, repo: 'fasit-deploy', ref: SHA },
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

test('postDeployment', async (t) => {
  await t.test('sends correct headers and body', async () => {
    let capturedHeaders, capturedBody;
    const server = await startServer((req, res) => {
      capturedHeaders = req.headers;
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        capturedBody = body;
        res.writeHead(200);
        res.end('ok');
      });
    });
    t.after(() => new Promise((r) => server.close(r)));
    const port = server.address().port;
    const payload = buildPayload({ chart: CHART, version: VERSION, target: TARGET, wait: true, owner: OWNER, repo: 'fasit-deploy', sha: SHA });
    await postDeployment(`http://127.0.0.1:${port}`, TOKEN, payload);
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

test('main() happy path', async (t) => {
  let oidcServer, fasitServer;
  let capturedFasitBody;
  const tmpSummary = path.join(os.tmpdir(), `summary-${Date.now()}.txt`);
  const savedEnv = {};
  const envKeys = ['INPUT_ENDPOINT', 'INPUT_CHART', 'INPUT_VERSION', 'INPUT_TARGET', 'INPUT_WAIT', 'GITHUB_REPOSITORY', 'GITHUB_REPOSITORY_OWNER', 'GITHUB_SHA', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'GITHUB_STEP_SUMMARY'];

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
  fasitServer = await startServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      capturedFasitBody = body;
      res.writeHead(200);
      res.end('ok');
    });
  });

  for (const k of envKeys) savedEnv[k] = process.env[k];

  process.env['INPUT_ENDPOINT'] = `http://127.0.0.1:${fasitServer.address().port}`;
  process.env['INPUT_CHART'] = CHART;
  process.env['INPUT_VERSION'] = VERSION;
  process.env['INPUT_TARGET'] = TARGET_STR;
  process.env['INPUT_WAIT'] = 'true';
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

  await main();

  console.log = origLog;
  console.error = origErr;

  assert.ok(!process.exitCode, `exitCode should be 0/undefined, got ${process.exitCode}`);

  const expectedPayload = buildPayload({ chart: CHART, version: VERSION, target: TARGET, wait: true, owner: OWNER, repo: 'fasit-deploy', sha: SHA });
  assert.deepEqual(JSON.parse(capturedFasitBody), expectedPayload);

  for (const entry of logged) {
    assert.ok(!entry.includes(TOKEN), `Token leaked in log: ${entry}`);
  }

  const summary = fs.readFileSync(tmpSummary, 'utf8');
  assert.ok(summary.includes('### Deployment created!'));
  assert.ok(summary.includes('fasit.nais.io/deployments'));
});

test('smoke: subprocess happy path', async (t) => {
  let oidcServer, fasitServer;
  let capturedFasitBody;

  t.after(async () => {
    await new Promise((r) => oidcServer.close(r));
    await new Promise((r) => fasitServer.close(r));
  });

  oidcServer = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ value: TOKEN }));
  });
  fasitServer = await startServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      capturedFasitBody = body;
      res.writeHead(200);
      res.end('ok');
    });
  });

  const { code, stdout, stderr } = await spawnScript({
    INPUT_ENDPOINT: `http://127.0.0.1:${fasitServer.address().port}`,
    INPUT_CHART: CHART,
    INPUT_VERSION: VERSION,
    INPUT_TARGET: TARGET_STR,
    INPUT_WAIT: 'true',
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

  const expectedPayload = buildPayload({ chart: CHART, version: VERSION, target: TARGET, wait: true, owner: OWNER, repo: 'fasit-deploy', sha: SHA });
  assert.deepEqual(JSON.parse(capturedFasitBody), expectedPayload);
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
  fasitServer = await startServer((req, res) => {
    res.writeHead(200);
    res.end('ok');
  });

  const baseEnv = {
    INPUT_ENDPOINT: `http://127.0.0.1:${fasitServer.address().port}`,
    INPUT_CHART: CHART,
    INPUT_VERSION: VERSION,
    INPUT_TARGET: TARGET_STR,
    INPUT_WAIT: 'true',
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
    { name: 'invalid target JSON', env: { ...baseEnv, INPUT_TARGET: 'not-json' }, keyword: 'target', file: 'task-2-failure-4.log' },
  ];

  for (const c of cases) {
    await t.test(c.name, async () => {
      const { code, stderr } = await spawnScript(c.env);
      fs.writeFileSync(path.join(evidenceDir, c.file), stderr);
      assert.notEqual(code, 0, `Expected non-zero exit for: ${c.name}`);
      assert.ok(stderr.toLowerCase().includes(c.keyword.toLowerCase()), `Expected "${c.keyword}" in stderr for: ${c.name}. Got: ${stderr}`);
    });
  }

  await t.test('fasit returns 500', async () => {
    const failFasit = await startServer((req, res) => { res.writeHead(500); res.end('server error'); });
    t.after(() => new Promise((r) => failFasit.close(r)));
    const env = { ...baseEnv, INPUT_ENDPOINT: `http://127.0.0.1:${failFasit.address().port}` };
    const { code, stderr } = await spawnScript(env);
    fs.writeFileSync(path.join(evidenceDir, 'task-2-failure-5.log'), stderr);
    assert.notEqual(code, 0);
    assert.ok(stderr.includes('500'), `Expected "500" in stderr. Got: ${stderr}`);
  });

  await t.test('oidc returns 401', async () => {
    const failOidc = await startServer((req, res) => { res.writeHead(401); res.end('unauthorized'); });
    t.after(() => new Promise((r) => failOidc.close(r)));
    const env = { ...baseEnv, ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${failOidc.address().port}` };
    const { code, stderr } = await spawnScript(env);
    fs.writeFileSync(path.join(evidenceDir, 'task-2-failure-6.log'), stderr);
    assert.notEqual(code, 0);
    assert.ok(stderr.includes('401'), `Expected "401" in stderr. Got: ${stderr}`);
  });
});
