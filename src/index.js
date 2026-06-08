'use strict';

const fs = require('node:fs');

const POLL_INTERVAL_MS = 10_000;
const DEFAULT_TIMEOUT_MINUTES = 10;
const TOKEN_REFRESH_LEEWAY_MS = 60_000;
const TERMINAL_SUCCESS_STATES = new Set(['DEPLOYED', 'DISABLED']);
const TERMINAL_FAILURE_STATES = new Set(['FAILED']);
const FASIT_UI_BASE = 'https://fasit.nais.io';
const DEFAULT_FETCH_ATTEMPTS = 5;
const DEFAULT_FETCH_BASE_DELAY_MS = 1000;

/**
 * Builds a human-readable description of a fetch error, including the
 * underlying `cause` (DNS, ECONNRESET, ETIMEDOUT, etc.). Node's global
 * `fetch` rejects with a generic `TypeError: fetch failed` and stashes the
 * real reason on `err.cause`, so we always need to drill in.
 */
function describeFetchError(err) {
	if (!err) return 'unknown error';
	const parts = [err.message || String(err)];
	let cause = err.cause;
	let depth = 0;
	while (cause && depth < 3) {
		const code = cause.code ? ` [${cause.code}]` : '';
		const msg = cause.message || String(cause);
		parts.push(`cause:${code} ${msg}`);
		cause = cause.cause;
		depth++;
	}
	return parts.join(' | ');
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps a fetch call with bounded retries on *network* errors (i.e. when
 * `fetch` itself rejects). HTTP status handling is left to the caller, so
 * 4xx/5xx responses are returned as-is and not retried here.
 *
 * @param {string} label - Short description used in retry log lines.
 * @param {() => Promise<Response>} doFetch - Function that performs one fetch.
 * @param {{ attempts?: number, baseDelayMs?: number, log?: (msg: string) => void }} [opts]
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(
	label,
	doFetch,
	{
		attempts = DEFAULT_FETCH_ATTEMPTS,
		baseDelayMs = DEFAULT_FETCH_BASE_DELAY_MS,
		log = console.log,
	} = {},
) {
	let lastErr;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await doFetch();
		} catch (err) {
			lastErr = err;
			const reason = describeFetchError(err);
			if (attempt >= attempts) {
				throw new Error(
					`${label} failed after ${attempts} attempt(s): ${reason}`,
				);
			}
			const delay = baseDelayMs * 2 ** (attempt - 1);
			log(
				`${label}: fetch error on attempt ${attempt}/${attempts} (${reason}); retrying in ${delay}ms`,
			);
			await sleep(delay);
		}
	}
	// Unreachable, but keep the type checker happy.
	throw lastErr;
}

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
		throw new Error(
			'Inputs "targets" and "targets-file" are mutually exclusive; set exactly one',
		);
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
			throw new Error(
				`Failed to read targets-file "${resolvedPath}": ${e.message}`,
			);
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
		throw new Error(
			`${at} must be an object with a "target" key (and optional "wait")`,
		);
	}
	if (
		entry.target === null ||
		typeof entry.target !== 'object' ||
		Array.isArray(entry.target)
	) {
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
		throw new Error(
			`Input "timeout-minutes" must be a positive number, got "${raw}"`,
		);
	}
	return n;
}

