import { assert, assertEqual, check } from '../harness.mjs';
import { attemptDispositions, createPeerBytes, keptBytes } from '../../../public/lib/peer-bytes.mjs';
import { coreFiles, createRig, executeHttp, fileText, response, packageVersion } from '../peer-bytes-fixture.mjs';

const bytes = (length) => Array.from({ length }, (_, index) => index + 1);

function publisher(rig) {
  let now = 1000;
  const value = createPeerBytes({ wallNow: () => ++now });
  value.attach(rig.engine);
  return value;
}

function records(reading, kind) {
  return reading.records.filter((record) => record.kind === kind);
}

function assertAttempt(record, expected, label) {
  assertEqual(record.bytes, expected.bytes, `${label}: attempt bytes`);
  assertEqual(record.end, expected.end, `${label}: attempt end`);
  assertEqual(record.heldAtStartBytes, expected.start, `${label}: held bytes at start`);
  assertEqual(record.heldAtEndBytes, expected.endHeld, `${label}: held bytes at end`);
}

function assertReading(reading, expected, label) {
  const attempts = records(reading, 'attempt');
  assertEqual(attempts.length, expected.attempts.length, `${label}: attempt count`);
  expected.attempts.forEach((attempt, index) => assertAttempt(attempts[index], attempt, `${label} #${index + 1}`));
  const segments = records(reading, 'segment');
  assertEqual(segments.length, expected.segments.length, `${label}: segment count`);
  expected.segments.forEach((segment, index) => {
    assertEqual(JSON.stringify(segments[index].keptAttemptIds), JSON.stringify(segment.ids), `${label}: kept attempt ids`);
    assertEqual(segments[index].keptSumBytes, segment.sum, `${label}: kept sum`);
    assertEqual(segments[index].lengthBytes, segment.length, `${label}: segment length`);
  });
  assertEqual(records(reading, 'anomaly').length, 0, `${label}: no anomaly records`);
  assertEqual(JSON.stringify(reading.kept), JSON.stringify(expected.kept), `${label}: running kept bytes`);
  assertEqual(JSON.stringify(keptBytes(reading.records)), JSON.stringify(expected.kept), `${label}: pure kept bytes`);
  const dispositions = attemptDispositions(reading.records);
  assertEqual(JSON.stringify([...dispositions.values()]), JSON.stringify(expected.dispositions), `${label}: dispositions`);
}

async function resumedHttpCase(replies, byteRange = { start: 0, end: 5 }) {
  const rig = createRig({ byteRange });
  const value = publisher(rig);
  for (const reply of replies) await executeHttp(rig, [reply]);
  return value.read();
}

