import { assert, assertEqual, check } from '../harness.mjs';
import { attemptDispositions, createPeerBytes, keptBytes } from '../../../public/lib/peer-bytes.mjs';
import { createRig, executeHttp, installWindow, response } from '../peer-bytes-fixture.mjs';

function publisher(rig, options = {}) {
  let now = 2000;
  const value = createPeerBytes({ wallNow: () => ++now, ...options });
  value.attach(rig.engine);
  return value;
}

function startPeer(rig, peerId = 'peer-a', timeoutMs) {
  const controls = rig.request.start(
    { downloadSource: 'p2p', peerId },
    { notReceivingBytesTimeoutMs: timeoutMs, onAbort: () => {} },
  );
  controls.firstBytesReceived();
  return controls;
}

function attempts(reading) {
  return reading.records.filter((record) => record.kind === 'attempt');
}

function assertSegment(reading, idList, sum, label, expectedKept = { hostBytes: 0, peerBytes: sum }) {
  const segment = reading.records.find((record) => record.kind === 'segment');
  assert(segment, `${label}: segment record exists`);
  assertEqual(JSON.stringify(segment.keptAttemptIds), JSON.stringify(idList), `${label}: kept ids`);
  assertEqual(segment.keptSumBytes, sum, `${label}: kept sum`);
  assertEqual(segment.lengthBytes, sum, `${label}: segment length`);
  assertEqual(JSON.stringify(reading.kept), JSON.stringify(expectedKept), `${label}: running kept bytes`);
  assertEqual(JSON.stringify(keptBytes(reading.records)), JSON.stringify(expectedKept), `${label}: pure kept bytes`);
}

