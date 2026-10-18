const ROWS = Object.freeze(['RC0', 'RC1', 'RC2', 'RC3', 'RC4', 'RC5', 'RC6', 'RC7', 'RC8']);
const VERDICTS = new Set(['PASS', 'FAIL', 'NOT EXERCISED', 'UNESTABLISHED']);
const FORBIDDEN = /refused|audio|codec|aac|mp4a|refuse-audio-codec/i;

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const nonNegative = (value) => finite(value) && value >= 0;
const integer = (value) => Number.isSafeInteger(value);
const text = (value) => typeof value === 'string';

function result(row, verdict, detail) {
  if (!ROWS.includes(row) || !VERDICTS.has(verdict)) throw new TypeError('invalid continuity verdict');
  return { row, verdict, detail: String(detail) };
}

const missing = (row, detail = 'evidence is missing or malformed') => result(row, 'UNESTABLISHED', detail);
const fail = (row, detail) => result(row, 'FAIL', detail);
const pass = (row, detail) => result(row, 'PASS', detail);

function bundle(value) {
  return object(value) && text(value.servedSha256) && text(value.diskSha256)
    && text(value.pageBuildId) && typeof value.pageIdInServed === 'boolean' && typeof value.pageIdInDisk === 'boolean';
}

function state(value) {
  return object(value) && text(value.lineage) && integer(value.version) && typeof value.playing === 'boolean'
    && finite(value.positionMs) && typeof value.held === 'boolean' && finite(value.atSharedMs);
}

function title(value) {
  return object(value) && text(value.title) && text(value.name);
}

function frames(value) {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => object(entry) && finite(entry.mediaTime) && finite(entry.wallTime));
}

function viewerPoll(value) {
  return object(value) && Array.isArray(value.viewers) && value.viewers.length === 2
    && value.viewers.every((viewer) => object(viewer) && state(viewer.state));
}

export function rc0(reading) {
  if (!object(reading) || !object(reading.f) || !object(reading.d)
    || !text(reading.f.pageBuildId) || !text(reading.d.pageBuildId)
    || !bundle(reading.f.bundle) || !bundle(reading.d.bundle)) return missing('RC0');
  const checks = [reading.f, reading.d].flatMap((server, index) => [
    [server.pageBuildId === server.bundle.pageBuildId, `${index ? 'D' : 'F'} page build id differs from bundle`],
    [server.bundle.servedSha256 === server.bundle.diskSha256, `${index ? 'D' : 'F'} served bundle differs from disk`],
    [server.bundle.pageIdInServed && server.bundle.pageIdInDisk, `${index ? 'D' : 'F'} page build id is absent from a bundle`],
  ]);
  const bad = checks.find(([ok]) => !ok);
  return bad ? fail('RC0', bad[1]) : pass('RC0', 'F and D page builds match the served and disk bundles');
}

export function rc1(reading) {
  if (!object(reading) || !object(reading.f) || !object(reading.d)
    || !object(reading.f.settings) || !object(reading.d.settings)
    || !integer(reading.f.settings.hostGraceMs) || !integer(reading.d.settings.hostGraceMs)
    || !text(reading.f.settings.mediaSource) || !text(reading.f.settings.delivery)
    || typeof reading.f.settings.autoStart !== 'boolean' || !text(reading.d.settings.delivery)
    || !finite(reading.expectedDGraceMs)) return missing('RC1');
  const f = reading.f.settings;
  const d = reading.d.settings;
  const reasons = [];
  if (f.hostGraceMs !== 3000) reasons.push('F host grace is not 3000 ms');
  if (f.mediaSource !== 'file') reasons.push('F media source is not file');
  if (f.delivery !== 'host') reasons.push('F delivery is not host');
  if (f.autoStart !== true) reasons.push('F automatic start is not on');
  if (d.delivery !== 'http') reasons.push('D delivery is not http');
  if (d.hostGraceMs !== reading.expectedDGraceMs) reasons.push('D host grace differs from the expected setting');
  return reasons.length ? fail('RC1', reasons.join('; ')) : pass('RC1', 'F and D report the pinned settings');
}

function counterShape(value) {
  return object(value) && Array.isArray(value.responseRecords)
    && value.responseRecords.every((record) => object(record) && text(record.urlPath));
}

