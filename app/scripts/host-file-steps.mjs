// Pure readings and verdicts for the host-file browser pass.

const STATUSES = new Set(['pass', 'fail', 'not exercised', 'evidence missing']);

function verdict(status, observed, reasons) {
  if (!STATUSES.has(status)) throw new TypeError(`unknown step status: ${status}`);
  return { status, observed: observed ?? null, reasons: Array.isArray(reasons) ? reasons : [String(reasons)] };
}

function missing(observed, reason = 'reading is absent or malformed') {
  return verdict('evidence missing', observed, [reason]);
}

function notExercised(observed, reason = 'precondition did not happen') {
  return verdict('not exercised', observed, [reason]);
}

function precondition(reading) {
  if (reading?.precondition === false) return notExercised(reading);
  if (!reading || typeof reading !== 'object') return missing(reading);
  return null;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function finiteNonNegative(value) {
  return finite(value) && value >= 0;
}

function finitePositive(value) {
  return finite(value) && value > 0;
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function framesOf(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((frame) => object(frame) && finite(frame.mediaTime) && finite(frame.wallTime))) return null;
  return value;
}

function sameNames(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && new Set(left).size === left.length
    && new Set(right).size === right.length
    && left.every((name) => right.includes(name));
}

function mediaRecord(record) {
  return object(record) && typeof record.urlPath === 'string' && record.urlPath.startsWith('/media/');
}

function mediaTotalsZero(counters) {
  const names = ['mediaBytesDelivered', 'segmentBytesDelivered', 'initBytesDelivered', 'playlistBytesDelivered', 'unattributedMediaBytesDelivered'];
  return object(counters) && names.every((name) => counters[name] === 0);
}

function exactWorkerCalls(value) {
  return object(value) && value.inspect === 1 && value.prepare === 1;
}

function noWorkerCalls(value) {
  return object(value) && value.inspect === 0 && value.prepare === 0;
}

function pageState(value) {
  return object(value) && typeof value.state === 'string';
}

function frameWindow(frames, lower, upper, afterWallTime = -Infinity) {
  return frames.some((frame) => frame.wallTime >= afterWallTime && frame.mediaTime >= lower && frame.mediaTime < upper);
}

function listingShape(value, allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) return false;
  return value.every((entry) => object(entry) && typeof entry.name === 'string' && Number.isSafeInteger(entry.size) && entry.size >= 0 && typeof entry.sha256 === 'string');
}

function noticesShape(value) {
  return Array.isArray(value) && value.every((notice) => typeof notice === 'string');
}

function bundleShape(value) {
  return object(value)
    && typeof value.servedSha256 === 'string'
    && typeof value.diskSha256 === 'string';
}

