'use strict';

const fs = require('node:fs');

const POLL_INTERVAL_MS = 10_000;
const DEFAULT_TIMEOUT_MINUTES = 10;
const TERMINAL_SUCCESS_STATES = new Set(['DEPLOYED', 'DISABLED']);
const TERMINAL_FAILURE_STATES = new Set(['FAILED']);
const FASIT_UI_BASE = 'https://fasit.nais.io';

function readInput(name) {
  return process.env['INPUT_' + name.toUpperCase()] || '';
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

function resolveTargets(inline, filePath) {
  const hasInline = inline.trim().length > 0;
  const hasFile = filePath.trim().length > 0;
  if (hasInline && hasFile) {
    throw new Error('Inputs "targets" and "targets-file" are mutually exclusive; set exactly one');
  }
  if (!hasInline && !hasFile) {
    throw new Error('One of "targets" or "targets-file" is required');
  }
  let raw;
  let source;
  if (hasFile) {
    const resolvedPath = filePath.trim();
    try {
      raw = fs.readFileSync(resolvedPath, 'utf8');
    } catch (e) {
      throw new Error(`Failed to read targets-file "${resolvedPath}": ${e.message}`);
    }
    source = `targets-file (${resolvedPath})`;
  } else {
    raw = inline;
    source = 'targets';
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${source} is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${source} must be a JSON array of {target, wait} entries`);
  }
  if (parsed.length === 0) {
    throw new Error(`${source} must contain at least one entry`);
  }
  parsed.forEach((entry, i) => validateEntry(entry, i, source));
  return parsed;
}

function validateEntry(entry, index, source) {
  const at = `${source}[${index}]`;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${at} must be an object with a "target" key (and optional "wait")`);
  }
  if (entry.target === null || typeof entry.target !== 'object' || Array.isArray(entry.target)) {
    throw new Error(`${at}.target must be a JSON object`);
  }
  if (entry.wait === undefined) {
    entry.wait = false;
  } else if (typeof entry.wait !== 'boolean') {
    throw new Error(`${at}.wait must be a boolean when set`);
  }
}