function viewerChoosing(value) {
  return object(value) && object(value.hostPreparing) && text(value.hostPreparing.state)
    && (value.hostPreparing.fraction === null || finite(value.hostPreparing.fraction)) && text(value.hostPreparing.text)
    && text(value.bodyText) && typeof value.playDisabled === 'boolean' && object(value.requestsByPath);
}

export function rc2(reading) {
  if (!object(reading) || !object(reading.host) || !text(reading.host.hostFileStatus)
    || !Array.isArray(reading.viewers) || reading.viewers.length !== 2 || !reading.viewers.every(viewerChoosing)
    || !counterShape(reading.counters)) return missing('RC2');
  if (!reading.host.hostFileStatus.startsWith('refused')) return fail('RC2', 'host file status did not start with refused');
  const badViewer = reading.viewers.find((viewer) => viewer.hostPreparing.state !== 'choosing'
    || viewer.hostPreparing.text !== 'the host is choosing a video'
    || viewer.hostPreparing.fraction !== null
    || viewer.playDisabled !== true || FORBIDDEN.test(viewer.bodyText));
  if (badViewer) {
    if (badViewer.hostPreparing.state !== 'choosing') return fail('RC2', 'viewer preparing state is not choosing');
    if (badViewer.hostPreparing.text !== 'the host is choosing a video') return fail('RC2', 'viewer does not say the host is choosing');
    return fail('RC2', badViewer.playDisabled !== true ? 'play is not disabled' : 'viewer body exposes refusal details');
  }
  if (reading.viewers.some((viewer) => Object.keys(viewer.requestsByPath).length > 0)) return fail('RC2', 'a viewer link requested media from a choosing host');
  if (reading.counters.responseRecords.some((record) => record.urlPath.startsWith('/media/'))) return fail('RC2', 'server recorded media before a ready report');
  return pass('RC2', 'the refused fixture leaves both viewers choosing without media requests');
}

// titleName is #title-name's text: R-Name reads the element, not the seam (12a D1 F5).
function member(value) {
  return object(value) && title(value.title) && state(value.state) && typeof value.titleName === 'string';
}

function rc3Poll(value, expected) {
  return Array.isArray(value) && value.length > 0 && value.every((poll) => Array.isArray(poll.members)
    && poll.members.length === 3 && poll.members.every((entry) => member(entry) && typeof entry.videoPaused === 'boolean'));
}

export function rc3(reading) {
  if (!object(reading) || !object(reading.expected) || !text(reading.expected.identity) || !text(reading.expected.name)
    || !Array.isArray(reading.members) || reading.members.length !== 3 || !reading.members.every(member)
    || !finite(reading.stableMs) || !rc3Poll(reading.stablePolls, reading.expected)) return missing('RC3');
  const all = [...reading.members, ...reading.stablePolls.flatMap((poll) => poll.members)];
  const bad = all.find((entry) => entry.title.title !== reading.expected.identity || entry.title.name !== reading.expected.name
    || entry.titleName !== reading.expected.name || entry.state.playing || entry.state.positionMs !== 0 || entry.state.held);
  if (reading.stablePolls.some((poll) => poll.members.some((entry) => !entry.videoPaused))) return fail('RC3', 'a video element played during the title A observation');
  if (reading.stableMs < 3000) return fail('RC3', 'the paused title A observation was shorter than three seconds');
  return bad ? fail('RC3', 'title A was not paused at zero on every member') : pass('RC3', 'title A is named and paused at zero without automatic start');
}

export function rc4(reading) {
  if (!object(reading) || !Array.isArray(reading.frames) || reading.frames.length !== 2 || !reading.frames.every(frames)
    || !Array.isArray(reading.swarmIds) || reading.swarmIds.length !== 2 || !reading.swarmIds.every(text)
    || !text(reading.expectedSwarmId)) return missing('RC4');
  const advances = reading.frames.map((entries) => Math.max(...entries.map((entry) => entry.mediaTime)) - Math.min(...entries.map((entry) => entry.mediaTime)));
  if (advances.some((value) => value < 5)) return fail('RC4', 'a viewer did not present five seconds of advancing media');
  if (reading.swarmIds.some((swarmId) => swarmId !== reading.expectedSwarmId) || reading.swarmIds[0] !== reading.swarmIds[1]) return fail('RC4', 'viewer swarm ids do not equal the room and title A swarm');
  return pass('RC4', 'both viewers play and share the room/title A swarm');
}

