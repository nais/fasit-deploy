'use strict';

const fs = require('node:fs');

/**
 * Reads a GitHub Actions input by name from the INPUT_* environment variable.
 * Hyphens in the name are preserved (e.g. 'targets-file' → INPUT_TARGETS-FILE).
 * @param {string} name - The input name as declared in action.yml
 * @returns {string} The input value, or empty string if unset
 */
function readInput(name) {
  return process.env['INPUT_' + name.toUpperCase()] || '';
}

/**
 * Reads a required environment variable, throwing if it is unset or empty.
 * @param {string} name - The environment variable name
 * @returns {string} The variable value
 */
function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

/**
 * @typedef {Object} TargetEntry
 * @property {Object} target - Map of label keys to label values
 * @property {boolean} wait - Whether to wait for this deployment to finish
 */

/**
 * Resolves the targets list from inline JSON or a file path; exactly one must be set.
 * @param {string} inline - Raw JSON string from the `targets` input
 * @param {string} filePath - Path from the `targets-file` input
 * @returns {TargetEntry[]} The validated, non-empty list of entries
 */
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

/**
 * Validates a single targets entry has the shape {target: object, wait: boolean}.
 * @param {unknown} entry - The candidate entry
 * @param {number} index - Position in the list, for error messages
 * @param {string} source - Origin label, for error messages
 * @returns {void}
 */
function validateEntry(entry, index, source) {
  const at = `${source}[${index}]`;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${at} must be an object with "target" and "wait" keys`);
  }
  const { target, wait } = entry;
  if (target === null || typeof target !== 'object' || Array.isArray(target)) {
    throw new Error(`${at}.target must be a JSON object`);
  }
  if (typeof wait !== 'boolean') {
    throw new Error(`${at}.wait must be a boolean`);
  }
}

/**
 * Fetches a GitHub OIDC token from the Actions token endpoint.
 * @param {string} requestUrl - The ACTIONS_ID_TOKEN_REQUEST_URL value
 * @param {string} requestToken - The ACTIONS_ID_TOKEN_REQUEST_TOKEN value
 * @returns {Promise<string>} The OIDC token value
 */
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

/**
 * @typedef {Object} DeployPayload
 * @property {{ wait: boolean }} ci
 * @property {Object} target
 * @property {string} chart
 * @property {string} version
 * @property {{ owner: string, repo: string, ref: string }} ref
 */

/**
 * Builds a single deployment request payload.
 * @param {{ chart: string, version: string, target: Object, wait: boolean, owner: string, repo: string, sha: string }} params
 * @returns {DeployPayload}
 */
function buildPayload({ chart, version, target, wait, owner, repo, sha }) {
  return {
    ci: { wait: wait },
    target: target,
    chart: chart,
    version: version,
    ref: { owner: owner, repo: repo, ref: sha },
  };
}

/**
 * Posts a deployment request to the Fasit endpoint.
 * @param {string} endpoint - The Fasit base URL
 * @param {string} token - The OIDC bearer token
 * @param {DeployPayload} payload - The deployment payload
 * @returns {Promise<string>} The response body
 */
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
  return body || '';
}

/**
 * Appends a message to the GitHub step summary file, if configured.
 * @param {string} message - The markdown content to append
 * @returns {void}
 */
function writeStepSummary(message) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  fs.appendFileSync(summaryPath, message);
}

/**
 * Formats a target object as a stable, human-readable label string.
 * Used in step summaries; not sent to Fasit.
 * @param {Object} target - The target labels
 * @returns {string}
 */
function formatTarget(target) {
  const keys = Object.keys(target).sort();
  if (keys.length === 0) return '{}';
  return '{' + keys.map((k) => `${k}: ${target[k]}`).join(', ') + '}';
}

/**
 * Main entry point: reads inputs, fetches OIDC token, and posts one deployment per target.
 * @returns {Promise<void>}
 */
async function main() {
  try {
    const endpoint = readInput('endpoint');
    if (!endpoint) throw new Error('Input "endpoint" is required');

    const chart = readInput('chart').trim();
    if (!chart) throw new Error('Input "chart" is required and must not be empty');

    const version = readInput('version').trim();
    if (!version) throw new Error('Input "version" is required and must not be empty');

    const targets = resolveTargets(readInput('targets'), readInput('targets-file'));

    const repository = requireEnv('GITHUB_REPOSITORY');
    const owner = requireEnv('GITHUB_REPOSITORY_OWNER');
    const sha = requireEnv('GITHUB_SHA');
    const oidcToken = requireEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN');
    const oidcUrl = requireEnv('ACTIONS_ID_TOKEN_REQUEST_URL');

    const repo = repository.split('/').pop();

    console.log('Getting token from Github');
    const token = await fetchOidcToken(oidcUrl, oidcToken);

    const summaryLines = ['### Deployment created! :rocket:\n'];
    for (let i = 0; i < targets.length; i++) {
      const { target, wait } = targets[i];
      const label = formatTarget(target);
      console.log(`Deploying to ${label} (wait=${wait})`);
      const payload = buildPayload({ chart, version, target, wait, owner, repo, sha });
      console.log('JSON:', JSON.stringify(payload));
      await postDeployment(endpoint, token, payload);
      summaryLines.push(`- Deployment created for ${label} (wait=${wait})\n`);
    }
    summaryLines.push('[Deployment progress](https://fasit.nais.io/deployments)\n');
    writeStepSummary(summaryLines.join(''));

    console.log('Deployment progress: https://fasit.nais.io/deployments');
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  readInput, requireEnv, resolveTargets, validateEntry,
  fetchOidcToken, buildPayload, postDeployment, writeStepSummary, formatTarget, main,
};