function resolveTimeoutMinutes(raw) {
  const trimmed = (raw || '').trim();
  if (trimmed === '') return DEFAULT_TIMEOUT_MINUTES;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Input "timeout-minutes" must be a positive number, got "${raw}"`);
  }
  return n;
}

async function fetchOidcToken(requestUrl, requestToken) {
  const response = await fetch(requestUrl, {
    headers: { Authorization: `bearer ${requestToken}` },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Failed to get OIDC token (HTTP ${response.status}): ${body}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new Error(`Failed to parse OIDC token response: ${e.message}`);
  }
  if (!parsed.value) {
    throw new Error('OIDC token response did not contain a value');
  }
  return parsed.value;
}

function buildPayload({ chart, version, target, owner, repo, sha }) {
  return {
    target: target,
    chart: chart,
    version: version,
    ref: { owner: owner, repo: repo, ref: sha },
  };
}

async function postDeployment(endpoint, token, payload) {
  const response = await fetch(`${endpoint}/github/deployment`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Deployment request failed (HTTP ${response.status}): ${body}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new Error(`Failed to parse deployment response: ${e.message}`);
  }
  if (!parsed.id || typeof parsed.id !== 'string') {
    throw new Error('Deployment response did not contain an id');
  }
  return parsed.id;
}

async function fetchDeploymentStatus(endpoint, token, id) {
  const response = await fetch(`${endpoint}/github/deployment/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.text();
  if (response.status === 401) {
    const err = new Error(`Status request failed (HTTP 401): ${body}`);
    err.unauthorized = true;
    throw err;
  }
  if (!response.ok) {
    throw new Error(`Status request failed (HTTP ${response.status}): ${body}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new Error(`Failed to parse status response: ${e.message}`);
  }
  if (!parsed.state || typeof parsed.state !== 'string') {
    throw new Error('Status response did not contain a state');
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fasitDeploymentUrl(id) {
  return `${FASIT_UI_BASE}/deployments/${encodeURIComponent(id)}`;
}

async function pollDeploymentStatus(endpoint, getToken, id, { timeoutMs, intervalMs = POLL_INTERVAL_MS, log = () => {} } = {}) {
  const deadline = Date.now() + timeoutMs;
  let token = await getToken();
  while (true) {
    let status;
    try {
      status = await fetchDeploymentStatus(endpoint, token, id);
    } catch (err) {
      if (err.unauthorized) {
        log(`Token expired, refreshing`);
        token = await getToken({ refresh: true });
        continue;
      }
      throw err;
    }
    log(`Deployment ${id} state: ${status.state}`);
    if (TERMINAL_FAILURE_STATES.has(status.state)) {
      throw new Error(`Deployment ${id} failed with state ${status.state} (details: ${fasitDeploymentUrl(id)})`);
    }
    if (TERMINAL_SUCCESS_STATES.has(status.state)) {
      return status;
    }
    if (Date.now() + intervalMs >= deadline) {
      throw new Error(`Timed out waiting for deployment ${id} to finish (last state: ${status.state}, details: ${fasitDeploymentUrl(id)})`);
    }
    await sleep(intervalMs);
  }
}

function writeStepSummary(message) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  fs.appendFileSync(summaryPath, message);
}

function formatTarget(target) {
  const keys = Object.keys(target).sort();
  if (keys.length === 0) return '{}';
  return '{' + keys.map((k) => `${k}: ${target[k]}`).join(', ') + '}';
}

async function main({ pollIntervalMs = POLL_INTERVAL_MS } = {}) {
  const summaryLines = ['### Deployment created! :rocket:\n'];
  let lastDeploymentId = null;
  try {
    const endpoint = readInput('endpoint');
    if (!endpoint) throw new Error('Input "endpoint" is required');

    const chart = readInput('chart').trim();
    if (!chart) throw new Error('Input "chart" is required and must not be empty');

    const version = readInput('version').trim();
    if (!version) throw new Error('Input "version" is required and must not be empty');

    const targets = resolveTargets(readInput('targets'), readInput('targets-file'));
    const timeoutMinutes = resolveTimeoutMinutes(readInput('timeout-minutes'));
    const timeoutMs = timeoutMinutes * 60 * 1000;

    const repository = requireEnv('GITHUB_REPOSITORY');
    const owner = requireEnv('GITHUB_REPOSITORY_OWNER');
    const sha = requireEnv('GITHUB_SHA');
    const oidcToken = requireEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN');
    const oidcUrl = requireEnv('ACTIONS_ID_TOKEN_REQUEST_URL');

    const repo = repository.split('/').pop();

    let cachedToken = null;
    const getToken = async ({ refresh = false } = {}) => {
      if (refresh || !cachedToken) {
        console.log(refresh ? 'Refreshing token from Github' : 'Getting token from Github');
        cachedToken = await fetchOidcToken(oidcUrl, oidcToken);
      }
      return cachedToken;
    };

    for (let i = 0; i < targets.length; i++) {
      const { target, wait } = targets[i];
      const label = formatTarget(target);
      console.log(`Deploying to ${label} (wait=${wait})`);
      const payload = buildPayload({ chart, version, target, owner, repo, sha });
      console.log('JSON:', JSON.stringify(payload));
      const id = await postDeployment(endpoint, await getToken(), payload);
      lastDeploymentId = id;
      summaryLines.push(`- [Deployment ${id}](${fasitDeploymentUrl(id)}) created for ${label} (wait=${wait})\n`);

      if (wait) {
        console.log(`Waiting for deployment ${id} (timeout ${timeoutMinutes}m)`);
        const finalStatus = await pollDeploymentStatus(endpoint, getToken, id, {
          timeoutMs,
          intervalMs: pollIntervalMs,
          log: (msg) => console.log(msg),
        });
        summaryLines.push(`  - Reached state ${finalStatus.state}\n`);
      }
    }
    summaryLines.push(`\n[All deployments](${FASIT_UI_BASE}/deployments)\n`);
    writeStepSummary(summaryLines.join(''));

    console.log(`Deployment progress: ${FASIT_UI_BASE}/deployments`);
  } catch (err) {
    console.error(err.message);
    if (lastDeploymentId) {
      summaryLines.push(`\n**Failed:** ${err.message}\n\n[Inspect deployment in Fasit](${fasitDeploymentUrl(lastDeploymentId)})\n`);
    } else {
      summaryLines.push(`\n**Failed:** ${err.message}\n`);
    }
    writeStepSummary(summaryLines.join(''));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  readInput, requireEnv, resolveTargets, validateEntry, resolveTimeoutMinutes,
  fetchOidcToken, buildPayload, postDeployment, fetchDeploymentStatus, pollDeploymentStatus,
  writeStepSummary, formatTarget, fasitDeploymentUrl, main,
  POLL_INTERVAL_MS, DEFAULT_TIMEOUT_MINUTES, FASIT_UI_BASE,
};
