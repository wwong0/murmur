import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCdpQualification, validateLinkReceiptQualification, CDP_QUALIFICATION_REASON, LINK_RECEIPT_QUALIFICATION_REASON, QUALIFICATION_FETCH_TIMEOUT } from './qualification.mjs';
import { peerPageReadingExpression } from './cdp-records.mjs';
import { viewerHttpLeak, uplinkVersusDelivered } from '../figures/host-origin-checks.mjs';
import { declaresResponseSettle } from '../figures/peer-evidence.mjs';
import { CEILING_MS } from '../harness-cadence.mjs';
import { ENGINE_WINDOW_DEFAULTS, PRODUCT_ENGINE_WINDOWS } from '../../public/lib/engine-windows.mjs';
import { HEADROOM_DEFAULT } from '../../public/lib/send-pace.mjs';
import { evidenceRefusals } from './control-evidence.mjs';
import { controlInjection, controlRefusals } from './assignment-control.mjs';

export const REFUSAL_SCOPE = Object.freeze({
  neverPlayed: Object.freeze(['byte', 'drift']),
  noRecords: Object.freeze(['drift']),
  coverage: Object.freeze(['drift']),
  evicted: Object.freeze(['drift']),
  driftEvidence: Object.freeze(['drift']),
  qualityEvidence: Object.freeze(['byte', 'drift']),
  droppedFrames: Object.freeze(['byte', 'drift']),
  unattributed: Object.freeze(['byte']),
  tabCollision: Object.freeze(['byte', 'drift']),
  runDirectory: Object.freeze([]),
  publication: Object.freeze(['byte']),
  cdpQualification: Object.freeze(['byte']),
  hostLeak: Object.freeze(['byte']),
  hostUplink: Object.freeze(['byte']),
  receiptHealth: Object.freeze(['byte']),
  cadence: Object.freeze(['byte', 'drift']),
  startWait: Object.freeze(['byte', 'drift']),
  peerExchange: Object.freeze(['byte']),
  peerAttribution: Object.freeze(['byte']),
  peerLog: Object.freeze(['byte']),
  peerAnomaly: Object.freeze(['byte']),
  peerCohort: Object.freeze(['byte']),
  peerCheck: Object.freeze(['byte']),
  peerTolerance: Object.freeze(['byte']),
  responseSettle: Object.freeze(['byte']),
  viewerInterface: Object.freeze(['byte']),
  positionOffset: Object.freeze(['byte', 'drift']),
  engineWindows: Object.freeze(['byte', 'drift']),
  headroom: Object.freeze(['byte', 'drift']),
  capacityStep: Object.freeze(['byte', 'drift']),
  seek: Object.freeze(['byte', 'drift']),
  build: Object.freeze(['byte', 'drift']),
  churn: Object.freeze(['byte', 'drift']),
  topology: Object.freeze(['byte', 'drift']),
  control: Object.freeze(['byte', 'drift']),
});

const finite = (value) => Number.isFinite(value);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const STEADY_BAR_NAMES = Object.freeze(['steadyUtilisationMax', 'steadyDownloadRatioMin',
  'steadyDownloadRatioMax', 'steadyRealtimeMin']);

function declaresSteadyBars(condition = {}) {
  return STEADY_BAR_NAMES.every((name) => finite(condition.bars?.[name]));
}

/** The declared clients' tags, c01 upward. */
export function clientTags(condition) {
  return Array.from({ length: Number(condition?.clients) || 0 }, (_, index) => `c${String(index + 1).padStart(2, '0')}`);
}

