const TURN_SCHEMES = ['turn:', 'turns:'];

const DEFAULTS = { apiBase: 'https://rtc.live.cloudflare.com/v1', ttlS: 43_200, reuseMs: 60_000, timeoutMs: 5000 };
const OPTION_NAMES = { keyId: 'turnKeyId', token: 'turnApiToken', apiBase: 'turnApiBase', ttlS: 'turnTtlS', reuseMs: 'turnReuseMs', timeoutMs: 'turnTimeoutMs' };
export const RELAY_ENV_NAMES = { ...OPTION_NAMES, keyId: 'APP_TURN_KEY_ID', token: 'APP_TURN_API_TOKEN', apiBase: 'APP_TURN_API_BASE', ttlS: 'APP_TURN_TTL_S', reuseMs: 'APP_TURN_REUSE_MS' };

function requireOptionalString(value, name) {
  if (value !== undefined && value !== null && (typeof value !== 'string' || value.length === 0)) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function normalizeApiBase(value, name) {
  let parsed = null;
  try {
    parsed = typeof value === 'string' ? new URL(value) : null;
  } catch {
    parsed = null;
  }
  if (parsed?.protocol !== 'http:' && parsed?.protocol !== 'https:') throw new TypeError(`${name} must be an http: or https: URL`);
  return value.replace(/\/$/, '');
}

/** The relay settings (13 D6), defaulted and validated under `names`; throws naming a bad one. */
export function relaySettings(values, names = OPTION_NAMES) {
  const { keyId, token } = values;
  requireOptionalString(keyId, names.keyId);
  requireOptionalString(token, names.token);
  if ((keyId === undefined) !== (token === undefined)) {
    throw new TypeError(`${names.keyId} and ${names.token} must be configured together`);
  }
  const apiBase = normalizeApiBase(values.apiBase ?? DEFAULTS.apiBase, names.apiBase);
  const ttlS = values.ttlS ?? DEFAULTS.ttlS;
  const reuseMs = values.reuseMs ?? DEFAULTS.reuseMs;
  const timeoutMs = values.timeoutMs ?? DEFAULTS.timeoutMs;
  if (!Number.isSafeInteger(ttlS) || ttlS < 60 || ttlS > 172_800) {
    throw new TypeError(`${names.ttlS} must be an integer from 60 through 172800`);
  }
  if (!Number.isSafeInteger(reuseMs) || reuseMs < 1 || reuseMs >= ttlS * 1000) {
    throw new TypeError(`${names.reuseMs} must be positive and less than turnTtlS * 1000`);
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError(`${names.timeoutMs} must be a positive integer`);
  }
  return { keyId, token, apiBase, ttlS, reuseMs, timeoutMs };
}

function isTurn(entry) {
  const urls = Array.isArray(entry?.urls) ? entry.urls : [entry?.urls];
  return urls.some((url) => typeof url === 'string' && TURN_SCHEMES.some((scheme) => url.startsWith(scheme)));
}

function nonTurnEntries(entries) {
  return Array.isArray(entries) ? entries.filter((entry) => !isTurn(entry)) : [];
}

function responseEntries(body) {
  const entries = body && typeof body === 'object' ? body.iceServers : undefined;
  const list = Array.isArray(entries) ? entries : entries && typeof entries === 'object' ? [entries] : null;
  if (!list || list.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
    throw new Error('invalid relay credential response');
  }
  return list;
}

/** Create a lazy, bounded Cloudflare TURN credential provider. */
export function createRelayCredentials({
  keyId,
  token,
  apiBase,
  ttlS,
  reuseMs,
  timeoutMs = 5000,
  fetch: fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  log = () => {},
}) {
  let minted = null;
  let inFlight = null;

  async function mint() {
    try {
      const response = await fetchImpl(`${apiBase.replace(/\/$/, '')}/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: ttlS }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response || response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response?.status ?? 'unknown'}`);
      }
      return responseEntries(await response.json());
    } catch (error) {
      const reason = /^HTTP /.test(error?.message ?? '') ? error.message : error?.name ?? 'Error';
      log(`relay credential request failed: ${reason}`);
      return null;
    }
  }

  async function iceServers(configured) {
    const stable = nonTurnEntries(configured);
    const current = now();
    if (minted && current - minted.atMs < reuseMs) return stable.concat(minted.entries);
    if (!inFlight) {
      inFlight = mint().then((entries) => {
        inFlight = null;
        if (entries) minted = { atMs: now(), entries };
        return entries;
      });
    }
    const entries = await inFlight;
    return entries ? stable.concat(entries) : stable;
  }

  return { iceServers };
}
