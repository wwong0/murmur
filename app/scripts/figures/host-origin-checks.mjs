const finite = (value) => Number.isFinite(value);

function counters(value) {
  return value?.counters ?? value ?? {};
}

function delta(after, before, field) {
  const right = Number(counters(after)?.[field] ?? 0);
  const left = Number(counters(before)?.[field] ?? 0);
  if (!finite(right) || !finite(left) || right < left) throw new Error(`counter ${field} is not monotonic`);
  return right - left;
}

export function viewerHttpLeak({ roomFinal, viewerTags = [] } = {}) {
  if (!roomFinal || typeof counters(roomFinal).byClient !== 'object') throw new Error('room server final snapshot is unavailable');
  const final = counters(roomFinal);
  const byClient = final.byClient ?? {};
  const leaked = [];
  for (const tag of viewerTags) {
    const bytes = Number(byClient[tag]?.mediaBytesDelivered ?? 0);
    if (!finite(bytes) || bytes < 0) throw new Error(`invalid room media bytes for ${tag}`);
    if (bytes > 0) leaked.push({ tag, bytes });
  }
  const unattributedBytes = Number(final.unattributedMediaBytesDelivered ?? 0);
  if (!finite(unattributedBytes) || unattributedBytes < 0) throw new Error('invalid unattributed room media bytes');
  return { leaked, unattributedBytes };
}

function sampleTime(sample) {
  return sample?.atMs ?? sample?.at ?? sample?.timeMs;
}

function sampleTx(sample) {
  return sample?.txBytes ?? sample?.tx_bytes;
}

export function uplinkVersusDelivered({ linkSamples = [], window, originStart, originEnd } = {}) {
  const samples = (Array.isArray(linkSamples) ? linkSamples : [])
    .filter((sample) => finite(sampleTime(sample)) && finite(sampleTx(sample)))
    .filter((sample) => !window || (sampleTime(sample) >= window.startMs && sampleTime(sample) <= window.endMs));
  if (samples.length < 2) return { txBytes: null, deliveredMediaBytes: null, ratio: null };
  const txBytes = sampleTx(samples.at(-1)) - sampleTx(samples[0]);
  if (!finite(txBytes) || txBytes < 0) throw new Error('media interface tx counter is not monotonic');
  const deliveredMediaBytes = delta(originEnd, originStart, 'mediaBytesDelivered');
  return {
    txBytes,
    deliveredMediaBytes,
    ratio: deliveredMediaBytes > 0 ? txBytes / deliveredMediaBytes : null,
  };
}

export function loopbackAnswer(input = {}) {
  const L = Number(input.L ?? input.loTxBytes ?? input.loopbackTxBytes);
  const S = Number(input.S ?? input.hostSourceBytes ?? input.roomHostBytes);
  const T = Number(input.T ?? input.mediaTxBytes ?? input.txBytes);
  const D = Number(input.D ?? input.hostDeliveredBytes ?? input.deliveredMediaBytes);
  if (![L, S, T, D].every(finite)) return { answer: 'inconclusive', L, S, T, D };
  if ([L, S, T, D].some((value) => value < 0)) throw new RangeError('loopback counters cannot be negative');
  if (L >= S && T - D < S) return { answer: 'loopback, excluded', L, S, T, D };
  if (T - D >= S) return { answer: 'crosses the media interface', L, S, T, D };
  return { answer: 'inconclusive', L, S, T, D };
}