export async function peerBytesHttpSuite() {
  await check('peer-bytes HTTP (1): a whole segment is one kept attempt', async () => {
    const rig = createRig();
    const value = publisher(rig);
    await executeHttp(rig, [response(bytes(4), { headers: { 'Content-Length': '4' } })]);
    assertReading(value.read(), {
      attempts: [{ bytes: 4, end: 'loaded', start: 0, endHeld: 4 }],
      segments: [{ ids: [1], sum: 4, length: 4 }],
      kept: { hostBytes: 4, peerBytes: 0 },
      dispositions: ['kept'],
    }, 'case (1)');
  });

  await check('peer-bytes HTTP (2): truncated body resumes with 206 and keeps both attempts', async () => {
    const rig = createRig({ byteRange: { start: 0, end: 5 } });
    const value = publisher(rig);
    await executeHttp(rig, [response(bytes(2), { status: 206, headers: { 'Content-Length': '6', 'Content-Range': 'bytes 0-5/6' } })]);
    await executeHttp(rig, [response(bytes(4), { status: 206, headers: { 'Content-Length': '4', 'Content-Range': 'bytes 2-5/6' } })]);
    assertReading(value.read(), {
      attempts: [
        { bytes: 2, end: 'error:http-bytes-mismatch', start: 0, endHeld: 2 },
        { bytes: 4, end: 'loaded', start: 2, endHeld: 6 },
      ],
      segments: [{ ids: [1, 2], sum: 6, length: 6 }],
      kept: { hostBytes: 6, peerBytes: 0 },
      dispositions: ['kept', 'kept'],
    }, 'case (2)');
  });

  await check('peer-bytes HTTP (3): a resumed range answered 200 clears held bytes', async () => {
    const rig = createRig();
    const value = publisher(rig);
    await executeHttp(rig, [response(bytes(2), { headers: { 'Content-Length': '6' } })]);
    await executeHttp(rig, [response(bytes(6), { headers: { 'Content-Length': '6' } })]);
    assertReading(value.read(), {
      attempts: [
        { bytes: 2, end: 'error:http-bytes-mismatch', start: 0, endHeld: 2 },
        { bytes: 6, end: 'loaded', start: 2, endHeld: 6 },
      ],
      segments: [{ ids: [2], sum: 6, length: 6 }],
      kept: { hostBytes: 6, peerBytes: 0 },
      dispositions: ['discarded', 'kept'],
    }, 'case (3)');
  });

  await check('peer-bytes HTTP (4): 416 clears a resumed request', async () => {
    const rig = createRig({ byteRange: { start: 0, end: 5 } });
    const value = publisher(rig);
    await executeHttp(rig, [response(bytes(2), { status: 206, headers: { 'Content-Length': '6', 'Content-Range': 'bytes 0-5/6' } })]);
    await executeHttp(rig, [response([], { status: 416 })]);
    const reading = value.read();
    assertReading(reading, {
      attempts: [
        { bytes: 2, end: 'error:http-bytes-mismatch', start: 0, endHeld: 2 },
        { bytes: 0, end: 'error:http-bytes-mismatch', start: 2, endHeld: 0 },
      ],
      segments: [],
      kept: { hostBytes: 0, peerBytes: 0 },
      dispositions: ['discarded', 'abandoned'],
    }, 'case (4)');
  });

  await check('peer-bytes HTTP (5): Content-Length mismatch clears the resumed request', async () => {
    const rig = createRig({ byteRange: { start: 0, end: 5 } });
    const value = publisher(rig);
    await executeHttp(rig, [response(bytes(2), { status: 206, headers: { 'Content-Length': '6', 'Content-Range': 'bytes 0-5/6' } })]);
    await executeHttp(rig, [response([], { status: 206, headers: { 'Content-Length': '3', 'Content-Range': 'bytes 2-5/6' } })]);
    const reading = value.read();
    assertReading(reading, {
      attempts: [
        { bytes: 2, end: 'error:http-bytes-mismatch', start: 0, endHeld: 2 },
        { bytes: 0, end: 'error:http-bytes-mismatch', start: 2, endHeld: 0 },
      ],
      segments: [],
      kept: { hostBytes: 0, peerBytes: 0 },
      dispositions: ['discarded', 'abandoned'],
    }, 'case (5)');
  });

  await check('peer-bytes HTTP (6): Content-Range start mismatch clears held bytes', async () => {
    const rig = createRig({ byteRange: { start: 0, end: 5 } });
    const value = publisher(rig);
    await executeHttp(rig, [response(bytes(2), { status: 206, headers: { 'Content-Length': '6', 'Content-Range': 'bytes 0-5/6' } })]);
    await executeHttp(rig, [response([], { status: 206, headers: { 'Content-Length': '4', 'Content-Range': 'bytes 3-6/6' } })]);
    const reading = value.read();
    assertReading(reading, {
      attempts: [
        { bytes: 2, end: 'error:http-bytes-mismatch', start: 0, endHeld: 2 },
        { bytes: 0, end: 'error:http-bytes-mismatch', start: 2, endHeld: 0 },
      ],
      segments: [],
      kept: { hostBytes: 0, peerBytes: 0 },
      dispositions: ['discarded', 'abandoned'],
    }, 'case (6)');
  });

  await check('peer-bytes pin: the installed engine and lookup property names are exact', async () => {
    assertEqual(packageVersion('p2p-media-loader-core'), '3.0.1', 'core package pin');
    assertEqual(packageVersion('p2p-media-loader-hlsjs'), '3.0.1', 'hlsjs adapter package pin');
    assertEqual(packageVersion('hls.js'), '1.7.1', 'hls.js package pin');
    const core = fileText(coreFiles.core);
    const hybrid = fileText(coreFiles.hybrid);
    const container = fileText(coreFiles.container);
    const request = fileText(coreFiles.request);
    assert(core.includes('mainStreamLoader'), 'compiled core exposes mainStreamLoader');
    assert(hybrid.includes('this.requests = new RequestsContainer'), 'compiled hybrid loader creates requests container');
    assert(container.includes('new Map'), 'compiled requests container owns a Map');
    assert(request.includes('startFromByte'), 'compiled Request exposes startFromByte progress');
  });
}
