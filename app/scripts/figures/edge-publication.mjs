// 9b design.md D7: one block of a run's report, `figures.edge`, holding what is
// published beside the criteria. Only a condition registered under 9b carries it,
// so a run retained before it recomputes to the bytes it gave.

import fs from 'node:fs';
import path from 'node:path';
import { parseRate } from '../../harness/apply-qdisc.mjs';
import { aheadWhenRecovered, hostCopies, prefetchWait, roomPosition, slowExit } from './edge-figures.mjs';
import { edgeReading } from './edge-reading.mjs';
import { scheduleRecovery } from './schedule-recovery.mjs';

const finite = (value) => Number.isFinite(value);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function readNdjson(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; }
}

/** The retained files T6 added, read for one run directory. */
export function readEdgeEvidence(runDir, tags) {
  const health = readJson(path.join(runDir, 'viewer-asks-health.json'));
  return {
    askHealth: health,
    asksByClient: Object.fromEntries(tags.map((tag) => [tag, health?.[tag]
      ? { ...health[tag], records: readNdjson(path.join(runDir, `viewer-asks-${tag}.ndjson`)) } : null])),
    hostStats: { start: readJson(path.join(runDir, 'host-stats-start.json')), end: readJson(path.join(runDir, 'host-stats-end.json')) },
    assignmentControl: readJson(path.join(runDir, 'assignment-control.json')),
    peerBoundaries: { start: readJson(path.join(runDir, 'peer-boundary-start.json')), end: readJson(path.join(runDir, 'peer-boundary-end.json')) },
  };
}

const records = (snapshot) => (snapshot?.counters ?? snapshot ?? {}).responseRecords ?? [];
const uploaded = (boundary, tag) => Object.values(boundary?.clients?.[tag]?.uploadBytes ?? {}).reduce((sum, value) => sum + value, 0);

// The viewers whose own egress is declared below the fastest viewer's.
function slowTags(condition) {
  const rates = (condition?.qdiscs ?? []).filter((row) => /^c\d+$/.test(row.container ?? '') && row.discipline === 'tbf')
    .map((row) => ({ tag: row.container, rate: parseRate(row.params?.rate) })).filter((row) => finite(row.rate));
  const fastest = Math.max(...rates.map((row) => row.rate));
  return rates.filter((row) => row.rate < fastest).map((row) => row.tag);
}

export function computeEdgeFigures({ input = {}, control = null, evidence = {} } = {}) {
  if (!edgeReading(input.condition?.reading)) return null;
  const reading = input.condition.reading;
  const tags = input.declaredClientTags ?? Object.keys(input.clients ?? {});
  const window = input.window;
  // Responses settled between the two boundaries, the qualification's left out, as the byte figures count them.
  const before = new Set(records(input.originStart).map((record) => record.originResponseId));
  const qualificationId = input.cdpQualification?.receipt?.originResponseId;
  const hostResponses = records(input.originEnd).filter((record) => record.originResponseId
    && !before.has(record.originResponseId) && record.originResponseId !== qualificationId);
  const receiptsByClient = Object.fromEntries(tags.map((tag) => [tag, input.clients?.[tag]?.requests ?? []]));
  const asksByClient = evidence.asksByClient ?? {};
  const wallOffsetMsByClient = Object.fromEntries(tags.map((tag) => [tag, asksByClient[tag]?.wallOffsetMs ?? 0]));
  const slow = slowTags(input.condition);
  const recordingEnd = control?.recordingEndHarnessMs ?? null;
  return {
    hostCopies: hostCopies({ asksByClient, hostResponses, segmentSizes: input.content?.segmentSizes ?? input.segmentSizes ?? [],
      window, control: input.condition.assignmentControl ?? 'product', receiptsByClient }),
    prefetchWait: prefetchWait({ receiptsByClient, viewerPolls: input.viewerPolls, window, edgeMsBelow: reading.behindHeldAheadMsBelow, wallOffsetMsByClient }),
    roomPosition: roomPosition({ clients: input.clients, tags, hostPoll: input.hostPoll ?? [], window,
      offsetMs: control?.timebase?.offsetMs ?? 0, scatteredSpreadMsAbove: reading.scatteredSpreadMsAbove }),
    aheadWhenRecovered: Object.fromEntries(['start', 'seek'].map((kind) => [kind, aheadWhenRecovered({ recovery: control?.recovery?.[kind],
      viewerPolls: input.viewerPolls, tags, aheadMsMin: reading.aheadMsMin })])),
    dropRecovery: input.capacitySchedule ? scheduleRecovery({ input, recordingEnd }) : null,
    slowExit: slowExit({ asksByClient, window, slowTags: slow, uploadBytesByClient: Object.fromEntries(slow.map((tag) => [tag,
      evidence.peerBoundaries?.start && evidence.peerBoundaries?.end ? uploaded(evidence.peerBoundaries.end, tag) - uploaded(evidence.peerBoundaries.start, tag) : null])) }),
    askHealth: evidence.askHealth ?? null,
    hostStats: evidence.hostStats ?? null,
    assignmentControl: evidence.assignmentControl ?? null,
  };
}