function reloadIdentity(value) {
  return object(value) && text(value.lineage) && integer(value.version);
}

function reloadShape(value) {
  if (!object(value) || !reloadIdentity(value.preIdentity) || !Array.isArray(value.polls) || value.polls.length === 0
    || !value.polls.every(viewerPoll) || !object(value.rejoined) || !Array.isArray(value.rejoined.viewers)
    || value.rejoined.viewers.length !== 2 || !value.rejoined.viewers.every((viewer) => object(viewer)
      && typeof viewer.rosterHasHost === 'boolean' && typeof viewer.reportReady === 'boolean')
    || !text(value.hostFileState) || !object(value.after) || !Array.isArray(value.after.viewers)
    || value.after.viewers.length !== 2 || !value.after.viewers.every(member)
    || !nonNegative(value.reloadToRejoinMs) || !nonNegative(value.reloadToReadyMs) || typeof value.sawHostless !== 'boolean') return false;
  return true;
}

function reloadEntry(value, expected) {
  if (!reloadShape(value)) return false;
  if (value.polls.some((poll) => poll.viewers.some((viewer) => !viewer.state.playing))) return false;
  if (value.rejoined.viewers.some((viewer) => viewer.rosterHasHost !== true || viewer.reportReady !== true) || value.hostFileState !== 'ready') return false;
  return value.after.viewers.every((viewer) => viewer.state.lineage === value.preIdentity.lineage
    && viewer.state.version === value.preIdentity.version && viewer.title.title === expected.identity && viewer.title.name === expected.name);
}

export function rc5(reading) {
  if (!object(reading) || !object(reading.expected) || !text(reading.expected.identity) || !text(reading.expected.name)
    || !Array.isArray(reading.reloads) || reading.reloads.length !== 5 || !reading.reloads.every(reloadShape)) return missing('RC5');
  const bad = reading.reloads.findIndex((reload) => !reloadEntry(reload, reading.expected));
  return bad === -1 ? pass('RC5', 'five host reloads rejoin without pausing or changing title A') : fail('RC5', `reload ${bad + 1} did not preserve playing title A`);
}

function graceShape(value) {
  return object(value) && object(value.grace) && nonNegative(value.grace.startedAtSharedMs)
    && nonNegative(value.grace.endsAtSharedMs) && value.grace.endsAtSharedMs >= value.grace.startedAtSharedMs
    && object(value.prev) && state(value.prev) && object(value.paused) && state(value.paused)
    && object(value.hostPreparing) && text(value.hostPreparing.state) && text(value.hostPreparing.text)
    && typeof value.playDisabled === 'boolean';
}

// Post-result (12a C2, coordinator 2026-10-18): state.version is the envelope seq, so the spec's +1 clause
// is kept and reported, and this one-operation reading is added beside it for D1.
function oneOperation(versions, before) {
  return Array.isArray(versions) && versions.length === 2 && versions[0] === before && versions[1] > before;
}

const clause = (ok) => (ok ? 'PASS' : 'FAIL');

