const TURN_SCHEMES = ['turn:', 'turns:'];

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