async function fetchOidcToken(requestUrl, requestToken, { fetchOptions } = {}) {
	const response = await fetchWithRetry(
		'OIDC token request',
		() =>
			fetch(requestUrl, {
				headers: { Authorization: `bearer ${requestToken}` },
			}),
		fetchOptions,
	);
	const body = await response.text();
	if (!response.ok) {
		throw new Error(
			`Failed to get OIDC token (HTTP ${response.status}): ${body}`,
		);
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

function parseJwtExpiry(token) {
	const parts = token.split('.');
	if (parts.length !== 3) return null;
	try {
		const payload = JSON.parse(
			Buffer.from(parts[1], 'base64url').toString('utf8'),
		);
		if (typeof payload.exp !== 'number') return null;
		return payload.exp * 1000;
	} catch {
		return null;
	}
}

function buildPayload({ chart, version, target, owner, repo, sha }) {
	return {
		target: target,
		chart: chart,
		version: version,
		ref: { owner: owner, repo: repo, ref: sha },
	};
}

async function postAssignment(endpoint, token, payload, { fetchOptions } = {}) {
	const response = await fetchWithRetry(
		'assignment request',
		() =>
			fetch(`${endpoint}/github/deployment`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(payload),
			}),
		fetchOptions,
	);
	const body = await response.text();
	if (!response.ok) {
		throw new Error(
			`Assignment request failed (HTTP ${response.status}): ${body}`,
		);
	}
	let parsed;
	try {
		parsed = JSON.parse(body);
	} catch (e) {
		throw new Error(`Failed to parse assignment response: ${e.message}`);
	}
	if (!parsed.id || typeof parsed.id !== 'string') {
		throw new Error('Assignment response did not contain an id');
	}
	return parsed.id;
}

async function fetchAssignmentStatus(
	endpoint,
	token,
	id,
	{ fetchOptions } = {},
) {
	const response = await fetchWithRetry(
		`Status request for ${id}`,
		() =>
			fetch(`${endpoint}/github/deployment/${encodeURIComponent(id)}`, {
				headers: { Authorization: `Bearer ${token}` },
			}),
		fetchOptions,
	);
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

function fasitAssignmentUrl(id) {
	return `${FASIT_UI_BASE}/assignments/${encodeURIComponent(id)}`;
}

async function pollAssignmentStatus(
	endpoint,
	getToken,
	id,
	{ timeoutMs, intervalMs = POLL_INTERVAL_MS, log = () => {} } = {},
) {
	const deadline = Date.now() + timeoutMs;
	let token = await getToken();
	while (true) {
		let status;
		try {
			status = await fetchAssignmentStatus(endpoint, token, id);
		} catch (err) {
			if (err.unauthorized) {
				log(`Token expired, refreshing`);
				token = await getToken({ refresh: true });
				continue;
			}
			throw err;
		}
		log(`Assignment ${id} state: ${status.state}`);
		if (TERMINAL_FAILURE_STATES.has(status.state)) {
			throw new Error(
				`Assignment ${id} failed with state ${status.state} (details: ${fasitAssignmentUrl(id)})`,
			);
		}
		if (TERMINAL_SUCCESS_STATES.has(status.state)) {
			return status;
		}
		if (Date.now() + intervalMs >= deadline) {
			throw new Error(
				`Timed out waiting for deployment ${id} to finish (last state: ${status.state}, details: ${fasitAssignmentUrl(id)})`,
			);
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
	const summaryLines = ['### Assignment created! :rocket:\n'];
	let lastAssignmentId = null;
	try {
		const endpoint = readInput('endpoint');
		if (!endpoint) throw new Error('Input "endpoint" is required');

		const chart = readInput('chart').trim();
		if (!chart)
			throw new Error('Input "chart" is required and must not be empty');

		const version = readInput('version').trim();
		if (!version)
			throw new Error('Input "version" is required and must not be empty');

		const targets = resolveTargets(
			readInput('targets'),
			readInput('targets-file'),
		);
		const timeoutMinutes = resolveTimeoutMinutes(readInput('timeout-minutes'));
		const timeoutMs = timeoutMinutes * 60 * 1000;

		const repository = requireEnv('GITHUB_REPOSITORY');
		const owner = requireEnv('GITHUB_REPOSITORY_OWNER');
		const sha = requireEnv('GITHUB_SHA');
		const oidcToken = requireEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN');
		const oidcUrl = requireEnv('ACTIONS_ID_TOKEN_REQUEST_URL');

		const repo = repository.split('/').pop();

		let cachedToken = null;
		let cachedExpiry = null;
		const getToken = async ({ refresh = false } = {}) => {
			const expiringSoon =
				cachedExpiry !== null &&
				cachedExpiry - Date.now() < TOKEN_REFRESH_LEEWAY_MS;
			if (refresh || !cachedToken || expiringSoon) {
				const reason = refresh
					? 'forced refresh'
					: !cachedToken
						? 'initial fetch'
						: 'expiring soon';
				console.log(`Getting token from Github (${reason})`);
				cachedToken = await fetchOidcToken(oidcUrl, oidcToken);
				cachedExpiry = parseJwtExpiry(cachedToken);
			}
			return cachedToken;
		};

		for (let i = 0; i < targets.length; i++) {
			const { target, wait } = targets[i];
			const label = formatTarget(target);
			console.log(`Deploying to ${label} (wait=${wait})`);
			const payload = buildPayload({
				chart,
				version,
				target,
				owner,
				repo,
				sha,
			});
			console.log('JSON:', JSON.stringify(payload));
			const id = await postAssignment(endpoint, await getToken(), payload);
			lastAssignmentId = id;
			summaryLines.push(
				`- [Assignment ${id}](${fasitAssignmentUrl(id)}) created for ${label} (wait=${wait})\n`,
			);

			if (wait) {
				console.log(
					`Waiting for assignment ${id} (timeout ${timeoutMinutes}m)`,
				);
				const finalStatus = await pollAssignmentStatus(endpoint, getToken, id, {
					timeoutMs,
					intervalMs: pollIntervalMs,
					log: (msg) => console.log(msg),
				});
				summaryLines.push(`  - Reached state ${finalStatus.state}\n`);
			}
		}
		summaryLines.push(`\n[All assignments](${FASIT_UI_BASE}/assignments)\n`);
		writeStepSummary(summaryLines.join(''));

		console.log(`Assignment progress: ${FASIT_UI_BASE}/assignments`);
	} catch (err) {
		console.error(err.message);
		if (lastAssignmentId) {
			summaryLines.push(
				`\n**Failed:** ${err.message}\n\n[Inspect assignment in Fasit](${fasitAssignmentUrl(lastAssignmentId)})\n`,
			);
		} else {
			summaryLines.push(`\n**Failed:** ${err.message}\n`);
		}
		writeStepSummary(summaryLines.join(''));
		process.exitCode = 1;
	}
}

if (require.main === module) main();

module.exports = {
	readInput,
	requireEnv,
	resolveTargets,
	validateEntry,
	resolveTimeoutMinutes,
	fetchOidcToken,
	parseJwtExpiry,
	buildPayload,
	postAssignment,
	fetchAssignmentStatus,
	pollAssignmentStatus,
	writeStepSummary,
	formatTarget,
	fasitAssignmentUrl,
	main,
	describeFetchError,
	fetchWithRetry,
	POLL_INTERVAL_MS,
	DEFAULT_TIMEOUT_MINUTES,
	TOKEN_REFRESH_LEEWAY_MS,
	FASIT_UI_BASE,
	DEFAULT_FETCH_ATTEMPTS,
	DEFAULT_FETCH_BASE_DELAY_MS,
};