export function rc6(reading) {
  if (!object(reading) || !integer(reading.graceMs) || !integer(reading.gracePauses) || !Array.isArray(reading.viewers) || reading.viewers.length !== 2
    || !reading.viewers.every((viewer) => graceShape(viewer) && Array.isArray(viewer.versions) && viewer.versions.every(integer)
      && Array.isArray(viewer.polls) && viewer.polls.length > 0
      && viewer.polls.every((poll) => object(poll) && finite(poll.atSharedMs) && state(poll.state)))) return missing('RC6');
  const reasons = [];
  let plusOne = true;
  let single = reading.gracePauses === 1;
  for (const viewer of reading.viewers) {
    const { grace: interval, prev, paused } = viewer;
    if (paused.version !== prev.version + 1) plusOne = false;
    if (!oneOperation(viewer.versions, prev.version)) single = false;
    if (interval.endsAtSharedMs - interval.startedAtSharedMs !== reading.graceMs) reasons.push('grace interval differs from its setting');
    if (reading.graceMs !== 3000) reasons.push('grace setting is not 3000 ms');
    if (!viewer.polls.some((poll) => poll.atSharedMs < interval.endsAtSharedMs - 100)) reasons.push('no pre-end poll was captured');
    if (viewer.polls.some((poll) => poll.atSharedMs < interval.endsAtSharedMs - 100 && !poll.state.playing)) reasons.push('a pre-end poll was not playing');
    if (paused.lineage !== prev.lineage || paused.playing || paused.held) reasons.push('applied pause identity or state is wrong');
    if (viewer.hostPreparing.state !== 'absent' || viewer.hostPreparing.text !== 'the host has left' || viewer.playDisabled !== true) reasons.push('viewer does not show the absent host');
    if (!reading.viewers.some((other) => other.grace.endsAtSharedMs === paused.atSharedMs)) reasons.push('pause instant differs from every viewer grace end');
    if (paused.lineage !== reading.viewers[0].paused.lineage || paused.version !== reading.viewers[0].paused.version) reasons.push('viewers hold different pause identities');
    const expected = prev.positionMs + (paused.atSharedMs - prev.atSharedMs);
    if (Math.abs(paused.positionMs - expected) > 1) reasons.push('pause media position is not projected at grace end');
  }
  if (!plusOne) reasons.push('version +1 clause failed');
  if (!single) reasons.push('post-result one-operation assertion failed');
  const clauses = `+1 clause ${clause(plusOne)}; post-result one-operation ${clause(single)}`;
  return reasons.length ? fail('RC6', `${[...new Set(reasons)].join('; ')}; ${clauses}`) : pass('RC6', `both viewers pause once at the shared grace end and show the absent host; ${clauses}`);
}

function peerRecords(value) {
  return object(value) && Array.isArray(value.records) && value.records.every((record) => object(record)
    && (record.source !== 'p2p' || text(record.peerId))) && text(value.peerId)
    && Array.isArray(value.priorPeerIds) && value.priorPeerIds.every(text);
}

function bFrames(value) {
  return Array.isArray(value) && value.length > 0 && value.every(frames);
}

function oldFrames(value) {
  return Array.isArray(value) && value.every((entry) => object(entry) && finite(entry.mediaTime) && finite(entry.wallTime));
}

