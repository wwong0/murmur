import { REFUSAL_REASONS } from './frame-drift.mjs';
import { driftLineForm } from './drift-readout.mjs';
import { CLOCK_LINE_RE, CLOCK_LINE_NO_ESTIMATE, CONTROLLER_LINE_HELD_RE, CONTROLLER_LINE_ACTING_RE, CONTROLLER_LINE_TREATMENT_FAULT_RE } from './diagnostics-overlay.mjs';
import { BYTES_LINE_RE, BYTES_LINE_NOTHING_KEPT_RE, BYTES_LINE_OFF, BYTES_LINE_HOST, BYTES_LINE_UNAVAILABLE } from './bytes-readout.mjs';
import { START_WAIT_LINE_RE, START_WAIT_LINE_WAITING } from './start-wait.mjs';
import { LINKS_LINE_RE } from './link-kinds.mjs';
import { WAITING_PAUSED, WAITING_HELD, WAITING_PREPARING, WAITING_REFUSED } from './playback-start.mjs';

// Copies of playback-treatment.mjs's TREATMENT_FAULT_MODE and FAULT_REASONS: importing that module
// puts it in the research bundles, which must replace it whole. The stats-export suite holds them equal.
const TREATMENT_FAULT_MODE = 'treatment-fault';
const FAULT_REASONS = ['pitch-lost', 'pitch-missing', 'pitch-unreadable'];

export const CLOSED_SETS = Object.freeze({
  role: new Set(['host', 'viewer']),
  peerExchange: new Set(['off', 'on', 'host']),
  attribution: new Set(['unavailable', 'engine-request']),
  measurementLimit: new Set(['clock', 'dispersion', 'clock-and-dispersion']),
  mode: new Set(['waiting', 'stale', 'resolution-budget-hold', 'correcting', 'beyond-rate-authority', 'settled', 'declining', TREATMENT_FAULT_MODE]),
  reason: new Set(['no-clock', 'no-records', 'too-few-records', 'stopping-threshold-over-budget', 'measurement-limit', 'actuator-limit', ...FAULT_REASONS]),
  waiting: new Set([WAITING_PAUSED, WAITING_HELD, WAITING_PREPARING, WAITING_REFUSED]),
  notice: new Set(['connected', 'disconnected', 'reconnecting', 'joined', 'superseded', 'join-refused', 'refused', 'gap', 'presence-join', 'presence-leave', 'presence-name', 'presence', 'player-error', 'operation-rejected', 'playback-opened', 'host-link', 'far-skip', 'play-failed', 'settings-unavailable', 'urgent-request', 'failure', 'other']),
});

const num = (value) => Number.isFinite(value) ? value : null;
const bool = (value) => typeof value === 'boolean' ? value : null;
const oneOf = (value, set) => set.has(value) ? value : value == null ? null : 'other';
const numbers = (source, keys) => Object.fromEntries(keys.map((key) => [key, num(source?.[key])]));
const summaryKeys = ['framesHeld', 'framesOffered', 'capacity', 'medianDriftMs', 'p99DriftMs', 'maxAbsDriftMs'];
const recordKeys = ['seq', 'driftMs', 'mediaMs', 'scheduledMediaMs', 'placementMs', 'presentedFrames'];
const clockKeys = ['offsetMs', 'halfWidthMs', 'delayTermMs', 'ageTermMs', 'sampleCount'];
const controllerKeys = ['rate', 'estimateMs', 'bandMs', 'spreadMs', 'halfWidthMs', 'actuatorAllowanceMs', 'requiredStoppingThresholdMs', 'stoppingThresholdMs', 'windowRecords', 'controlRecords', 'correctionsApplied', 'polls', 'settlingMs', 'fastestCloseMs'];
const dropKeys = ['seam', 'reanchor', 'stale'];
const noticePatterns = [
  [/^connected$/, 'connected'], [/^disconnected$/, 'disconnected'], [/^reconnecting in \d+ms$/, 'reconnecting'],
  [/^joined as /, 'joined'], [/^superseded by /, 'superseded'], [/^join refused: /, 'join-refused'],
  [/^refused \(/, 'refused'], [/^gap detected: /, 'gap'], [/^presence: join /, 'presence-join'],
  [/^presence: leave /, 'presence-leave'], [/^presence: name /, 'presence-name'], [/^presence: /, 'presence'],
  [/^player error: /, 'player-error'], [/^your \S+ was rejected: /, 'operation-rejected'],
  [/^playback opened at /, 'playback-opened'], [/^host link: /, 'host-link'], [/^far skip: /, 'far-skip'],
  [/^play\(\) failed: /, 'play-failed'], [/^settings unavailable: /, 'settings-unavailable'],
  [/^urgent request: /, 'urgent-request'], [/ failed: /, 'failure'],
];

function noticeKind(text) {
  if (typeof text !== 'string') return 'other';
  const content = text.replace(/^\[[^\]]+\] /, '');
  return noticePatterns.find(([pattern]) => pattern.test(content))?.[1] ?? 'other';
}

