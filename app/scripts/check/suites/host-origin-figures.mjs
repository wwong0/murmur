import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHostAccounting } from '../../../public/lib/host-accounting.mjs';
import { assert, assertEqual, check } from '../harness.mjs';
import { recomputeRunDirectory, readRunDirectory } from '../../harness-figures.mjs';
import { computeFigures } from '../../figures/harness-figures.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WINDOW = { startMs: 100, endMs: 200, startSnapshotAtMs: 100, endSnapshotAtMs: 200 };
const TAGS = ['c01', 'c02'];
const METHOD = 'client-receipt-cohort-v1';

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value));
}

function writeNdjson(filePath, rows) {
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

function hostEvidence() {
  const accounting = createHostAccounting({ instanceId: 'figures-suite', wallNow: () => now });
  const channelKey = 'figures-channel';
  let id = 0;
  const responseIds = {};
  function complete(name, tag, urlPath, bytes) {
    const responseId = `figures:${++id}`;
    responseIds[name] = responseId;
    accounting.open({ channelKey, id, rid: responseId, path: urlPath, viewerTag: tag, expected: bytes });
    accounting.credited(channelKey, id, bytes);
    accounting.settleIfDone(channelKey, id, 0);
  }
  function aborted(name, tag, urlPath, expected, delivered) {
    const responseId = `figures:${++id}`;
    responseIds[name] = responseId;
    accounting.open({ channelKey, id, rid: responseId, path: urlPath, viewerTag: tag, expected });
    accounting.credited(channelKey, id, delivered);
    accounting.abort(channelKey, id);
    accounting.settleIfDone(channelKey, id, 0);
  }

  now = 50;
  complete('pre', 'c01', '/media/pre.m4s', 100);
  const originStart = accounting.snapshot();

  now = 150;
  complete('before', 'c01', '/media/before.m4s', 60);
  complete('after', 'c01', '/media/after.m4s', 70);
  complete('inside', 'c01', '/media/inside.m4s', 50);
  aborted('waste', 'c01', '/media/waste.m4s', 80, 30);
  complete('shared', 'c02', '/media/shared.m4s', 40);
  const originEnd = accounting.snapshot();

  const receipts = {
    c01: [
      { originResponseId: responseIds.pre, url: '/media/pre.m4s', bodyBytes: 100, endMs: 150, finished: true, canceled: false },
      { originResponseId: responseIds.before, url: '/media/before.m4s', bodyBytes: 60, endMs: 99, finished: true, canceled: false },
      { originResponseId: responseIds.after, url: '/media/after.m4s', bodyBytes: 70, endMs: 201, finished: true, canceled: false },
      { originResponseId: responseIds.inside, url: '/media/inside.m4s', bodyBytes: 50, endMs: 150, finished: true, canceled: false },
      { originResponseId: responseIds.waste, url: '/media/waste.m4s', bodyBytes: 30, endMs: 170, finished: false, canceled: true },
    ],
    c02: [
      { originResponseId: responseIds.shared, url: '/media/shared.m4s', bodyBytes: 40, endMs: 180, finished: true, canceled: false },
    ],
  };
  return { originStart, originEnd, receipts, responseIds };
}

function writeRun(runDir, evidence) {
  const manifest = {
    byteAccountingMethod: METHOD,
    condition: { name: 'host-figures', delivery: 'host', capacityMbps: 10, capacityBitsPerSecond: 10_000_000 },
    window: WINDOW,
    declaredClientTags: TAGS,
    content: { identity: 'constructed-host-content', frameRate: 24 },
    clients: Object.fromEntries(TAGS.map((tag) => [tag, { requestTimebase: 'measure-window' }])),
  };
  writeJson(path.join(runDir, 'manifest.json'), manifest);
  writeJson(path.join(runDir, 'origin-counters-start.json'), evidence.originStart);
  writeJson(path.join(runDir, 'origin-counters-end.json'), evidence.originEnd);
  for (const tag of TAGS) {
    writeNdjson(path.join(runDir, `client-${tag}.receipts.ndjson`), evidence.receipts[tag]);
    writeNdjson(path.join(runDir, `client-${tag}.requests.ndjson`), [{ url: `/media/${tag}-cdp.m4s`, bodyBytes: 999 }]);
  }
  writeNdjson(path.join(runDir, 'origin-link.ndjson'), [
    { atMs: 100, txBytes: 0, qdisc: { backlogBytes: 10, drops: 4, overlimits: 7 } },
    { atMs: 200, txBytes: 250_000, qdisc: { backlogBytes: 20, drops: 6, overlimits: 10 } },
  ]);
}

let now = 0;

export default async function hostOriginFiguresSuite() {
  await check('host-origin figures: host manifests select receipts and retain CDP requests separately', async () => {
    const root = path.join(APP_ROOT, '.tmp');
    fs.mkdirSync(root, { recursive: true });
    const runDir = fs.mkdtempSync(path.join(root, 'host-origin-figures-reader-'));
    try {
      const evidence = hostEvidence();
      writeRun(runDir, evidence);
      const retained = readRunDirectory(runDir);
      assertEqual(retained.manifest.condition.delivery, 'host', 'host delivery is retained in the manifest');
      assertEqual(retained.input.clients.c01.requests.length, 5, 'host figures use the receipts stream for requests');
      assertEqual(retained.input.clients.c01.requests[0].originResponseId, evidence.responseIds.pre, 'receipt identity is retained');
      assertEqual(retained.input.clients.c01.httpRequests.length, 1, 'the CDP stream remains readable as httpRequests');
      assertEqual(retained.input.clients.c01.httpRequests[0].bodyBytes, 999, 'httpRequests does not replace receipts');
      const missing = structuredClone(retained.manifest);
      delete missing.condition.delivery;
      writeJson(path.join(runDir, 'manifest.json'), missing);
      const legacy = readRunDirectory(runDir);
      assertEqual(legacy.input.clients.c01.requests[0].originResponseId, undefined, 'no-delivery manifests keep the legacy CDP request path');
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });

  await check('host-origin figures: windowed host arithmetic joins receipt boundaries exactly', async () => {
    const root = path.join(APP_ROOT, '.tmp');
    fs.mkdirSync(root, { recursive: true });
    const runDir = fs.mkdtempSync(path.join(root, 'host-origin-figures-values-'));
    try {
      const evidence = hostEvidence();
      writeRun(runDir, evidence);
      const retained = readRunDirectory(runDir);
      const figures = computeFigures(retained.input);
      const expectedCohort = {
        c01: { originCompletedBytes: 150, clientCompletedBytes: 150, completedResponses: 2 },
        c02: { originCompletedBytes: 40, clientCompletedBytes: 40, completedResponses: 1 },
      };
      const expectedAgreement = {
        c01: { differenceBytes: 0, differenceFraction: 0 },
        c02: { differenceBytes: 0, differenceFraction: 0 },
      };
      assertEqual(figures.hostUploadMultiplier, 250 / 190, '220 complete and 30 aborted delivered bytes divide by the 190-byte receipt union');
      assertEqual(figures.originWasteFraction, 30 / 250, 'aborted delivered bytes are 30 of 250 origin bytes in the window');
      assertEqual(JSON.stringify(figures.originVsClientBytesByClient), JSON.stringify(expectedAgreement), 'origin/client agreement is exact for both clients');
      assertEqual(JSON.stringify(figures.completedResponseCohortByClient), JSON.stringify(expectedCohort), 'receipt cohort uses originEnd bytes and both viewer boundaries');
      assertEqual(figures.distinctSegmentsCompletedInWindow, 3, 'pre-window host completion and two in-window receipts form three segments');
      assertEqual(figures.distinctSegmentBytesConsumedInWindow, 190, 'the distinct denominator is the hand-computed receipt union');
      assertEqual(figures.originSegmentBytesDeliveredInWindow, 250, 'origin segment bytes include both boundary-excluded responses and delivered waste');
      assertEqual(figures.distinctSegmentsPartialOnlyInWindow, 1, 'the aborted response is the one partial-only path');
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });

  await check('host-origin figures: retained 6a publication is unchanged by the reader edit', async () => {
    const runDir = path.join(APP_ROOT, 'results', '6a-repair-final-baseline-nop2p');
    const stored = JSON.parse(fs.readFileSync(path.join(runDir, 'published-figures.json'), 'utf8'));
    const recomputed = recomputeRunDirectory(runDir).publishedByte;
    const storedKeys = new Set(Object.keys(stored));
    const recomputedKeys = new Set(Object.keys(recomputed));
    for (const key of storedKeys) {
      assert(recomputedKeys.has(key), `retained publication key ${key} is still recomputed`);
      assertEqual(JSON.stringify(recomputed[key]), JSON.stringify(stored[key]), `retained publication value ${key} is unchanged`);
    }
    const missingFromStored = [...recomputedKeys].filter((key) => !storedKeys.has(key));
    const missingFromRecomputed = [...storedKeys].filter((key) => !recomputedKeys.has(key));
    assertEqual(JSON.stringify(missingFromStored), JSON.stringify(['capacityBitsPerSecond']), 'the only pre-existing recompute key is capacityBitsPerSecond');
    assertEqual(JSON.stringify(missingFromRecomputed), JSON.stringify([]), 'no stored publication key disappeared');
    const comparable = Object.fromEntries([...storedKeys].map((key) => [key, recomputed[key]]));
    assertEqual(JSON.stringify(comparable), JSON.stringify(stored), 'the stored publication deep-equals the recomputed stored-key projection');
  });
}
