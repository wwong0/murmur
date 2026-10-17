export function createPageView(initial, { onError = () => {} } = {}) {
  let snapshot = initial;
  const subscribers = new Set();

  function get() {
    return snapshot;
  }

  function set(key, value) {
    if (!Object.hasOwn(initial, key)) throw new TypeError(`unknown view key: ${key}`);
    snapshot = { ...snapshot, [key]: value };
    for (const subscriber of subscribers) {
      try {
        subscriber(key, snapshot);
      } catch (error) {
        try { onError(error, key); } catch { /* a reporter cannot stop delivery */ }
      }
    }
  }

  function subscribe(subscriber) {
    subscribers.add(subscriber);
    return () => subscribers.delete(subscriber);
  }

  return { get, set, subscribe };
}