export function rc7(reading) {
  if (!object(reading) || !object(reading.expected) || !text(reading.expected.identity) || !text(reading.expected.name)
    || !integer(reading.expected.version) || !text(reading.expected.swarmId) || !text(reading.previousSwarmId)
    || !Array.isArray(reading.stateChanges) || reading.stateChanges.length !== 2
    || !reading.stateChanges.every((changes) => Array.isArray(changes) && changes.every((change) => object(change) && integer(change.version)))
    || !Array.isArray(reading.members) || reading.members.length !== 3 || !reading.members.every(member)
    || !Array.isArray(reading.swarmIds) || reading.swarmIds.length !== 2 || !reading.swarmIds.every(text)
    || !bFrames(reading.playFrames) || !peerRecords(reading.peerBytes?.[0]) || !peerRecords(reading.peerBytes?.[1])
    || !object(reading.precondition) || typeof reading.precondition.noOldFrame !== 'boolean') return missing('RC7');
  const reasons = [];
  if (reading.members.some((entry) => entry.title.title !== reading.expected.identity || entry.title.name !== reading.expected.name
    || entry.titleName !== reading.expected.name || entry.state.playing || entry.state.positionMs !== 0 || entry.state.held)) reasons.push('title B was not paused at zero on every member');
  const plusOne = reading.members.every((entry) => entry.state.version === reading.expected.version);
  // Post-result: from RC6's pause to the play press each viewer sees exactly one change, the title operation to B.
  const rc6Version = reading.expected.version - 1;
  const single = reading.stateChanges.every((changes) => oneOperation(changes.map((change) => change.version), rc6Version)
    && changes[1].title === reading.expected.identity);
  if (!plusOne) reasons.push('version +1 clause failed');
  if (!single) reasons.push('post-result one-operation assertion failed');
  const clauses = `+1 clause ${clause(plusOne)}; post-result one-operation ${clause(single)}`;
  if (reading.swarmIds.some((swarmId) => swarmId !== reading.expected.swarmId) || reading.swarmIds[0] !== reading.swarmIds[1] || reading.expected.swarmId === reading.previousSwarmId) reasons.push('viewer swarm ids do not identify a new room/title B swarm');
  if (reading.playFrames.some((entries) => entries[0].mediaTime > 1 || Math.max(...entries.map((entry) => entry.mediaTime)) - Math.min(...entries.map((entry) => entry.mediaTime)) < 5)) reasons.push('title B playback did not start near zero and advance five seconds');
  let noOld = 'NOT EXERCISED';
  if (reading.precondition.noOldFrame) {
    if (!Array.isArray(reading.oldFrames) || reading.oldFrames.length !== 2 || !reading.oldFrames.every(oldFrames)) return missing('RC7', 'no-old-frame evidence is missing or malformed');
    noOld = reading.oldFrames.every((entries) => entries.every((entry) => entry.mediaTime < 2)) ? 'PASS' : 'FAIL';
    if (noOld === 'FAIL') reasons.push('an old title A frame appeared after title B was shown');
  }
  const peerRecordsSeen = reading.peerBytes.some((value) => value.records.some((record) => record.source === 'p2p'));
  let peer = 'NOT EXERCISED';
  if (peerRecordsSeen) {
    const ids = reading.peerBytes.map((value) => value.records.filter((record) => record.source === 'p2p').map((record) => record.peerId));
    // peerId is the other viewer's current (title B) engine, which must be new since RC6 (12a D1 F4).
    const other = (index) => reading.peerBytes[1 - index];
    if (ids.some((values, index) => other(index).priorPeerIds.includes(other(index).peerId)
      || values.some((peerId) => peerId !== other(index).peerId))) peer = 'FAIL';
    else peer = 'PASS';
    if (peer === 'FAIL') reasons.push('peer byte records name the wrong viewer engine');
  }
  if (noOld === 'FAIL' || peer === 'FAIL') return fail('RC7', `no-old-frame ${noOld}; peer-bytes ${peer}; ${reasons.join('; ')}; ${clauses}`);
  return reasons.length ? fail('RC7', `${reasons.join('; ')}; ${clauses}`) : pass('RC7', `title B is new and paused; no-old-frame ${noOld}; peer-bytes ${peer}; ${clauses}`);
}

function parked(value) {
  return object(value) && state(value) && text(value.controlMode);
}

export function rc8(reading) {
  if (!object(reading) || !state(reading.created) || !parked(reading.seeked) || !parked(reading.reloaded)
    || !object(reading.noRoom) || reading.noRoom.sessionStorage !== null) return missing('RC8');
  if (reading.created.playing || reading.created.positionMs !== 0) return fail('RC8', 'the sole viewer did not create paused at zero');
  if ([reading.seeked, reading.reloaded].some((value) => value.playing || value.positionMs !== 30000 || value.held)) return fail('RC8', 'the stored state is not paused at 30 seconds');
  if (reading.reloaded.controlMode !== reading.seeked.controlMode) return fail('RC8', 'reload did not preserve control mode');
  return pass('RC8', 'the sole viewer stores 30 seconds and clears room state outside a room');
}

export function grace(reloads) {
  const valid = Array.isArray(reloads) ? reloads.filter((reload) => object(reload)
    && nonNegative(reload.reloadToReadyMs) && nonNegative(reload.reloadToRejoinMs)) : [];
  const maxReady = valid.length ? Math.max(...valid.map((reload) => reload.reloadToReadyMs)) : null;
  const maxRejoin = valid.length ? Math.max(...valid.map((reload) => reload.reloadToRejoinMs)) : null;
  if (valid.length < 5) return { outcome: 'provisional', maxReady, maxRejoin, replacementMs: null };
  if (2 * maxReady <= 10000) return { outcome: 'confirmed', maxReady, maxRejoin, replacementMs: null };
  return { outcome: 'replaced', maxReady, maxRejoin, replacementMs: Math.ceil(2 * maxReady / 1000) * 1000 };
}

export function exitCode(results) {
  if (!Array.isArray(results) || results.length !== ROWS.length || results.some((entry, index) => entry?.row !== ROWS[index])) return 1;
  return results.every((entry) => entry.verdict === 'PASS') ? 0 : 1;
}
