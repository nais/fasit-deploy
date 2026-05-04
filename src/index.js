'use strict';

const fs = require('node:fs');

/**
 * Reads a GitHub Actions input by name from the INPUT_* environment variable.
 * Hyphens in the name are preserved (e.g. 'skip-ci' → INPUT_SKIP-CI).
 * @param {string} name - The input name as declared in action.yml
 * @returns {string} The input value, or empty string if unset
 */
function readInput(name) {
  return process.env['INPUT_' + name.toUpperCase()] || '';
}

/**
 * Parses a string boolean value (case-insensitive "true"/"false") to a boolean.
 * @param {string} value - The string to parse
 * @param {string} fieldName - The field name to include in error messages
 * @returns {boolean}
 */
function parseBoolean(value, fieldName) {
  const lower = value.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  throw new Error(`Invalid boolean value for ${fieldName}: "${value}". Expected "true" or "false".`);
}

/**
 * Parses and validates a JSON string as a plain object target.
 * Rejects empty strings, non-JSON, arrays, null, and scalar values.
 * @param {string} raw - The raw JSON string
 * @returns {Object} The parsed target object
 */
function parseTarget(raw) {
  if (!raw || !raw.trim()) {
    throw new Error('target is required and must be a JSON object (e.g. {"kind":"management","tenant":"nav"})');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.trim());
  } catch (e) {
    throw new Error(`target is not valid JSON: ${e.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('target must be a JSON object, not an array, null, or scalar value');
  }
  return parsed;
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
 * @property {{ skip: boolean, wait: boolean }} ci
 * @property {boolean} global
 * @property {Object} target
 * @property {string} chart
 * @property {string} version
 * @property {{ owner: string, repo: string, ref: string }} ref
 */

/**
 * Builds the deployment request payload matching the Fasit API contract.
 * @param {{ chart: string, version: string, target: Object, global: boolean, skipCi: boolean, wait: boolean, owner: string, repo: string, sha: string }} params
 * @returns {DeployPayload}
 */
function buildPayload({ chart, version, target, global: isGlobal, skipCi, wait, owner, repo, sha }) {
  return {
    ci: { skip: skipCi, wait: wait },
    global: isGlobal,
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
 * No-op when GITHUB_STEP_SUMMARY is not set.
 * @param {string} message - The markdown content to append
 * @returns {void}
 */
function writeStepSummary(message) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  fs.appendFileSync(summaryPath, message);
}

/**
 * Main entry point: reads inputs, fetches OIDC token, and posts a deployment to Fasit.
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

    const target = parseTarget(readInput('target'));
    const isGlobal = parseBoolean(readInput('global'), 'global');
    const skipCi = parseBoolean(readInput('skip-ci'), 'skip-ci');
    const wait = parseBoolean(readInput('wait'), 'wait');

    const repository = requireEnv('GITHUB_REPOSITORY');
    const owner = requireEnv('GITHUB_REPOSITORY_OWNER');
    const sha = requireEnv('GITHUB_SHA');
    const oidcToken = requireEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN');
    const oidcUrl = requireEnv('ACTIONS_ID_TOKEN_REQUEST_URL');

    const repo = repository.split('/').pop();

    console.log('Getting token from Github');
    const token = await fetchOidcToken(oidcUrl, oidcToken);

    console.log('Deploying new version');
    const payload = buildPayload({ chart, version, target, global: isGlobal, skipCi, wait, owner, repo, sha });
    console.log('JSON:', JSON.stringify(payload));

    await postDeployment(endpoint, token, payload);

    writeStepSummary('### Deployment created! :rocket:\n[Deployment progress](https://fasit.nais.io/deployments)\n');

    console.log('Deployment progress: https://fasit.nais.io/deployments');
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { readInput, parseBoolean, parseTarget, requireEnv, fetchOidcToken, buildPayload, postDeployment, writeStepSummary, main };
