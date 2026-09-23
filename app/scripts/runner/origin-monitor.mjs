// Is the origin still there? A run whose server died part way through produces
// evidence that looks thin rather than evidence that looks absent, so the
// monitor turns the second reading into the first.
//
// Lifted from `measure-leads.mjs`, unchanged in every number: two consecutive
// failures before it gives up, a 1000 ms request timeout, 250 ms between polls.
// One failure is a hiccup and would abort healthy runs; the manifest write it
// used to do itself is now the caller's `onFailure`, so this module holds no
// manifest.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const CONSECUTIVE_FAILURES_BEFORE_ABORT = 2;
export const REQUEST_TIMEOUT_MS = 1000;
export const POLL_INTERVAL_MS = 250;

// A condition that fills the shaped queue on purpose declares a longer timeout,
// because the host reaches the origin across that queue (6b design.md D1).
export function startOriginMonitor({ healthUrl, deadlineAt, maxWallMs, onFailure = () => {}, requestTimeoutMs = REQUEST_TIMEOUT_MS }) {
  let stopped = false;
  let controller = null;
  const monitor = {
    startedAt: new Date().toISOString(),
    endpoint: healthUrl,
    promise: null,
    stop() {
      stopped = true;
      controller?.abort();
    },
  };

  monitor.promise = (async () => {
    let consecutive = 0;
    while (!stopped) {
      if (Date.now() >= deadlineAt) throw new Error(`overall run exceeded ${maxWallMs}ms while monitoring the server`);
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const response = await fetch(healthUrl, { cache: 'no-store', signal: controller.signal });
        await response.arrayBuffer();
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        consecutive = 0;
      } catch (error) {
        if (stopped) return;
        consecutive += 1;
        if (consecutive >= CONSECUTIVE_FAILURES_BEFORE_ABORT) {
          const failureDetectedAt = new Date().toISOString();
          const failureReason = `server unavailable at ${failureDetectedAt}: ${error.message}`;
          onFailure({ startedAt: monitor.startedAt, endpoint: healthUrl, failureDetectedAt, failureReason });
          const failed = new Error(failureReason);
          failed.serverUnavailable = true;
          throw failed;
        }
      } finally {
        clearTimeout(timeout);
        controller = null;
      }
      await sleep(POLL_INTERVAL_MS);
    }
  })();
  monitor.promise.catch(() => {});
  return monitor;
}

export async function stopOriginMonitor(monitor) {
  if (!monitor) return;
  monitor.stop();
  await monitor.promise.catch(() => {});
}
