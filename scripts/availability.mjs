import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { instrumentMetaData } from 'dukascopy-node';

const ROOT = 'https://jetta.dukascopy.com/v1';
const ORIGIN = new URL(ROOT).origin;
const CATALOG_URL = `${ROOT}/instruments`;
const CACHE_MS = 10 * 60_000;
const DEFAULT_SESSION = join(homedir(), '.dukascopy-node', 'waf-token.json');
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
const catalogs = new WeakMap();

function failure(message, status) {
  const error = new Error(message);
  if (status !== undefined) error.status = status;
  return error;
}

async function requestHeaders(sessionPath) {
  const headers = {
    accept: 'application/json',
    referer: 'https://widgets.dukascopy.com/en/historical-data-export',
    'user-agent': USER_AGENT,
  };
  try {
    const session = JSON.parse(await readFile(sessionPath, 'utf8'));
    // Reuse the provider library's session only for its exact HTTPS origin.
    // Never print this session or forward it to a redirect destination.
    if (session?.version === 2 && session.origin === ORIGIN &&
        typeof session.token === 'string' && /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]{1,8192}$/.test(session.token) &&
        typeof session.userAgent === 'string' && /^[\x20-\x7E]{1,1024}$/.test(session.userAgent) && session.userAgent.trim()) {
      headers.cookie = `aws-waf-token=${session.token}`;
      headers['user-agent'] = session.userAgent;
    }
  } catch {
    // A missing/invalid session is not evidence of an unavailable instrument.
    // Try metadata normally; a WAF challenge or other failure remains an error.
  }
  return headers;
}

async function request(fetchImpl, url, headers) {
  return fetchImpl(url, { headers, redirect: 'error', signal: AbortSignal.timeout(15_000) });
}

function validateCatalog(value) {
  // This endpoint returns one complete catalog, including these companion
  // collections. A partial/paginated response must never prove absence.
  const collections = ['instruments', 'groups', 'platformGroups', 'sectors', 'webGroups'];
  if (!value || collections.some(name => !Array.isArray(value[name])) || !value.instruments.length ||
      !value.platforms || typeof value.platforms !== 'object' || Array.isArray(value.platforms) ||
      value.hasMore === true || value.has_more === true || value.next != null || value.nextPage != null ||
      (value.total !== undefined && value.total !== value.instruments.length) ||
      (value.totalCount !== undefined && value.totalCount !== value.instruments.length)) {
    throw failure('Invalid or incomplete provider instrument catalog');
  }
  const codes = new Set();
  const ids = new Set();
  for (const item of value.instruments) {
    if (!item || !Number.isSafeInteger(item.id) || item.id <= 0 || ids.has(item.id) ||
        typeof item.code !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(item.code) || codes.has(item.code)) {
      throw failure('Invalid or duplicate instrument in provider catalog');
    }
    ids.add(item.id);
    codes.add(item.code);
  }
  return codes;
}

/**
 * Confirm a removed symbol using two authoritative responses, never a failed
 * candle request alone. Call after the provider transport has initialized WAF.
 */
export async function confirmUnavailable(instrument, {
  fetchImpl = globalThis.fetch,
  sessionPath = DEFAULT_SESSION,
  metadata = instrumentMetaData,
} = {}) {
  const code = metadata[instrument]?.code;
  if (typeof code !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(code)) {
    throw failure(`Unknown pinned instrument: ${instrument}`);
  }
  const headers = await requestHeaders(sessionPath);
  let cache = catalogs.get(fetchImpl);
  if (!cache) { cache = new Map(); catalogs.set(fetchImpl, cache); }
  let entry = cache.get(sessionPath);
  if (!entry || entry.expiresAt <= Date.now()) {
    const response = await request(fetchImpl, CATALOG_URL, headers);
    if (response.status !== 200) throw failure(`Provider catalog verification returned HTTP ${response.status}`, response.status);
    let catalog;
    try { catalog = await response.json(); }
    catch { throw failure('Provider catalog verification returned invalid JSON'); }
    entry = { codes: validateCatalog(catalog), expiresAt: Date.now() + CACHE_MS };
    cache.set(sessionPath, entry);
  }
  if (entry.codes.has(code)) return null;

  const source = `${CATALOG_URL}/${encodeURIComponent(code)}`;
  const response = await request(fetchImpl, source, headers);
  if (response.status !== 200 && response.status !== 400) {
    throw failure(`Provider instrument verification returned HTTP ${response.status}`, response.status);
  }
  let detail;
  try { detail = await response.json(); }
  catch { throw failure('Provider instrument verification returned invalid JSON', response.status); }
  if (response.status === 200) {
    if (detail?.code !== code) throw failure('Provider instrument verification returned an unexpected instrument');
    return null;
  }
  if (detail?.error !== 'Unknown instrument') {
    throw failure('Provider rejected the instrument verification without confirming an unknown instrument', response.status);
  }
  return {
    code,
    reason: `Absent from the current provider catalog; instrument detail returned HTTP 400: Unknown instrument (${code}).`,
    source,
    checkedAt: new Date().toISOString(),
  };
}