/** Return cumulative segment boundaries (the end of each segment). */
export function boundariesFromPlaylist(text) {
  if (typeof text !== 'string') return null;
  const durations = [...text.matchAll(/^#EXTINF:([^,\r\n]+),?\s*$/gm)].map((match) => Number(match[1]));
  if (durations.length === 0 || durations.some((duration) => !finitePositive(duration))) return null;
  const result = [];
  for (const duration of durations) result.push((result.at(-1) ?? 0) + duration);
  return result;
}

/** Pick the one-based segment numbers used by the seek steps. */
export function chooseSegments({ boundaries: values, count, position = 0 } = {}) {
  if (!Array.isArray(values) || values.length !== count || !Number.isInteger(count) || count < 2
    || values.some((value, i) => !finite(value) || (i > 0 && value <= values[i - 1])) || !finiteNonNegative(position)) return null;
  const firstLong = values.findIndex((value, i) => i < count - 1 && value >= position + 300);
  if (firstLong === -1) return { longFile: false, j: 2, m: 1 };
  return { longFile: true, j: firstLong + 1, m: firstLong + 3 };
}

/** True when a presented frame is within the spec's 1.5-frame tolerance of P. */
export function showsFrameAt(frames, position, frame, afterWallTime = -Infinity) {
  const values = framesOf(frames);
  if (!values || !finite(position) || !finitePositive(frame) || !(afterWallTime === -Infinity || finite(afterWallTime))) return null;
  return values.some((entry) => entry.wallTime >= afterWallTime && Math.abs(entry.mediaTime - position) <= 1.5 * frame);
}

function eventsAfterPlaying(events) {
  if (Array.isArray(events?.waitingAfterFirstPlaying)) return events.waitingAfterFirstPlaying.length;
  if (Number.isInteger(events?.waitingAfterFirstPlaying)) return events.waitingAfterFirstPlaying;
  if (Number.isInteger(events?.waiting)) return events.waiting;
  if (Array.isArray(events?.waiting)) {
    const firstPlaying = finite(events.firstPlayingWallTime) ? events.firstPlayingWallTime : -Infinity;
    return events.waiting.filter((event) => (finite(event?.wallTime) ? event.wallTime : Infinity) >= firstPlaying).length;
  }
  return null;
}

/** Return true when a playing window has a waiting event or a >1s frame gap. */
export function stallTest({ frames, events, polls, firstPlayingWallTime } = {}) {
  const values = framesOf(frames);
  if (!values || !object(events) || !Array.isArray(polls) || polls.length === 0 || !finite(firstPlayingWallTime)) return null;
  if (eventsAfterPlaying({ ...events, firstPlayingWallTime }) !== 0) return true;
  if (!polls.every((poll) => object(poll) && finite(poll.wallTime) && typeof poll.playing === 'boolean' && Number.isInteger(poll.frameCount) && poll.frameCount >= 0)) return null;
  const playingPolls = polls.filter((poll) => poll.playing && poll.wallTime >= firstPlayingWallTime);
  for (let i = 1; i < playingPolls.length; i += 1) {
    if (playingPolls[i].frameCount === playingPolls[i - 1].frameCount && playingPolls[i].wallTime - playingPolls[i - 1].wallTime > 1000) return true;
  }
  const playingFrames = values.filter((frame) => frame.wallTime >= firstPlayingWallTime);
  for (let i = 1; i < playingFrames.length; i += 1) {
    if (playingFrames[i].wallTime - playingFrames[i - 1].wallTime > 1000) return true;
  }
  return false;
}

export function s0(reading) {
  const early = precondition(reading);
  if (early) return early;
  const room = reading.bundles?.room ?? reading.roomBundle;
  const worker = reading.bundles?.worker ?? reading.workerBundle;
  if (!object(reading.settings) || typeof reading.settings.mediaSource !== 'string' || typeof reading.settings.delivery !== 'string'
    || !finite(reading.settings.targetSegmentSeconds) || !finite(reading.target) || typeof reading.pageBuildId !== 'string'
    || typeof reading.workerBuildId !== 'string' || !bundleShape(room) || !bundleShape(worker)
    || typeof room.pageIdInServed !== 'boolean') return missing(reading);
  const reasons = [];
  if (reading.settings.mediaSource !== 'file') reasons.push('settings media source is not file');
  if (reading.settings.delivery !== 'host') reasons.push('settings delivery is not host');
  if (reading.settings.targetSegmentSeconds !== reading.target) reasons.push('settings target differs from the run target');
  if (room.servedSha256 !== room.diskSha256) reasons.push('room bundle served hash differs from disk');
  if (worker.servedSha256 !== worker.diskSha256) reasons.push('worker bundle served hash differs from disk');
  if (!room.pageIdInServed) reasons.push('host page build id is absent from the served room bundle');
  if (reading.workerBuildId !== reading.pageBuildId) reasons.push('worker build id differs from the page build id');
  return verdict(reasons.length === 0 ? 'pass' : 'fail', reading, reasons.length ? reasons : ['settings and both bundles are fresh']);
}

export function s1(reading) {
  const early = precondition(reading);
  if (early) return early;
  if (!pageState(reading.host) || !pageState(reading.viewer) || !object(reading.counters) || !Array.isArray(reading.counters.responseRecords)) return missing(reading);
  const reasons = [];
  if (reading.host.state !== 'awaiting-file') reasons.push('host is not awaiting-file');
  if (reading.viewer.state !== 'absent') reasons.push('viewer host link is not absent');
  if (reading.counters.responseRecords.some(mediaRecord)) reasons.push('server recorded a media path before preparation');
  return verdict(reasons.length ? 'fail' : 'pass', reading, reasons.length ? reasons : ['viewer waits and no media record exists']);
}

export function s2(reading) {
  const early = precondition(reading);
  if (early) return early;
  const host = reading.host;
  if (!pageState(host) || !object(host.manifest) || !object(host.storage) || !object(host.workerCalls)
    || !finite(host.manifest.targetSeconds) || !Number.isSafeInteger(host.manifest.sourceBytes)
    || !('quota' in host.storage) || !('usage' in host.storage)) return missing(reading);
  const reasons = [];
  if (host.state !== 'ready') reasons.push('host is not ready');
  if (host.origin !== 'prepared') reasons.push('host origin is not prepared');
  if (!exactWorkerCalls(host.workerCalls)) reasons.push('worker call counts are not inspect=1 and prepare=1');
  if (host.manifest.targetSeconds !== reading.target) reasons.push('manifest target differs from run target');
  if (host.manifest.sourceBytes !== reading.fileBytes) reasons.push('manifest source size differs from the file');
  if (!finite(host.storage.quota) || !finite(host.storage.usage)) reasons.push('storage quota and usage are not finite');
  if (host.cleanup !== 'next-host-page-start') reasons.push('cleanup policy is not next-host-page-start');
  return verdict(reasons.length ? 'fail' : 'pass', reading, reasons.length ? reasons : ['prepared host published the expected manifest']);
}

export function s3(reading) {
  const early = precondition(reading);
  if (early) return early;
  if (!listingShape(reading.tab) || !listingShape(reading.reference) || typeof reading.key !== 'string' || typeof reading.expectedKey !== 'string') return missing(reading);
  const tabNames = reading.tab.map((entry) => entry.name);
  const referenceNames = reading.reference.map((entry) => entry.name);
  if (tabNames.length === 0 || referenceNames.length === 0) return missing(reading, 'a zero-file listing is not evidence of prepared output');
  const reasons = [];
  if (!sameNames(tabNames, referenceNames)) reasons.push('prepared file names differ from the reference');
  const referenceByName = new Map(reading.reference.map((entry) => [entry.name, entry]));
  for (const entry of reading.tab) {
    const expected = referenceByName.get(entry.name);
    if (!expected || entry.size !== expected.size || entry.sha256 !== expected.sha256) reasons.push(`prepared file differs: ${entry.name}`);
  }
  if (reading.key !== reading.expectedKey) reasons.push('prepared key differs from the reference identity key');
  return verdict(reasons.length ? 'fail' : 'pass', reading, reasons.length ? reasons : ['prepared files and key match']);
}

export function s4(reading) {
  const early = precondition(reading);
  if (early) return early;
  const values = framesOf(reading.frames);
  if (!values || !Array.isArray(reading.boundaries) || reading.boundaries.length < 1 || !finitePositive(reading.frame)
    || !reading.boundaries.every(finite)) return missing(reading);
  const start = reading.boundaries[0];
  const reasons = [];
  if (!frameWindow(values, start - 1, start)) reasons.push('host has no frame before the first boundary');
  if (!frameWindow(values, start, start + 1)) reasons.push('host has no frame at or after the first boundary');
  return verdict(reasons.length ? 'fail' : 'pass', reading, reasons.length ? reasons : ['host crossed the first boundary']);
}

export function s5(reading) {
  const early = precondition(reading);
  if (early) return early;
  const values = framesOf(reading.frames);
  if (!values || !Array.isArray(reading.boundaryIndexes) || !Array.isArray(reading.boundaries) || reading.boundaries.length < 1 || !finitePositive(reading.frame)
    || !reading.boundaries.every(finite)
    || !Array.isArray(reading.polls) || reading.polls.length === 0 || !object(reading.events) || !finite(reading.firstPlayingWallTime)) return missing(reading);
  const reasons = [];
  for (const index of reading.boundaryIndexes) {
    if (!Number.isInteger(index) || index < 0 || index >= reading.boundaries.length) return missing(reading, 'boundary index is malformed');
    const point = reading.boundaries[index];
    if (!frameWindow(values, point - 1, point) || !frameWindow(values, point, point + 1)) reasons.push(`viewer did not show frames on both sides of boundary ${index}`);
  }
  if (!reading.polls.every((poll) => object(poll) && poll.bufferedLength === 1)) reasons.push('viewer buffered length was not one at every poll');
  const stalled = stallTest({ frames: values, events: reading.events, polls: reading.polls, firstPlayingWallTime: reading.firstPlayingWallTime });
  if (stalled === null) return missing(reading, 'stall reading is malformed');
  if (stalled) reasons.push('viewer stalled while the room was playing');
  return verdict(reasons.length ? 'fail' : 'pass', reading, reasons.length ? reasons : ['viewer crossed boundaries without a stall']);
}

export function s6(reading) {
  const early = precondition(reading);
  if (early) return early;
  if (!pageState(reading.host) || !listingShape(reading.beforeListing) || !listingShape(reading.afterListing) || !framesOf(reading.frames)
    || !Array.isArray(reading.boundaries) || !reading.boundaries.every(finite) || !finitePositive(reading.minimumAdvance) || !finite(reading.mediaAdvance)
    || typeof reading.key !== 'string' || typeof reading.crossedBoundary !== 'boolean') return missing(reading);
  const reasons = [];
  if (reading.host.state !== 'ready' || reading.host.origin !== 'found') reasons.push('reload did not find the prepared title');
  if (!noWorkerCalls(reading.host.workerCalls)) reasons.push('reload called the worker');
  if (reading.host.key !== reading.key) reasons.push('reload changed the prepared key');
  if (JSON.stringify(reading.beforeListing) !== JSON.stringify(reading.afterListing)) reasons.push('reload changed the prepared listing');
  if (reading.mediaAdvance < reading.minimumAdvance) reasons.push('viewer did not advance the required media time');
  if (!reading.crossedBoundary) reasons.push('viewer did not cross a further boundary');
  return verdict(reasons.length ? 'fail' : 'pass', reading, reasons.length ? reasons : ['reload found the title and playback continued']);
}

export function s7a(reading) {
  const early = precondition(reading);
  if (early) return early;
  const values = framesOf(reading.frames);
  if (!values || !finite(reading.position) || !finitePositive(reading.frame) || !finite(reading.afterWallTime) || !finite(reading.target)) return missing(reading);
  const reasons = [];
  if (showsFrameAt(values, reading.target, reading.frame, reading.afterWallTime) !== true) reasons.push('viewer did not show a frame at the chosen segment start');
  if (reading.longFile) {
    if (!object(reading.requestsBefore) || !object(reading.requestsAfter) || typeof reading.targetPath !== 'string' || typeof reading.previousPath !== 'string') return missing(reading);
    if ((reading.requestsBefore[reading.targetPath] ?? 0) !== 0) reasons.push('target segment was requested before the seek');
    if (!((reading.requestsAfter[reading.targetPath] ?? 0) >= 1)) reasons.push('target segment was not requested by the seek');
    if ((reading.requestsAfter[reading.previousPath] ?? 0) !== 0) reasons.push('previous segment was requested by the seek');
  }
  return verdict(reasons.length ? 'fail' : 'pass', reading, reasons.length ? reasons : [reading.longFile ? 'seek loaded only the chosen segment' : 'short-file seek request clause declared not exercised']);
}

export function s7f(reading) {
  const early = precondition(reading);
  if (early) return early;
  if (!finite(reading.delta) || !finite(reading.target) || !Number.isSafeInteger(reading.segment) || reading.segment < 1
    || !finitePositive(reading.frame) || !finite(reading.mediaTime)
    || !object(reading.requestsBefore) || !object(reading.requestsAfter)) return missing(reading);
  const segmentPath = `/media/seg-${String(reading.segment).padStart(5, '0')}.m4s`;
  const reasons = [];
  if ((reading.requestsBefore[segmentPath] ?? 0) !== 0) reasons.push('target segment was requested before the seek');
  if ((reading.requestsAfter[segmentPath] ?? 0) < 1) reasons.push('target segment was not requested by the seek');
  for (const [path, after] of Object.entries(reading.requestsAfter)) {
    const match = /^\/media\/seg-(\d+)\.m4s$/.exec(path);
    if (match && Number(match[1]) < reading.segment && after > (reading.requestsBefore[path] ?? 0)) {
      reasons.push('an earlier segment was requested more often after the seek');
      break;
    }
  }
  if (Math.abs(reading.mediaTime - reading.target) > reading.frame / 2) reasons.push('the frame shown is not the target: one reorder delay per title does not hold here');
  return verdict(reasons.length ? 'fail' : 'pass', reading, reasons.length ? reasons : ['the seek loaded the target segment and showed its first presented frame']);
}

export function s7b(reading) {
  const early = precondition(reading);
  if (early) return early;
  const values = framesOf(reading.frames);
  if (!values || !finite(reading.target) || !finitePositive(reading.frame) || !finite(reading.afterWallTime)) return missing(reading);
  const reasons = frameWindow(values, reading.target - 1.5 * reading.frame, reading.target, reading.afterWallTime);
  return verdict(reasons ? 'pass' : 'fail', reading, [reasons ? 'viewer showed the chosen segment last frame' : 'viewer did not show the chosen segment last frame']);
}

export function s7c(reading) {
  const early = precondition(reading);
  if (early) return early;
  const values = framesOf(reading.frames);
  if (!values || !finite(reading.target) || !finitePositive(reading.frame) || !finite(reading.afterWallTime) || !object(reading.events)
    || !finitePositive(reading.duration) || !Number.isInteger(reading.events.ended)) return missing(reading);
  const last = values.at(-1);
  const reasons = [];
  if (showsFrameAt(values, reading.target, reading.frame, reading.afterWallTime) !== true) reasons.push('viewer did not show the last segment first frame');
  if (reading.events.ended !== 1) reasons.push('viewer did not report exactly one ended event');
  if (!finite(last.mediaTime) || last.mediaTime < reading.duration - 2 * reading.frame) reasons.push('last frame did not reach the reference duration');
  return verdict(reasons.length ? 'fail' : 'pass', reading, reasons.length ? reasons : ['viewer played the last segment to the end']);
}

/**
 * A diagnostic, added after S7c's result (tasks.md -> Decisions, 2026-10-12): the
 * same reading from a play that starts at least 4 s before the end. It says which
 * side an S7c failure lies on and earns the matrix nothing.
 */
export function s7d(reading) {
  const early = precondition(reading);
  if (early) return early;
  const values = framesOf(reading.frames);
  if (!values || !finite(reading.target) || !finitePositive(reading.frame) || !finite(reading.afterWallTime) || !object(reading.events)
    || !finitePositive(reading.duration) || !Number.isInteger(reading.events.ended)) return missing(reading);
  const reasons = [];
  if (reading.duration - reading.target < 4) reasons.push('the play was issued less than 4 s before the end');
  if (showsFrameAt(values, reading.target, reading.frame, reading.afterWallTime) !== true) reasons.push('viewer did not show the frame at the seek');
  if (reading.events.ended !== 1) reasons.push('viewer did not report exactly one ended event');
  if (values.at(-1).mediaTime < reading.duration - 2 * reading.frame) reasons.push('last frame did not reach the reference duration');
  return verdict(reasons.length ? 'fail' : 'pass', reading, reasons.length ? reasons : ['viewer played from 4 s or more before the end to the end']);
}

/**
 * A diagnostic, added after S7a's result (tasks.md -> Decisions, 2026-10-12): S7a's
 * request clause, with the seek made to the segment's first PRESENTED frame, which
 * sits `offset` after the playlist's cumulative time. Earns the matrix nothing.
 */
export function s7e(reading) {
  const early = precondition(reading);
  if (early) return early;
  const values = framesOf(reading.frames);
  if (!values || !finite(reading.target) || !finiteNonNegative(reading.offset) || !finitePositive(reading.frame) || !finite(reading.afterWallTime)
    || !object(reading.requestsBefore) || !object(reading.requestsAfter) || typeof reading.targetPath !== 'string' || typeof reading.previousPath !== 'string') return missing(reading);
  const reasons = [];
  if (showsFrameAt(values, reading.target, reading.frame, reading.afterWallTime) !== true) reasons.push('viewer did not show the first presented frame of the chosen segment');
  if ((reading.requestsBefore[reading.targetPath] ?? 0) !== 0) reasons.push('target segment was requested before the seek');
  if (!((reading.requestsAfter[reading.targetPath] ?? 0) >= 1)) reasons.push('target segment was not requested by the seek');
  if ((reading.requestsAfter[reading.previousPath] ?? 0) !== 0) reasons.push('previous segment was requested by the seek');
  return verdict(reasons.length ? 'fail' : 'pass', reading, reasons.length ? reasons : ['a seek to the first presented frame loaded only the chosen segment']);
}

export function s8(reading) {
  const early = precondition(reading);
  if (early) return early;
  const before = reading.before;
  const after = reading.after;
  if (!object(before) || !object(after) || !Array.isArray(before.responseRecords) || !Array.isArray(after.responseRecords)
    || !object(before.byClient) || !object(after.byClient) || !object(reading.control) || !finite(reading.control.status) || !object(reading.network)
    || !Number.isInteger(reading.network.bodyCount) || !Number.isInteger(reading.network.nonGetCount)) return missing(reading);
  const beforeMedia = before.responseRecords.filter(mediaRecord);
  const afterMedia = after.responseRecords.filter(mediaRecord);
  const control = afterMedia.find((record) => record.clientTag === 'pass-control' && record.kind === 'overhead');
  const reasons = [];
  if (!mediaTotalsZero(before) || Object.keys(before.byClient ?? {}).length !== 0 || beforeMedia.length !== 0) reasons.push('media was delivered or recorded before the control request');
  if (afterMedia.length !== 1 || !control) reasons.push('the control request did not create exactly one pass-control overhead record');
  if (reading.control.status !== 404) reasons.push('the control request did not return 404');
  if (reading.network.bodyCount !== 0) reasons.push('a page sent an HTTP request body');
  if (reading.network.nonGetCount !== 0) reasons.push('a page sent a non-GET origin request');
  return verdict(reasons.length ? 'fail' : 'pass', reading, reasons.length ? reasons : ['no page media request reached the server']);
}

export function s9(reading) {
  const early = precondition(reading);
  if (early) return early;
  const pages = [reading.host, reading.viewer];
  if (!pages.every((page) => object(page) && noticesShape(page.notices) && 'videoError' in page && object(page.quality)
    && Number.isInteger(page.quality.corruptedVideoFrames) && page.quality.corruptedVideoFrames >= 0
    && Number.isInteger(page.quality.totalVideoFrames) && page.quality.totalVideoFrames >= 0)) return missing(reading);
  const reasons = [];
  if (pages.some((page) => page.notices.some((notice) => notice.startsWith('player error:')))) reasons.push('a page reported a player error');
  if (pages.some((page) => page.videoError !== null)) reasons.push('a page video element has an error');
  if (pages.some((page) => page.quality.corruptedVideoFrames !== 0)) reasons.push('a page reported corrupted video frames');
  if (pages.some((page) => page.quality.totalVideoFrames <= 0)) reasons.push('a page reported no total video frames');
  if (reading.expectHeAac && (!finitePositive(reading.viewer.webkitAudioDecodedByteCount) || reading.viewer.webkitAudioDecodedByteCount <= 0)) reasons.push('viewer decoded no HE-AAC audio bytes');
  return verdict(reasons.length ? 'fail' : 'pass', reading, reasons.length ? reasons : ['both pages are healthy']);
}

export function s10(reading) {
  const early = precondition(reading);
  if (early) return early;
  if (!object(reading.h2) || !object(reading.h3) || !listingShape(reading.h2.listing, true) || !listingShape(reading.h2.beforeListing, true)
    || !Array.isArray(reading.h3.prepared)
    || !object(reading.h2.swept) || !object(reading.h3.swept) || typeof reading.key !== 'string') return missing(reading);
  const reasons = [];
  if (!Array.isArray(reading.h2.swept.kept) || !reading.h2.swept.kept.includes(reading.key) || !Array.isArray(reading.h2.swept.removed) || reading.h2.swept.removed.length !== 0) reasons.push('second host did not keep the held title');
  if (JSON.stringify(reading.h2.beforeListing) !== JSON.stringify(reading.h2.listing)) reasons.push('second host changed the held listing');
  if (!Array.isArray(reading.h3.swept.removed) || !reading.h3.swept.removed.includes(reading.key) || reading.h3.prepared.length !== 0) reasons.push('third host did not remove the released title');
  return verdict(reasons.length ? 'fail' : 'pass', reading, reasons.length ? reasons : ['held and released title sweeps differ as expected']);
}

export function s11(reading) {
  const early = precondition(reading);
  if (early) return early;
  if (!object(reading.host) || !object(reading.viewer) || typeof reading.viewer.state !== 'string' || !object(reading.host.refusal) || !Array.isArray(reading.prepared)) return missing(reading);
  const reasons = [];
  if (reading.host.refusal.reason !== 'video-codec') reasons.push('refused fixture did not report video-codec');
  if (typeof reading.host.refusal.message !== 'string' || !reading.host.refusal.message.includes('mp4v')) reasons.push('refusal did not name mp4v');
  if (reading.prepared.length !== 0) reasons.push('refused file left prepared output');
  if (reading.viewer.state !== 'absent') reasons.push('viewer link did not remain absent');
  return verdict(reasons.length ? 'fail' : 'pass', reading, reasons.length ? reasons : ['refused file stayed out of the room']);
}

export function s12(reading) {
  const early = precondition(reading);
  if (early) return early;
  if (!object(reading.host) || !object(reading.host.refusal) || !object(reading.reference) || typeof reading.reference.videoCodec !== 'string' || !Array.isArray(reading.prepared)) return missing(reading);
  const reasons = [];
  if (reading.host.refusal.reason !== 'codec-unplayable') reasons.push('wiring codec refusal has the wrong reason');
  if (typeof reading.host.refusal.message !== 'string' || !reading.host.refusal.message.includes(reading.reference.videoCodec)) reasons.push('wiring codec refusal does not name the reference codec');
  if (reading.prepared.length !== 0) reasons.push('wiring codec refusal left prepared output');
  return verdict(reasons.length ? 'fail' : 'pass', reading, reasons.length ? reasons : ['browser codec wiring refusal was observed']);
}

export function s13(reading) {
  const early = precondition(reading);
  if (early) return early;
  if (!object(reading.host) || !object(reading.host.refusal) || !Array.isArray(reading.prepared) || !Number.isSafeInteger(reading.fileBytes)) return missing(reading);
  const reasons = [];
  if (reading.host.refusal.reason !== 'storage') reasons.push('wiring storage refusal has the wrong reason');
  if (reading.host.refusal.neededBytes !== reading.fileBytes) reasons.push('storage refusal does not name the file size');
  if (reading.host.refusal.freeBytes !== 1000) reasons.push('storage refusal does not name the forced free bytes');
  if (reading.prepared.length !== 0) reasons.push('wiring storage refusal left prepared output');
  return verdict(reasons.length ? 'fail' : 'pass', reading, reasons.length ? reasons : ['browser storage wiring refusal was observed']);
}

export function exitCode(results, { mutationControl = false } = {}) {
  if (!Array.isArray(results)) return 2;
  let code = 0;
  for (const result of results) {
    if (!object(result) || typeof result.id !== 'string' || typeof result.status !== 'string') return 2;
    if (result.diagnostic === true) continue;
    if (result.status === 'evidence missing') return 2;
    if (result.status === 'not exercised') {
      code = Math.max(code, 1);
      continue;
    }
    if (result.status === 'fail') {
      if (!(mutationControl && result.id === 'S8')) code = Math.max(code, 1);
      continue;
    }
    if (result.status !== 'pass') return 2;
    if (mutationControl && result.id === 'S8') code = Math.max(code, 1);
  }
  return code;
}

