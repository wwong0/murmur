// Measurement scripts that define an HTTP baseline must refuse a server using
// the product's host delivery path, including a stale server without settings.

const NO_SETTINGS = 'no /app-settings — a server older than change 7a';

export async function requireDelivery(origin, expected, { fetchImpl = fetch, trackerUrl: expectedTrackerUrl } = {}) {
  let response;
  try {
    response = await fetchImpl(`${origin}/app-settings`, { cache: 'no-store' });
  } catch (error) {
    throw new Error(`${NO_SETTINGS}: ${error?.message ?? error}`);
  }
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    throw new Error(`${NO_SETTINGS} at ${origin}`);
  }
  let settings;
  try {
    settings = await response.json();
  } catch (error) {
    throw new Error(`${NO_SETTINGS} at ${origin}: ${error?.message ?? error}`);
  }
  if (!settings || typeof settings.delivery !== 'string') throw new Error(`${NO_SETTINGS} at ${origin}`);
  if (settings.delivery !== expected) {
    throw new Error(`delivery is "${settings.delivery}" at ${origin}, this script requires "${expected}"`);
  }
  if (expectedTrackerUrl !== undefined && settings.trackerUrl !== expectedTrackerUrl) {
    throw new Error(`trackerUrl is ${JSON.stringify(settings.trackerUrl)} at ${origin}, expected ${JSON.stringify(expectedTrackerUrl)}`);
  }
  return settings;
}