export async function peerBytesP2pSuite() {
  await check('peer-bytes P2P (7): a whole peer segment is one kept attempt', async () => {
    const rig = createRig();
    const value = publisher(rig);
    const controls = startPeer(rig);
    controls.addLoadedChunk(new Uint8Array(4));
    controls.completeOnSuccess();
    const reading = value.read();
    const record = attempts(reading)[0];
    assertEqual(record.bytes, 4, 'case (7): peer attempt bytes');
    assertEqual(record.end, 'loaded', 'case (7): peer attempt ends loaded');
    assertEqual(record.peerId, 'peer-a', 'case (7): sending peer is retained');
    assertSegment(reading, [1], 4, 'case (7)');
    assertEqual(recordsOf(reading, 'anomaly').length, 0, 'case (7): no anomaly');
  });

  await check('peer-bytes P2P (8): timeout keeps peer bytes for an HTTP resume', async () => {
    const rig = createRig();
    const value = publisher(rig);
    const windowState = installWindow(() => {});
    try {
      const controls = startPeer(rig, 'peer-a', 0);
      controls.addLoadedChunk(new Uint8Array(3));
      rig.request.setTotalBytes(6);
      windowState.timers[0]();
    } finally {
      windowState.restore();
    }
    await executeHttp(rig, [response(new Uint8Array(3), { status: 206, headers: { 'Content-Length': '3', 'Content-Range': 'bytes 3-5/6' } })]);
    const reading = value.read();
    const found = attempts(reading);
    assertEqual(found.length, 2, 'case (8): two attempts');
    assertEqual(found[0].bytes, 3, 'case (8): timeout keeps three peer bytes');
    assertEqual(found[0].end, 'error:bytes-receiving-timeout', 'case (8): timeout error is recorded');
    assertEqual(found[1].bytes, 3, 'case (8): HTTP adds three bytes');
    assertEqual(found[1].source, 'http', 'case (8): resume source is HTTP');
    assertSegment(reading, [1, 2], 6, 'case (8)', { hostBytes: 3, peerBytes: 3 });
  });

  await check('peer-bytes P2P (9): HTTP truncation resumes through a peer', async () => {
    const rig = createRig();
    const value = publisher(rig);
    await executeHttp(rig, [response(new Uint8Array(2), { headers: { 'Content-Length': '6' } })]);
    const controls = startPeer(rig, 'peer-b', undefined);
    controls.addLoadedChunk(new Uint8Array(4));
    controls.completeOnSuccess();
    const reading = value.read();
    const found = attempts(reading);
    assertEqual(found[0].bytes, 2, 'case (9): HTTP adds two bytes');
    assertEqual(found[0].end, 'error:http-bytes-mismatch', 'case (9): HTTP truncation is recorded');
    assertEqual(found[1].bytes, 4, 'case (9): peer adds four bytes');
    assertEqual(found[1].peerId, 'peer-b', 'case (9): peer sender is retained');
    assertSegment(reading, [1, 2], 6, 'case (9)', { hostBytes: 2, peerBytes: 4 });
  });

  await check('peer-bytes P2P (10): peer error after clear discards the current bytes', async () => {
    const rig = createRig();
    const value = publisher(rig);
    const controls = startPeer(rig);
    controls.addLoadedChunk(new Uint8Array(2));
    rig.request.clearLoadedBytes();
    controls.failWithError({ type: 'peer-closed' });
    const reading = value.read();
    const found = attempts(reading);
    assertEqual(found[0].bytes, 2, 'case (10): attempt bytes come from progress');
    assertEqual(found[0].heldAtEndBytes, 0, 'case (10): held bytes were cleared');
    const discard = reading.records.find((record) => record.kind === 'discard');
    assert(discard, 'case (10): clear emits a discard');
    assertEqual(JSON.stringify(discard.attemptIds), JSON.stringify([1]), 'case (10): current attempt is discarded');
    assertEqual(JSON.stringify([...attemptDispositions(reading.records).values()]), JSON.stringify(['discarded']), 'case (10): disposition is discarded');
    assertEqual(reading.records.filter((record) => record.kind === 'segment').length, 0, 'case (10): failed request has no segment');
  });

  await check('peer-bytes P2P (11): a dropped request discards its old attempt', async () => {
    const rig = createRig();
    const value = publisher(rig);
    const first = startPeer(rig, 'peer-a');
    first.addLoadedChunk(new Uint8Array(2));
    first.failWithError({ type: 'peer-closed' });
    rig.requests.delete(rig.request.segment);
    rig.request = rig.makeRequest();
    const second = startPeer(rig, 'peer-b');
    second.addLoadedChunk(new Uint8Array(4));
    second.completeOnSuccess();
    const reading = value.read();
    const found = attempts(reading);
    assertEqual(found[0].bytes, 2, 'case (11): old attempt bytes');
    assertEqual(found[1].bytes, 4, 'case (11): new request bytes');
    assertEqual(JSON.stringify(reading.records.find((record) => record.kind === 'discard').attemptIds), JSON.stringify([1]), 'case (11): old attempt is request-dropped');
    assertSegment(reading, [2], 4, 'case (11)');
    assertEqual(JSON.stringify([...attemptDispositions(reading.records).values()]), JSON.stringify(['discarded', 'kept']), 'case (11): dispositions');
  });

  await check('peer-bytes P2P (12): an unfinished peer attempt remains open and is not invented as zero', async () => {
    const rig = createRig();
    const value = publisher(rig);
    const controls = startPeer(rig, 'peer-open');
    controls.addLoadedChunk(new Uint8Array(2));
    const reading = value.read();
    assertEqual(attempts(reading).length, 0, 'case (12): open attempt is not an ended record');
    assertEqual(reading.open.length, 1, 'case (12): one attempt is open');
    assertEqual(reading.open[0].bytesSoFar, 2, 'case (12): open bytes are the attempt’s live bytes');
    assertEqual(JSON.stringify(reading.kept), JSON.stringify({ hostBytes: 0, peerBytes: 0 }), 'case (12): no bytes are kept early');
    assertEqual(attemptDispositions(reading.records).size, 0, 'case (12): no disposition is fabricated');
  });

  await check('peer-bytes P2P (13): a stray peer chunk is counted outside attempts', async () => {
    const rig = createRig();
    const value = publisher(rig);
    rig.engine.dispatch('onChunkDownloaded', 7, 'p2p', 'peer-stray', 'main', 'info-hash');
    const reading = value.read();
    assertEqual(reading.chunkBytes.p2p['peer-stray'], 7, 'case (13): stray chunk is in peer totals');
    assertEqual(attempts(reading).length, 0, 'case (13): stray chunk creates no attempt');
    assertEqual(reading.records.length, 0, 'case (13): stray chunk creates no record');
  });

  await check('peer-bytes anomaly: unexplained held-byte movement is exactly one anomaly', async () => {
    const rig = createRig();
    const fake = { segment: rig.segment, loadedBytes: 0, progress: { startFromByte: 0, loadedBytes: 0 } };
    rig.requests.set(rig.segment, fake);
    const value = publisher(rig);
    rig.engine.dispatch('onSegmentStart', { segment: rig.segment, downloadSource: 'http', peerId: undefined });
    fake.loadedBytes = 9;
    fake.progress.loadedBytes = 3;
    rig.engine.dispatch('onSegmentError', { segment: rig.segment, downloadSource: 'http', peerId: undefined, error: { type: 'http-error' } });
    const reading = value.read();
    assertEqual(reading.records.filter((record) => record.kind === 'anomaly').length, 1, 'anomaly: exactly one anomaly');
    assertEqual(reading.records.filter((record) => record.kind === 'discard').length, 0, 'anomaly: no discard is guessed');
    assertEqual(attempts(reading)[0].bytes, 3, 'anomaly: added bytes are retained');
  });

  await check('peer-bytes unavailable: missing request path is null, never zero', async () => {
    const rig = createRig();
    rig.engine.core.mainStreamLoader = { requests: { requests: [] } };
    rig.engine.core.secondaryStreamLoader = undefined;
    const value = publisher(rig);
    rig.engine.dispatch('onSegmentStart', { segment: rig.segment, downloadSource: 'p2p', peerId: 'peer-a' });
    rig.engine.dispatch('onSegmentError', { segment: rig.segment, downloadSource: 'p2p', peerId: 'peer-a', error: { type: 'peer-closed' } });
    const reading = value.read();
    assertEqual(reading.attribution, 'unavailable', 'unavailable: attribution is explicit');
    assertEqual(attempts(reading)[0].bytes, null, 'unavailable: bytes are null');
    assertEqual(attempts(reading)[0].heldAtStartBytes, null, 'unavailable: held start is null');
    assertEqual(reading.records.filter((record) => record.kind === 'discard').length, 0, 'unavailable: no disposition is written');
  });

  await check('peer-bytes handler isolation: lookup errors are counted and later events still arrive', async () => {
    const rig = createRig();
    let shouldThrow = true;
    const map = rig.engine.core.mainStreamLoader.requests.requests;
    rig.engine.core.mainStreamLoader.requests = {
      get requests() {
        if (shouldThrow) throw new Error('lookup exploded');
        return map;
      },
    };
    const value = publisher(rig);
    rig.engine.dispatch('onSegmentStart', { segment: rig.segment, downloadSource: 'http', peerId: undefined });
    shouldThrow = false;
    const controls = startPeer(rig, 'peer-later');
    controls.addLoadedChunk(new Uint8Array(3));
    controls.completeOnSuccess();
    const reading = value.read();
    assertEqual(reading.errors.count, 1, 'isolation: lookup error is counted');
    assert(reading.errors.last.includes('lookup exploded'), 'isolation: last error has the message');
    assert(reading.records.some((record) => record.kind === 'segment'), 'isolation: later segment record arrives');
  });

  await check('peer-bytes mechanics: ring eviction, event totals and reads are copied', async () => {
    const rig = createRig();
    const value = publisher(rig, { capacity: 2 });
    rig.engine.dispatch('onPeerConnect', { peerId: 'peer-1' });
    rig.engine.dispatch('onChunkDownloaded', 5, 'http', undefined, 'main', 'info-hash');
    rig.engine.dispatch('onChunkUploaded', 9, 'peer-1', 'main', 'info-hash');
    rig.engine.dispatch('onPeerClose', { peerId: 'peer-1' });
    rig.engine.dispatch('onPeerConnect', { peerId: 'peer-2' });
    const reading = value.read(1);
    assertEqual(reading.latestSeq, 3, 'mechanics: three peer records have increasing sequence');
    assertEqual(reading.missed, 1, 'mechanics: capacity evicts one oldest record');
    assertEqual(JSON.stringify(reading.records.map((record) => record.seq)), JSON.stringify([2, 3]), 'mechanics: afterSeq selects retained records');
    assertEqual(reading.chunkBytes.http, 5, 'mechanics: HTTP chunks are cumulative');
    assertEqual(reading.uploadBytes['peer-1'], 9, 'mechanics: uploads are cumulative by peer');
    assertEqual(JSON.stringify(reading.connected), JSON.stringify(['peer-2']), 'mechanics: close removes a peer and connect adds one');
    reading.records[0].peerId = 'mutated';
    reading.chunkBytes.http = 100;
    reading.uploadBytes['peer-1'] = 100;
    reading.connected.push('mutated');
    const copied = value.read();
    assert(copied.records.every((record) => record.peerId !== 'mutated'), 'mechanics: record reads are copies');
    assertEqual(copied.chunkBytes.http, 5, 'mechanics: chunk totals are copied');
    assertEqual(copied.uploadBytes['peer-1'], 9, 'mechanics: upload totals are copied');
    assertEqual(JSON.stringify(copied.connected), JSON.stringify(['peer-2']), 'mechanics: connected is copied');
    let conflict;
    try {
      attemptDispositions([
        { kind: 'attempt', attemptId: 1, bytes: 1, source: 'http' },
        { kind: 'segment', keptAttemptIds: [1] },
        { kind: 'discard', attemptIds: [1], reason: 'cleared' },
      ]);
    } catch (error) {
      conflict = error;
    }
    assert(conflict instanceof Error, 'mechanics: conflicting disposition is a hard error');
  });
}

function recordsOf(reading, kind) {
  return reading.records.filter((record) => record.kind === kind);
}
