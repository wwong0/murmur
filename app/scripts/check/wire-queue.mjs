// The fake wire rig: three channels into a link below them, shared by the suites that
// read the host's estimate off the wire.

import { createFakeLink } from './fake-channel.mjs';
import { createHostOrigin } from '../../public/lib/host-origin.mjs';
import { encodeControl } from '../../public/lib/segment-protocol.mjs';

const BODY_BYTES = 400_000_000;

export async function flush(turns = 20) {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

function handedOf(links) {
  let total = 0;
  for (const link of links) {
    for (const entry of link.host.ledger) total += entry.bytes;
    total -= link.host.bufferedAmount;
  }
  return total;
}

// A link below the channels, shared by them all: it carries at most `bytesPerMs` of
// what they handed it and queues the rest, and whatever is queued delays every
// channel's delivery, the echo's included. `counts: 'carried'` reads the wire after
// the queue; `'handed'` reads it before, as `bytesSent` does over a kernel qdisc.
export function sharedQueue(clock, links, bytesPerMs, { counts = 'carried' } = {}) {
  let carried = 0;
  let atMs = clock.now();
  const advance = () => {
    const now = clock.now();
    carried = Math.min(handedOf(links), carried + bytesPerMs * (now - atMs));
    atMs = now;
  };
  for (const link of links) link.host.setBelowDelay(() => { advance(); return (handedOf(links) - carried) / bytesPerMs; });
  return {
    setRate(value) {
      advance();
      bytesPerMs = value;
    },
    read() {
      advance();
      return counts === 'carried' ? carried : handedOf(links);
    },
    queueMs() {
      advance();
      return (handedOf(links) - carried) / bytesPerMs;
    },
  };
}

export async function host({ clock, drainBytesPerMs, fraction = 0.85, queueBytesPerMs = null, counts }) {
  const bytes = new Uint8Array(BODY_BYTES);
  const links = [0, 1, 2].map(() => createFakeLink({ clock, hostDrainBytesPerMs: drainBytesPerMs, viewerDrainBytesPerMs: 1_000_000 }));
  const wire = queueBytesPerMs === null ? null : sharedQueue(clock, links, queueBytesPerMs, { counts });
  const origin = createHostOrigin({ readSource: async () => ({ status: 200, bytes }), clock, pace: { fraction }, wire });
  const detaches = links.map((link) => origin.attach(link.host));
  links.forEach((link, index) => link.viewer.send(encodeControl({ t: 'req', id: index + 1, path: '/media/big.m4s', range: null })));
  clock.advance(1);
  await flush();
  return {
    origin,
    links,
    wire,
    cleanup() {
      detaches.forEach((detach) => detach());
      links.forEach((link) => link.closeBoth());
    },
  };
}