function lines(source) {
  const line = (value, patterns, literals = []) => typeof value === 'string'
    && (literals.includes(value) || patterns.some((pattern) => pattern.test(value))) ? value : null;
  return {
    clock: line(source?.clock, [CLOCK_LINE_RE], [CLOCK_LINE_NO_ESTIMATE]),
    drift: driftLineForm(source?.drift) !== null ? source.drift : null,
    bytes: line(source?.bytes, [BYTES_LINE_RE, BYTES_LINE_NOTHING_KEPT_RE], [BYTES_LINE_OFF, BYTES_LINE_HOST, BYTES_LINE_UNAVAILABLE]),
    controller: line(source?.controller, [CONTROLLER_LINE_HELD_RE, CONTROLLER_LINE_ACTING_RE, CONTROLLER_LINE_TREATMENT_FAULT_RE]),
    startWait: line(source?.startWait, [START_WAIT_LINE_RE], [START_WAIT_LINE_WAITING]),
    links: line(source?.links, [LINKS_LINE_RE]),
  };
}

function drift(read, summary, origin) {
  if (!read && !summary) return null;
  return {
    summary: numbers(summary, summaryKeys),
    counters: numbers(read?.counters, ['framesOffered', ...REFUSAL_REASONS]),
    missed: num(read?.missed),
    records: (read?.records ?? []).map((record) => {
      const parts = [record?.displaySharedMs, record?.clock?.offsetMs, origin];
      return { ...numbers(record, recordKeys), atMs: parts.every(Number.isFinite) ? num(parts[0] - parts[1] - parts[2]) : null, ...numbers(record?.clock, clockKeys) };
    }),
  };
}

function bytes(source) {
  if (!source) return null;
  const received = source.chunkBytes?.p2p ?? {};
  const uploaded = source.uploadBytes ?? {};
  const ids = [...new Set([...(source.peerIds ?? []), ...(source.connected ?? []), ...Object.keys(received), ...Object.keys(uploaded)])];
  const uploadValues = Object.values(uploaded);
  return {
    peerExchange: oneOf(source.peerExchange, CLOSED_SETS.peerExchange),
    attribution: oneOf(source.attribution, CLOSED_SETS.attribution),
    hostBytes: num(source.kept?.hostBytes), peerBytes: num(source.kept?.peerBytes),
    uploadedBytes: num(uploadValues.reduce((sum, value) => sum + value, 0)),
    connectedPeers: Array.isArray(source.connected) ? source.connected.length : null,
    peers: ids.map((id, index) => ({ peer: index + 1, receivedBytes: num(received[id]) ?? 0, uploadedBytes: num(uploaded[id]) ?? 0 })),
  };
}

function controller(source) {
  if (!source) return null;
  return {
    ...numbers(source, controllerKeys), thresholdUsable: bool(source.thresholdUsable), controllerActive: bool(source.controllerActive),
    measurementLimit: oneOf(source.measurementLimit, CLOSED_SETS.measurementLimit),
    mode: oneOf(source.mode, CLOSED_SETS.mode), reason: oneOf(source.reason, CLOSED_SETS.reason),
    drops: numbers(source.counters?.drops, dropKeys),
    settings: Object.fromEntries(Object.entries(source.settings ?? {}).filter(([key, value]) => /^[A-Z][A-Z0-9_]*$/.test(key) && Number.isFinite(value))),
  };
}

export function buildStatsExport(sources = {}) {
  const host = sources.hostStats;
  const stalls = sources.stalls;
  return {
    format: 'murmur-stats-1',
    build: typeof sources.build === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z-[0-9a-z]+$/.test(sources.build) ? sources.build : null,
    role: oneOf(sources.role, CLOSED_SETS.role), exportedAtMs: num(sources.nowMs),
    lines: lines(sources.lines), drift: drift(sources.driftRead, sources.driftSummary, sources.timeOriginMs),
    startWait: { waitMs: num(sources.startWaitMs) }, bytes: bytes(sources.peerBytes),
    host: host ? { ...numbers(host, ['protocolErrors', 'responses', 'urgentResponses', 'nearResponses']), channels: num(typeof host.channels === 'number' ? host.channels : host.channels?.size ?? host.channels?.length) } : null,
    controller: controller(sources.controller),
    playback: sources.playback ? { waiting: oneOf(sources.playback.waiting, CLOSED_SETS.waiting), starts: num(sources.playback.starts), callbacks: num(sources.playback.callbacks) } : null,
    stalls: stalls ? { ...numbers(stalls, ['count', 'totalMs', 'evicted']), open: stalls.open ? { atMs: num(stalls.open.atMs) } : null, records: (stalls.records ?? []).map((record) => numbers(record, ['atMs', 'durationMs'])) } : null,
    notices: sources.notices ? sources.notices.map((notice) => ({ atMs: num(notice.atMs), warn: notice.warn === true, kind: noticeKind(notice.text) })) : null,
  };
}