function members(condition, hostTag) {
  const tags = clientTags(condition);
  const roles = tags.map((tag, index) => hostTag || index > 0 ? 'viewer' : 'host');
  if (hostTag) return { hostTag, tags, roles, declaredTags: [hostTag, ...tags], declaredRoles: ['host', ...roles] };
  return { hostTag: null, tags, roles, declaredTags: tags, declaredRoles: roles };
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

const STEP0_CONTENT_MANIFEST = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../../../step0/content/content-manifest.json');
const BUNDLE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/room.bundle.js');

export function readBundleBuildId(file = BUNDLE_PATH) {
  try {
    const source = fs.readFileSync(file, 'utf8');
    return source.match(/\bBUILD_ID\s*=\s*["']([^"']+)["']/)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function readPageBuildId(session) {
  try {
    const value = await session.tab.evaluate('window.__app && typeof window.__app.buildId === "string" ? window.__app.buildId : null');
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

async function recordPageBuildIds(kind, { sessions = [], hostSession = null, runDir }) {
  const host = hostSession ?? sessions.find((session) => session.role === 'host') ?? null;
  const viewers = sessions.filter((session) => session.role === 'viewer');
  const hostBuildId = host ? await readPageBuildId(host) : null;
  const viewerBuildIds = Object.fromEntries(await Promise.all(viewers.map(async (session) => {
    const buildId = await readPageBuildId(session);
    session.pageBuildId = buildId;
    return [session.tag, buildId];
  })));
  if (host) host.pageBuildId = hostBuildId;
  // Read at the boundary: a later recompute must not judge the run by a later build.
  const identity = { host: hostBuildId, viewers: viewerBuildIds, disk: readBundleBuildId() };
  writeJson(path.join(runDir, `build-ids-${kind}.json`), identity);
  return identity;
}

function buildIdentityFromRun(runDir) {
  const identity = readJson(path.join(runDir, 'build-ids-end.json'))
    ?? readJson(path.join(runDir, 'build-ids-start.json'));
  return identity ?? null;
}

export function buildRefusalDetails(identity) {
  if (!identity) return [];
  const details = [];
  const hostBuildId = identity.host ?? null;
  const diskBuildId = identity.disk ?? null;
  for (const [tag, viewerBuildId] of Object.entries(identity.viewers ?? {})) {
    if (hostBuildId === null || viewerBuildId === null || hostBuildId !== viewerBuildId) {
      details.push({ pair: 'host-viewer', viewer: tag, hostBuildId, viewerBuildId });
    }
    if (viewerBuildId === null || diskBuildId === null || viewerBuildId !== diskBuildId) {
      details.push({ pair: 'viewer-disk', viewer: tag, viewerBuildId, diskBuildId });
    }
  }
  if (hostBuildId === null || diskBuildId === null || hostBuildId !== diskBuildId) {
    details.push({ pair: 'host-disk', hostBuildId, diskBuildId });
  }
  return details;
}

function buildRefusals(input, addReason) {
  if (!input.buildIdentity) return;
  for (const detail of buildRefusalDetails(input.buildIdentity)) {
    addReason('build-mismatch', REFUSAL_SCOPE.build, detail);
  }
}

function contentManifestOf(manifest) {
  return readJson(manifest.content?.manifestPath ?? STEP0_CONTENT_MANIFEST);
}

function recomputePeerContent(manifest) {
  const contentManifest = contentManifestOf(manifest);
  if (!Array.isArray(contentManifest?.segmentSizes)) throw new Error('content segmentSizes are unavailable');
  return { ...manifest.content, segmentSizes: contentManifest.segmentSizes };
}

function recomputePeerSegmentSeconds(manifest) {
  const contentManifest = contentManifestOf(manifest);
  if (!finite(contentManifest?.segmentSeconds) || contentManifest.segmentSeconds <= 0) {
    throw new Error('content segment seconds are unavailable');
  }
  return contentManifest.segmentSeconds;
}

function readNdjson(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function failedQualification(reason) {
  return { status: 'failed', reason };
}

/** Runs a qualifier, turning a missing input, no result or a throw into a failed record. */
async function qualifyWith(unavailable, qualify) {
  if (unavailable) return failedQualification(`qualification-unavailable:${unavailable}`);
  try {
    return await qualify() ?? failedQualification('qualification-failed:no-result');
  } catch (error) {
    // A starved fetch is a runner fault, not evidence to refuse on (9b design.md D1).
    if (error?.code === QUALIFICATION_FETCH_TIMEOUT) throw error;
    return failedQualification(`qualification-error:${error?.message ?? String(error)}`);
  }
}

function qualificationRefusal(input, addReason, validate, reason) {
  const condition = input.condition ?? {};
  if (!(condition.publishes === true || input.requireCdpQualification === true)) return;
  const qualification = validate(input.cdpQualification);
  if (!qualification.valid) {
    addReason(reason, REFUSAL_SCOPE.cdpQualification, {
      field: 'cdpQualification',
      figure: 'byte',
      evidence: qualification,
    });
  }
}

function clientStreams(runDir, manifest, files, host, peer = false) {
  const names = files.names ?? [];
  const read = files.readNdjson;
  const join = files.join;
  const tags = manifest.declaredClientTags ?? manifest.clientTags ?? manifest.condition?.clientTags
    ?? names.map((name) => name.match(/^client-(.+)\.(?:drift|poll|requests|echo)\.ndjson$/)?.[1]).filter(Boolean);
  const totalsA = peer ? readJson(join(runDir, 'peer-totals-a.json')) : null;
  const totalsB = peer ? readJson(join(runDir, 'peer-totals-b.json')) : null;
  return Object.fromEntries([...new Set(tags)].map((tag) => {
    const stream = (kind) => read(join(runDir, `client-${tag}.${kind}.ndjson`));
    const declaration = manifest.clients?.[tag] ?? {};
    return [tag, {
      ...declaration,
      starts: declaration.boundaries?.end?.playback?.starts ?? [],
      records: stream('drift'),
      polls: stream('poll'),
      requests: host ? stream('receipts') : stream('requests'),
      ...(host ? { httpRequests: stream('requests') } : {}),
      echoRecords: stream('echo'),
      ...(peer ? {
        peerRecords: stream('peer-bytes'),
        peerTotalsA: totalsA?.clients?.[tag] ?? null,
        peerTotalsB: totalsB?.clients?.[tag] ?? null,
      } : {}),
    }];
  }));
}

function baseArm({ hostTag, runDirPrefix, readyTimeoutMs }) {
  return {
    hostTag,
    runDirPrefix,
    byteAccountingMethod: 'client-receipt-cohort-v1',
    recomputeContent: (manifest) => manifest.content,
    recomputeSegmentSeconds: (manifest) => manifest.content?.segmentSeconds,
    recomputeAccountingMethod: (manifest) => manifest.byteAccountingMethod,
    recomputeInputExtras: () => ({}),
    driftCriterionWhenUndeclared: null,
    driftContextExtras: () => ({}),
    driftRequiredFields: Object.freeze([]),
    trackerPort: null,
    streams: Object.freeze(['drift', 'poll', 'requests', 'echo', 'presence']),
    members: (condition) => members(condition, hostTag),
    clientReadyTimeoutMs: () => readyTimeoutMs,
    boundaryOptions: () => ({}),
    boundaryEvidence: () => ({}),
    async captureBoundaryExtras(kind, { room, sessions, runDir }) {
      writeJson(path.join(runDir, `origin-counters-${kind}.json`), room);
      await recordPageBuildIds(kind, { sessions, runDir });
      return { origin: room, room };
    },
    finalEvidence: () => ({}),
    evidence: (sessions, hostEvidence, runDir) => {
      const buildIdentity = buildIdentityFromRun(runDir);
      return buildIdentity ? { buildIdentity } : {};
    },
    sessionManifest: () => ({}),
    prepareTopology: async () => ({}),
    topologyEvidence: () => ({}),
    readyTopology: (topology) => topology,
    chromeFlags: (agents) => Object.values(agents)[0]?.flags ?? null,
    prepareClientOptions: () => ({}),
    // Cadence first, and the window placed from the instant it is established.
    async openWindow({ sessions, condition, deadline, establishCadence, manifestFile, placeWindow }) {
      const cadence = await establishCadence(sessions, { condition, deadline });
      manifestFile.merge({ cadence, window: placeWindow(condition, Date.now()) });
    },
    async openSessions() { return null; },
    // Whether the first viewer is qualified after every viewer has joined.
    qualifyAfterJoins: false,
    beginQualification: () => null,
    async drain(session, ndjson, atMs, drainClient) { return drainClient(session, ndjson, atMs); },
    clientStreams: (runDir, manifest, files) => clientStreams(runDir, manifest, files, false, false),
  };
}

const HTTP_ARM = Object.freeze({
  ...baseArm({ hostTag: null, runDirPrefix: '6a', readyTimeoutMs: 30_000 }),
  async qualify(sessions, { originContainer, qualifyCdpBytes }) {
    const tab = sessions[0]?.tab;
    return qualifyWith(!originContainer ? 'origin-container' : !tab ? 'first-client-tab' : null,
      () => qualifyCdpBytes(tab, { originContainer }));
  },
  refusals(input, addReason) {
    buildRefusals(input, addReason);
    qualificationRefusal(input, addReason, validateCdpQualification, CDP_QUALIFICATION_REASON);
  },
});

const oneViewing = (manifest) => manifest.multiplierDenominator === 'one-viewing';

const HOST_ARM = Object.freeze({
  ...baseArm({ hostTag: 'c00', runDirPrefix: '9b', readyTimeoutMs: 120_000 }),
  qualifyAfterJoins: true,
  // D5's one viewing sizes the played stretch from the content, as the peer arm does.
  recomputeContent: (manifest) => (oneViewing(manifest) ? recomputePeerContent(manifest) : manifest.content),
  recomputeSegmentSeconds: (manifest) => (oneViewing(manifest)
    ? recomputePeerSegmentSeconds(manifest) : manifest.content?.segmentSeconds),
  async openWindow({ sessions, condition, deadline, establishCadence, manifestFile, placeWindow }) {
    const cadence = await establishCadence(sessions, { condition, deadline });
    manifestFile.merge({
      cadence,
      window: placeWindow(condition, Date.now()),
      ...(declaresSteadyBars(condition) ? { multiplierDenominator: 'one-viewing' } : {}),
    });
  },
  async prepareTopology(state, { services, exec, controlNetwork, mediaNetwork, networkSubnet, networkGateway, controlUdpDrop, mediaDefaultRoute, resolveInterface, waitForAgent }) {
    const controlSubnet = networkSubnet(controlNetwork, exec);
    state.subnets.set(controlNetwork, controlSubnet);
    state.control = resolveInterface(state.containers.origin, controlSubnet, exec);
    state.controlUdpDrop = controlUdpDrop({ container: state.containers.origin, ifName: state.control.ifName, subnet: controlSubnet, exec });
    const gateway = networkGateway(mediaNetwork, exec);
    state.mediaDefaultRoute = Object.fromEntries(['origin', ...services.filter((name) => /^c\d+$/.test(name))]
      .map((name) => [name, mediaDefaultRoute({ container: state.containers[name], subnet: state.subnets.get(mediaNetwork), gateway, exec })]));
    exec(['docker', 'exec', '-d', '-e', 'APP_TAG=c00', state.containers.origin, 'sh', '-c', 'cd /app && node harness/client-agent.mjs > /tmp/host-agent.log 2>&1']);
    return { c00: await waitForAgent('c00') };
  },
  readyTopology(topology, condition) {
    if (!topology.controlUdpDrop?.readBack) throw new Error('host topology recorded no controlUdpDrop read-back');
    const missing = ['origin', ...clientTags(condition)].filter((name) => !topology.mediaDefaultRoute?.[name]?.readBack);
    if (missing.length) throw new Error(`host topology recorded no mediaDefaultRoute read-back for ${missing.join(', ')}`);
    return topology;
  },
  topologyEvidence: (state) => ({ controlUdpDrop: state.controlUdpDrop, mediaDefaultRoute: state.mediaDefaultRoute }),
  chromeFlags: (agents) => Object.fromEntries(Object.entries(agents).map(([tag, agent]) => [tag, agent.flags ?? null])),
  boundaryOptions(sessions) {
    return {
      originSession: sessions.find((session) => session.role === 'host'),
      loopbackReader: sessions.loopbackReader,
      startInstanceId: undefined,
    };
  },
  async captureBoundaryExtras(kind, { room, sessions, manifestFile, runDir, options }) {
    const originSession = options.originSession;
    const origin = await originSession.tab.evaluate('__app.hostCounters()');
    if (!origin) throw new Error(`host counter snapshot missing at ${kind} boundary`);
    await recordPageBuildIds(kind, { sessions, hostSession: originSession, runDir });
    if (kind === 'start') {
      const headroom = await readHeadroom(originSession);
      writeJson(path.join(runDir, 'host-headroom.json'), headroom);
      const manifestClients = manifestFile.get().clients;
      manifestFile.merge({ clients: {
        ...manifestClients,
        [originSession.tag]: { ...manifestClients[originSession.tag], headroom },
      } });
    }
    if (kind === 'end') {
      for (const session of sessions.filter((entry) => entry.role === 'viewer')) {
        manifestFile.merge({ clients: { ...manifestFile.get().clients, [session.tag]: {
          ...manifestFile.get().clients[session.tag],
          hostLinkEnd: await session.tab.evaluate('__app.hostLink()'),
        } } });
      }
    }
    writeJson(path.join(runDir, `origin-counters-${kind}.json`), origin);
    writeJson(path.join(runDir, `room-counters-${kind}.json`), room);
    const loopback = await options.loopbackReader();
    writeJson(path.join(runDir, `origin-loopback-${kind}.json`), loopback);
    if (kind === 'end' && options.startInstanceId !== undefined && origin.instanceId !== options.startInstanceId) {
      throw new Error('host counter instanceId changed during run');
    }
    if (kind === 'start') options.startInstanceId = origin.instanceId;
    if (!finite(origin.atMs)) throw new Error(`host counter snapshot has no finite atMs at ${kind} boundary`);
    return { origin, room };
  },
  boundaryEvidence(kind, boundary) {
    return kind === 'start' ? { roomStart: boundary.room } : { roomEnd: boundary.room };
  },
  async finalEvidence({ originUrl, fetchSnapshot, runDir }) {
    const room = await fetchSnapshot(originUrl);
    writeJson(path.join(runDir, 'room-counters-final.json'), room);
    return { roomFinal: room };
  },
  evidence(sessions, hostEvidence, runDir) {
    const buildIdentity = buildIdentityFromRun(runDir);
    return {
      roomStart: hostEvidence.roomStart,
      roomEnd: hostEvidence.roomEnd,
      roomFinal: hostEvidence.roomFinal,
      linkSamples: readNdjson(path.join(runDir, 'origin-link.ndjson')),
      headroom: readJson(path.join(runDir, 'host-headroom.json')),
      receiptHealth: Object.fromEntries(sessions.map((session) => [session.tag, {
        missed: session.receiptLogMissed ?? 0,
        reset: session.receiptLogReset === true,
      }])),
      ...(hostEvidence.controlEvidence ? { controlEvidence: hostEvidence.controlEvidence } : {}),
      ...(hostEvidence.assignmentControl ? { assignmentControl: hostEvidence.assignmentControl } : {}),
      ...(buildIdentity ? { buildIdentity } : {}),
    };
  },
  async openSessions({ room, clientOriginUrl, hostPageUrl = clientOriginUrl, clientFactory, condition, runDir, deadline, newSession, prepareHostClient }) {
    const session = newSession(this.hostTag, 'host');
    const url = `${hostPageUrl}/room.html?room=${encodeURIComponent(room)}&role=host&tab=${this.hostTag}`;
    Object.assign(session, await clientFactory({ tag: this.hostTag, role: 'host', room, url, condition, runDir }));
    if (!session.tab) throw new Error('host tab is unavailable');
    const hostSource = [
      ...(condition.seek ? ['globalThis.__waHarnessSeek = true;'] : []),
      ...(Object.prototype.hasOwnProperty.call(condition, 'headroomFraction')
        ? [`globalThis.__waHeadroomFraction = ${JSON.stringify(condition.headroomFraction)};`]
        : []),
      ...(controlInjection(condition) ? [controlInjection(condition)] : []),
    ].join('\n');
    await prepareHostClient(session, url, deadline, {
      beforeNavigate: hostSource
        ? async (hostSession) => hostSession.tab.send('Page.addScriptToEvaluateOnNewDocument', {
          source: hostSource,
        })
        : null,
    });
    return session;
  },
  // Issued at the first viewer's join and collected after the last (9b design.md D1).
  beginQualification(sessions, { beginLinkQualification }) {
    const viewerTab = sessions[0]?.tab;
    return viewerTab ? beginLinkQualification(viewerTab) : null;
  },
  async qualify(sessions, { originSession, originContainer, finishLinkQualification, pending }) {
    const viewerTab = sessions[0]?.tab;
    const hostTab = originSession?.tab;
    return qualifyWith(!originContainer ? 'origin-container' : !viewerTab || !hostTab ? 'host-or-viewer-tab' : null,
      async () => finishLinkQualification(await pending, hostTab, { originContainer }));
  },
  async drain(session, ndjson, atMs, drainClient) {
    const result = await drainClient(session, ndjson, atMs);
    const receipt = await session.tab.evaluate(`__app.hostReceipts(${session.receiptCursor ?? 0})`);
    const latestReceiptSeq = Number(receipt?.latestSeq);
    if (finite(latestReceiptSeq) && latestReceiptSeq < (session.receiptCursor ?? 0)) session.receiptLogReset = true;
    const missed = Number(receipt?.missed);
    if (finite(missed)) session.receiptLogMissed = Math.max(session.receiptLogMissed ?? 0, missed);
    for (const entry of Array.isArray(receipt?.records) ? receipt.records : []) {
      ndjson.append(`client-${session.tag}.receipts.ndjson`, [entry]);
    }
    if (finite(latestReceiptSeq)) session.receiptCursor = Math.max(session.receiptCursor ?? 0, latestReceiptSeq);
    return result;
  },
  clientStreams: (runDir, manifest, files) => clientStreams(runDir, manifest, files, true),
  refusals(input, addReason) {
    buildRefusals(input, addReason);
    qualificationRefusal(input, addReason, validateLinkReceiptQualification, LINK_RECEIPT_QUALIFICATION_REASON);
    const condition = input.condition ?? {};
    const tags = input.declaredClientTags ?? Object.keys(input.clients ?? {});
    const window = input.window ?? condition.window;
    const start = input.originStart?.counters ?? input.originStart;
    const end = input.originEnd?.counters ?? input.originEnd;
    const leak = viewerHttpLeak({ roomFinal: input.roomFinal, viewerTags: tags });
    for (const entry of leak.leaked) addReason('viewer-media-over-http', REFUSAL_SCOPE.hostLeak, entry);
    if (leak.unattributedBytes !== 0) addReason('viewer-media-over-http', REFUSAL_SCOPE.hostLeak, { tag: null, bytes: leak.unattributedBytes });
    const uplink = uplinkVersusDelivered({ linkSamples: input.linkSamples, window, originStart: start, originEnd: end });
    if (uplink.txBytes === null || uplink.deliveredMediaBytes === null) {
      addReason('host-uplink-evidence-unavailable', REFUSAL_SCOPE.hostUplink, { uplink });
    } else if (uplink.txBytes < uplink.deliveredMediaBytes) {
      addReason('host-uplink-below-delivered', REFUSAL_SCOPE.hostUplink, uplink);
    }
    for (const tag of tags) {
      const health = input.receiptHealth?.[tag] ?? {};
      if (Number(health.missed) > 0) addReason('receipt-log-discarded-records', REFUSAL_SCOPE.receiptHealth, { tag, missed: health.missed });
      if (health.reset === true) addReason('receipt-log-reset', REFUSAL_SCOPE.receiptHealth, { tag });
    }
    headroomRefusals(input, addReason);
    for (const boundary of Object.values(input.topologyBoundaries ?? {})) {
      for (const reason of boundary.readback?.refusals ?? []) addReason(reason, REFUSAL_SCOPE.topology, { boundary: boundary.readback });
    }
    for (const refusal of evidenceRefusals({ ...input.controlEvidence, seek: input.seek, peerExchange: input.condition?.peerExchange === true })) {
      addReason(refusal.reason, REFUSAL_SCOPE.control, refusal.detail);
    }
    // Absent only on evidence constructed or retained before 9b; a live run carries it.
    if (input.assignmentControl) {
      for (const { reason, ...detail } of controlRefusals(condition, input.assignmentControl.readings)) {
        addReason(reason, REFUSAL_SCOPE.control, detail);
      }
    }
  },
});

function peerManifestReading(manifestFile, session, reading) {
  const body = manifestFile.get();
  manifestFile.merge({ clients: {
    ...body.clients,
    [session.tag]: {
      ...body.clients[session.tag],
      buildId: reading?.buildId ?? null,
      peerExchange: reading?.peerExchange ?? null,
      positionOffset: reading?.positionOffset ?? null,
      peerAttribution: reading?.peerBytes?.attribution ?? null,
      peerId: reading?.peerBytes?.peerId ?? null,
    },
  } });
  manifestFile.write();
}

async function readPeerReady(session, manifestFile) {
  let reading = null;
  try { reading = await session.tab.evaluate(peerPageReadingExpression()); } catch {}
  session.peerReadyReading = reading;
  session.peerLatestReading = reading ? {
    ...reading,
    attribution: reading.peerBytes?.attribution ?? null,
    peerId: reading.peerBytes?.peerId ?? null,
  } : null;
  session.peerCursor = 0;
  session.peerRecords = [];
  session.peerLogHealth = { missed: 0, reset: false };
  peerManifestReading(manifestFile, session, reading);
}

function peerClientOptions({ condition, manifestFile }) {
  return {
    beforeNavigate: async (session) => {
      if (session.role !== 'viewer') return;
      const offset = condition.positionOffsetMsByClient?.[session.tag] ?? 0;
      const source = [
        `globalThis.__waPositionOffsetMs = ${JSON.stringify(offset)};`,
        ...(Object.prototype.hasOwnProperty.call(condition, 'engineWindows')
          ? [`globalThis.__waEngineWindows = ${JSON.stringify(condition.engineWindows)};`]
          : []),
        ...(controlInjection(condition) ? [controlInjection(condition)] : []),
      ].join('\n');
      await session.tab.send('Page.addScriptToEvaluateOnNewDocument', {
        source,
      });
    },
    afterReady: async (session, { deadline, readyTimeoutMs } = {}) => {
      if (session.role !== 'viewer') return;
      if (deadline && readyTimeoutMs !== undefined) {
        await deadline.waitFor(`peer settings ${session.tag}`,
          () => session.tab.evaluate('__app.peerExchange()'), (value) => value !== null, readyTimeoutMs, 100);
      }
      await readPeerReady(session, manifestFile);
    },
  };
}

function peerTotals(reading) {
  return {
    peerId: reading?.peerId ?? null,
    peerIds: Array.isArray(reading?.peerIds) ? reading.peerIds : [],
    chunkBytes: reading?.chunkBytes ?? null,
    uploadBytes: reading?.uploadBytes ?? null,
    connected: Array.isArray(reading?.connected) ? reading.connected : [],
    open: Array.isArray(reading?.open) ? reading.open : [],
    errors: reading?.errors ?? null,
  };
}

async function readPeerLog(session, ndjson) {
  const cursor = session.peerCursor ?? 0;
  let reading = null;
  try { reading = await session.tab.evaluate(`__app.peerBytes(${cursor})`); } catch {}
  if (!reading || typeof reading !== 'object') return null;
  session.peerLogHealth ??= { missed: 0, reset: false };
  const latestSeq = Number(reading.latestSeq);
  if (finite(latestSeq) && latestSeq < cursor) session.peerLogHealth.reset = true;
  const missed = Number(reading.missed);
  if (finite(missed)) session.peerLogHealth.missed = Math.max(session.peerLogHealth.missed, missed);
  const records = Array.isArray(reading.records) ? reading.records : [];
  if (records.length) {
    session.peerRecords ??= [];
    session.peerRecords.push(...records);
    ndjson?.append(`client-${session.tag}.peer-bytes.ndjson`, records);
  }
  if (finite(latestSeq)) session.peerCursor = Math.max(cursor, latestSeq);
  session.peerLatestReading = {
    ...(session.peerReadyReading ?? {}),
    attribution: reading.attribution ?? null,
    peerId: reading.peerId ?? null,
    peerIds: Array.isArray(reading.peerIds) ? reading.peerIds : [],
    peerBytes: reading,
  };
  return reading;
}

function peerBoundaryReading(session, reading) {
  return {
    buildId: session.peerLatestReading?.buildId ?? session.peerReadyReading?.buildId ?? null,
    peerExchange: session.peerLatestReading?.peerExchange ?? session.peerReadyReading?.peerExchange ?? null,
    positionOffset: session.peerLatestReading?.positionOffset ?? session.peerReadyReading?.positionOffset ?? null,
    ...peerTotals(reading),
  };
}

const ENGINE_WINDOW_KEYS = Object.keys(ENGINE_WINDOW_DEFAULTS);

function mainStreamWindows(config) {
  const stream = config?.mainStream;
  if (!stream || typeof stream !== 'object') return null;
  return Object.fromEntries(ENGINE_WINDOW_KEYS.map((key) => [key, stream[key]]));
}

function sameEngineWindows(left, right) {
  return Boolean(left && right && ENGINE_WINDOW_KEYS.every((key) => left[key] === right[key]));
}

function declaredEngineWindows(condition) {
  return Object.prototype.hasOwnProperty.call(condition, 'engineWindows') ? condition.engineWindows : null;
}

function peerLinkQdisc(topology, tag) {
  if (!topology?.containers || !Array.isArray(topology.qdiscs)) return null;
  return topology.qdiscs.find((candidate) => {
    const rightContainer = candidate?.container === topology.containers?.[tag];
    return rightContainer && candidate.network === 'wa-media'
      && candidate.direction === 'egress' && candidate.discipline === 'tbf'
      && candidate.readBack?.readings?.rate?.got !== null
      && candidate.readBack?.readings?.rate?.got !== undefined;
  }) ?? null;
}

function peerLinkProbePaths(topology, condition) {
  if (!topology.containers || !Array.isArray(topology.qdiscs)) return topology.probePaths;
  const probePaths = { ...(topology.probePaths ?? {}) };
  for (const tag of clientTags(condition)) {
    const record = peerLinkQdisc(topology, tag);
    probePaths[tag] = {
      ...(probePaths[tag] ?? {}),
      peerLinksShaped: Boolean(record),
      peerLinkRateBitsPerSecond: record ? record.readBack.readings.rate.got : null,
    };
  }
  return probePaths;
}

function peerLinkQueues(manifest) {
  const topology = manifest?.topology;
  if (!topology?.containers || !Array.isArray(topology.qdiscs)) return null;
  const queues = {};
  for (const tag of clientTags(manifest.condition)) {
    const readings = peerLinkQdisc(topology, tag)?.readBack?.readings;
    const rate = readings?.rate?.got;
    const burst = readings?.burst?.got;
    const latency = readings?.latency?.got;
    if ([rate, burst, latency].every(finite) && rate >= 0 && burst >= 0 && latency >= 0) {
      queues[tag] = { queueLimitBytes: rate / 8 * latency / 1000 + burst };
    }
  }
  return queues;
}

function cumulativePeerUpload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { value: null, error: 'uploadBytes-unavailable' };
  let total = 0;
  for (const [peerId, bytes] of Object.entries(value)) {
    if (!finite(bytes) || bytes < 0) return { value: null, error: `uploadBytes-invalid:${peerId}` };
    total += bytes;
  }
  return { value: total, error: null };
}

function viewerLinkDelta(start, end, peerStart, peerEnd, tag) {
  const detail = { tag, interfaceBytes: null, uploadBytes: null };
  if (!start || !end || !finite(start.txBytes) || !finite(end.txBytes)) {
    return { ...detail, available: false, error: 'viewer-link-reading-missing' };
  }
  const interfaceBytes = end.txBytes - start.txBytes;
  if (interfaceBytes < 0) return { ...detail, available: false, error: 'viewer-link-delta-negative', interfaceBytes };
  const before = cumulativePeerUpload(peerStart);
  const after = cumulativePeerUpload(peerEnd);
  if (before.error || after.error) {
    return { ...detail, available: false, error: before.error ?? after.error, interfaceBytes };
  }
  const uploadBytes = after.value - before.value;
  if (uploadBytes < 0) return { ...detail, available: false, error: 'peer-upload-delta-negative', interfaceBytes, uploadBytes };
  return { available: true, tag, interfaceBytes, uploadBytes };
}

async function readEngineWindows(session, condition) {
  let value = null;
  try {
    value = await session.tab.evaluate('({ config: __app.peerEngineConfig(), page: __app.engineWindows() })');
  } catch {}
  const declared = declaredEngineWindows(condition);
  return {
    declared,
    expected: declared ?? PRODUCT_ENGINE_WINDOWS,
    inForce: mainStreamWindows(value?.config),
    pageError: value?.page?.error ?? null,
  };
}

// T4 (design.md D2): the host's one reading, taken at the start boundary
// alongside the host counter snapshot — the earliest common "ready" point a
// single host session has, mirroring readEngineWindows above.
async function readHeadroom(session) {
  let value = null;
  try {
    value = await session.tab.evaluate('__app.headroom()');
  } catch {}
  return {
    fraction: value?.fraction ?? null,
    supplied: value?.supplied ?? null,
    pageError: value?.error ?? null,
    available: value !== null,
  };
}

// T13 reads the hook's absence on every viewer live; T1's suite constructs it.
async function readHarnessSeek(session) {
  try {
    return await session.tab.evaluate("({ present: typeof __app.harnessSeek === 'function', error: __app.harnessSeekError ?? null })");
  } catch (error) {
    return { present: null, error: `read-failed:${error.message}` };
  }
}

function settledResponseRefusals(input, addReason) {
  const condition = input.condition ?? {};
  const settled = input.originSettled;
  const records = settled?.counters?.responseRecords ?? settled?.responseRecords;
  if (!settled || !Array.isArray(records)) {
    addReason('response-settle-evidence-unavailable', REFUSAL_SCOPE.responseSettle, { figure: 'byte' });
    return;
  }
  const atMs = Number(settled.atMs);
  const endMs = Number((input.window ?? condition.window)?.endMs);
  const gapMs = Number(condition.bars.responseSettleGapMs);
  if (!finite(atMs) || !finite(endMs) || !finite(gapMs) || atMs - endMs < gapMs) {
    addReason('response-settle-gap-short', REFUSAL_SCOPE.responseSettle, {
      atMs, endMs, requiredMs: gapMs, actualMs: atMs - endMs,
    });
  }
}

function viewerInterfaceRefusals(input, tags, addReason) {
  for (const tag of tags) {
    const detail = viewerLinkDelta(input.viewerLinkStart?.clients?.[tag], input.viewerLinkEnd?.clients?.[tag],
      input.peerBoundaryStart?.clients?.[tag]?.uploadBytes, input.peerBoundaryEnd?.clients?.[tag]?.uploadBytes, tag);
    if (!detail.available) addReason('viewer-interface-evidence-unavailable', REFUSAL_SCOPE.viewerInterface, detail);
    else if (detail.interfaceBytes < detail.uploadBytes) addReason('peer-bytes-bypassed-shaped-link', REFUSAL_SCOPE.viewerInterface, detail);
  }
}

// Absent only on directories retained before 7c; a live run always carries the object.
function engineWindowRefusals(input, tags, addReason) {
  if (!input.engineWindows) return;
  const expected = declaredEngineWindows(input.condition ?? {}) ?? PRODUCT_ENGINE_WINDOWS;
  for (const tag of tags) {
    const reading = input.engineWindows[tag];
    if (reading?.pageError) {
      addReason('engine-windows-invalid', REFUSAL_SCOPE.engineWindows, { tag, error: reading.pageError });
    } else if (!reading || !reading.inForce) {
      addReason('engine-windows-unavailable', REFUSAL_SCOPE.engineWindows, { tag });
    } else if (!sameEngineWindows(reading.inForce, expected)) {
      addReason('engine-windows-mismatch', REFUSAL_SCOPE.engineWindows, { tag, expected, inForce: reading.inForce });
    }
  }
}

// One reading, not per-tag: the fraction is the host's alone. Absent only on
// directories retained before this change; a live run always carries the object.
function headroomRefusals(input, addReason) {
  if (!input.headroom) return;
  const condition = input.condition ?? {};
  const expected = Object.prototype.hasOwnProperty.call(condition, 'headroomFraction') ? condition.headroomFraction : HEADROOM_DEFAULT;
  const reading = input.headroom;
  if (reading.pageError) {
    addReason('headroom-fraction-invalid', REFUSAL_SCOPE.headroom, { error: reading.pageError });
  } else if (!reading.available) {
    addReason('headroom-fraction-unavailable', REFUSAL_SCOPE.headroom, {});
  } else if (reading.fraction !== expected) {
    addReason('headroom-fraction-mismatch', REFUSAL_SCOPE.headroom, { expected, published: reading.fraction });
  }
}

const PEER_ARM = Object.freeze({
  ...HOST_ARM,
  runDirPrefix: '9b',
  byteAccountingMethod: 'peer-attempt-cohort-v1',
  multiplierDenominator: 'one-viewing',
  recomputeContent: recomputePeerContent,
  recomputeSegmentSeconds: recomputePeerSegmentSeconds,
  recomputeAccountingMethod: () => PEER_ARM.byteAccountingMethod,
  recomputeInputExtras: (manifest) => {
    const queues = peerLinkQueues(manifest);
    return { cdpQualification: manifest.cdpQualification, ...(queues ? { peerLinkQueues: queues } : {}) };
  },
  driftCriterionWhenUndeclared: Object.freeze({ verdict: 'not-drawn', reason: 'design.md D5' }),
  driftContextExtras: (manifest) => ({ topology: { probePaths: manifest.topology?.probePaths } }),
  driftRequiredFields: Object.freeze(['topology.probePaths']),
  trackerPort: '8101',
  streams: Object.freeze([...HOST_ARM.streams, 'peer-bytes']),
  prepareClientOptions: peerClientOptions,
  readyTopology(topology, condition) {
    const ready = HOST_ARM.readyTopology(topology, condition);
    return { ...ready, probePaths: peerLinkProbePaths(ready, condition) };
  },
  // The window is placed first and the viewers are waited into it, draining as
  // they go; cadence is established after the wait.
  async openWindow({ sessions, condition, deadline, establishCadence, manifestFile, placeWindow, drainAll, drainEveryMs }) {
    const window = placeWindow(condition, Date.now());
    manifestFile.merge({ window, multiplierDenominator: condition.seek ? 'none-across-seek' : this.multiplierDenominator });
    manifestFile.merge({ startWait: await this.waitForPlayback({ sessions, condition, window, deadline, drain: drainAll, drainEveryMs }) });
    manifestFile.write();
    await drainAll();
    manifestFile.merge({ cadence: await establishCadence(sessions, { condition, deadline }) });
  },
  // Drains while it waits: a viewer playing since readiness would otherwise fill its
  // drift ring before the drain loops start (scattered attempt 2, c01).
  async waitForPlayback({ sessions, window, deadline, now = Date.now, sleep = wait, drain = async () => {}, drainEveryMs = 15_000 }) {
    const deadlineMs = window.startMs - CEILING_MS;
    await drain();
    let drainedAt = now();
    const playingAtMs = Object.fromEntries(sessions.map((session) => [session.tag, null]));
    const read = async (session) => {
      const playback = await session.tab.evaluate('__app.playback()');
      if (playingAtMs[session.tag] === null && playback?.playing === true) playingAtMs[session.tag] = now();
    };
    while (true) {
      for (const session of sessions) if (playingAtMs[session.tag] === null) await read(session);
      if (Object.values(playingAtMs).every((value) => value !== null) || now() >= deadlineMs) break;
      deadline?.check('playback wait');
      if (now() - drainedAt >= drainEveryMs) { await drain(); drainedAt = now(); }
      await sleep(Math.min(100, Math.max(1, deadlineMs - now())));
    }
    return { deadlineMs, playingAtMs };
  },
  async captureBoundaryExtras(kind, context) {
    const extras = await HOST_ARM.captureBoundaryExtras(kind, context);
    // Read at the boundary itself: the bypass check compares it with the peer
    // upload read at the same boundary (7c d1-findings.md F2).
    const viewerLinks = await context.options.viewerLinkReader?.() ?? null;
    writeJson(path.join(context.runDir, `viewer-link-${kind}.json`), viewerLinks);
    const clients = {};
    for (const session of context.sessions.filter((entry) => entry.role === 'viewer')) {
      const reading = await readPeerLog(session, context.ndjson);
      if (kind === 'start') {
        session.engineWindows = await readEngineWindows(session, context.manifestFile.get().condition);
        const harnessSeek = await readHarnessSeek(session);
        const manifestClients = context.manifestFile.get().clients;
        context.manifestFile.merge({ clients: {
          ...manifestClients,
          [session.tag]: { ...manifestClients[session.tag], engineWindows: session.engineWindows, harnessSeek },
        } });
      }
      clients[session.tag] = peerBoundaryReading(session, reading);
      if (session.engineWindows) clients[session.tag].engineWindows = session.engineWindows;
    }
    writeJson(path.join(context.runDir, `peer-boundary-${kind}.json`), { clients });
    return extras;
  },
  async finalEvidence({ originUrl, fetchSnapshot, runDir, sessions, ndjson, condition, deadline, originSession, drainAll, window, startInstanceId }) {
    const extras = await HOST_ARM.finalEvidence({ originUrl, fetchSnapshot, runDir });
    const viewers = sessions.filter((entry) => entry.role === 'viewer');
    const capture = async (name) => {
      const startedAtMs = Date.now();
      const clients = {};
      for (const session of viewers) {
        const readStartedAtMs = Date.now();
        const reading = await readPeerLog(session, ndjson);
        const readEndedAtMs = Date.now();
        clients[session.tag] = { ...peerTotals(reading), readStartedAtMs, readEndedAtMs };
      }
      const endedAtMs = Date.now();
      const value = { startedAtMs, endedAtMs, clients };
      writeJson(path.join(runDir, `peer-totals-${name}.json`), value);
      return value;
    };
    const peerTotalsA = await capture('a');
    const gap = Number(condition?.bars?.conservationDeliveryGapMs ?? 0);
    const afterA = peerTotalsA.endedAtMs + (finite(gap) && gap >= 0 ? gap : 0);
    if (deadline) {
      await deadline.waitFor('peer delivery gap', () => Date.now(), (value) => value >= afterA,
        Math.max(1_000, afterA - Date.now() + 1_000), 50);
    } else if (Date.now() < afterA) {
      await wait(afterA - Date.now());
    }
    const peerTotalsB = await capture('b');
    for (const session of viewers) {
      session.peerTotalsA = peerTotalsA.clients[session.tag];
      session.peerTotalsB = peerTotalsB.clients[session.tag];
    }
    if (!declaresResponseSettle(condition)) return { ...extras, peerTotalsA, peerTotalsB };
    const settleGapMs = Number(condition.bars.responseSettleGapMs);
    const settleAtMs = Number(window?.endMs) + settleGapMs;
    if (!finite(settleGapMs) || settleGapMs < 0 || !finite(settleAtMs)) {
      throw new Error('response settle gap is not a finite non-negative declared bar');
    }
    if (!originSession?.tab) throw new Error('host session is unavailable for settled response evidence');
    if (deadline) {
      await deadline.waitFor('response settle gap', () => Date.now(), (value) => value >= settleAtMs,
        Math.max(1_000, settleAtMs - Date.now() + 1_000), 50);
    } else if (Date.now() < settleAtMs) {
      await wait(settleAtMs - Date.now());
    }
    const originSettled = await originSession.tab.evaluate('__app.hostCounters()');
    if (!originSettled) throw new Error('settled host counter snapshot is unavailable');
    if (startInstanceId !== undefined && originSettled.instanceId !== startInstanceId) {
      throw new Error('host counter instanceId changed during run');
    }
    writeJson(path.join(runDir, 'origin-counters-settled.json'), originSettled);
    await drainAll?.();
    return { ...extras, peerTotalsA, peerTotalsB, originSettled };
  },
  evidence(sessions, hostEvidence, runDir) {
    const base = HOST_ARM.evidence(sessions, hostEvidence, runDir);
    const viewers = sessions.filter((entry) => entry.role === 'viewer');
    return {
      ...base,
      ...(hostEvidence.originSettled ? { originSettled: hostEvidence.originSettled } : {}),
      peerReadings: Object.fromEntries(viewers.map((session) => [session.tag, session.peerLatestReading ?? session.peerReadyReading ?? null])),
      engineWindows: Object.fromEntries(viewers.map((session) => [session.tag, session.engineWindows ?? null])),
      peerLogHealth: Object.fromEntries(viewers.map((session) => [session.tag, session.peerLogHealth ?? null])),
      peerRecords: Object.fromEntries(viewers.map((session) => [session.tag, session.peerRecords ?? []])),
      viewerLinkStart: readJson(path.join(runDir, 'viewer-link-start.json')),
      viewerLinkEnd: readJson(path.join(runDir, 'viewer-link-end.json')),
      peerBoundaryStart: readJson(path.join(runDir, 'peer-boundary-start.json')),
      peerBoundaryEnd: readJson(path.join(runDir, 'peer-boundary-end.json')),
    };
  },
  // The ready reading predates the engine; the last drain's names it.
  sessionManifest(session) {
    if (!session.peerReadyReading) return {};
    return {
      buildId: session.peerReadyReading.buildId ?? null,
      peerExchange: session.peerReadyReading.peerExchange ?? null,
      positionOffset: session.peerReadyReading.positionOffset ?? null,
      peerAttribution: session.peerLatestReading?.attribution ?? null,
      peerId: session.peerLatestReading?.peerId ?? null,
      peerLogHealth: session.peerLogHealth ?? null,
      ...(session.engineWindows ? { engineWindows: session.engineWindows } : {}),
    };
  },
  async drain(session, ndjson, atMs, drainClient) {
    const result = await HOST_ARM.drain(session, ndjson, atMs, drainClient);
    await readPeerLog(session, ndjson);
    return result;
  },
  clientStreams: (runDir, manifest, files) => clientStreams(runDir, manifest, files, true, true),
  refusals(input, addReason) {
    HOST_ARM.refusals(input, addReason);
    const condition = input.condition ?? {};
    const tags = clientTags(condition);
    if (declaresResponseSettle(condition)) {
      settledResponseRefusals(input, addReason);
      viewerInterfaceRefusals(input, tags, addReason);
    }
    const readings = input.peerReadings ?? {};
    for (const tag of tags) {
      const reading = readings[tag];
      if (!reading || reading.peerExchange !== 'on') {
        addReason('peer-exchange-inactive', REFUSAL_SCOPE.peerExchange, { tag, evidence: reading ? reading.peerExchange : 'no-reading' });
        continue;
      }
      if (reading.attribution !== 'engine-request' || typeof reading.peerId !== 'string') {
        addReason('peer-attribution-unavailable', REFUSAL_SCOPE.peerAttribution, { tag, attribution: reading.attribution ?? null, peerId: reading.peerId ?? null });
      }
      const health = input.peerLogHealth?.[tag] ?? {};
      if (Number(health.missed) > 0) addReason('peer-log-discarded-records', REFUSAL_SCOPE.peerLog, { tag, missed: health.missed });
      if (health.reset === true) addReason('peer-log-reset', REFUSAL_SCOPE.peerLog, { tag });
      const anomalies = (input.peerRecords?.[tag] ?? []).filter((record) => record?.kind === 'anomaly');
      if (anomalies.length) addReason('peer-anomaly-records', REFUSAL_SCOPE.peerAnomaly, { tag, count: anomalies.length });
    }
    engineWindowRefusals(input, tags, addReason);
    const offsets = condition.positionOffsetMsByClient ?? {};
    for (const tag of tags) {
      const expected = offsets[tag] ?? 0;
      const actual = readings[tag]?.positionOffset?.ms;
      if (readings[tag] && actual !== expected) addReason('position-offset-mismatch', REFUSAL_SCOPE.positionOffset, { tag, expected, actual });
    }
    if (!input.buildIdentity) {
      const buildIds = tags.filter((tag) => readings[tag]).map((tag) => readings[tag].buildId ?? null);
      if (new Set(buildIds).size > 1 || buildIds.includes(null)) addReason('build-mismatch', REFUSAL_SCOPE.build, { buildIds });
    }
    const publication = input.publicationContext;
    if (!publication || publication.byteAccountingMethod !== 'peer-attempt-cohort-v1') return;
    for (const reason of publication.peerRefusalReasons ?? []) {
      if (reason === 'peer-cohort-empty') addReason(reason, REFUSAL_SCOPE.peerCohort, { figure: 'byte' });
      if (reason === 'peer-conservation-tolerance-unbounded') addReason(reason, REFUSAL_SCOPE.peerTolerance, { figure: 'byte' });
    }
    for (const check of publication.peerChecks ?? []) {
      if (check.exercised === false) {
        addReason(`peer-check-not-exercised:${check.check}`, REFUSAL_SCOPE.peerCheck, { check: check.check, figure: 'byte' });
      } else if (check.passed === false) {
        addReason(`peer-check-failed:${check.check}`, REFUSAL_SCOPE.peerCheck, { check: check.check, failures: check.failures, figure: 'byte' });
      }
    }
  },
});

export function armFor(condition = {}) {
  const delivery = condition?.delivery ?? 'http';
  switch (delivery) {
    case 'http': return HTTP_ARM;
    case 'host': return condition.peerExchange === true ? PEER_ARM : HOST_ARM;
    default: throw new Error(`unsupported delivery: ${delivery}`);
  }
}
