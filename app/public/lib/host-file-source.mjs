import { MANIFEST_NAME, lockName, storageFit, storeKey } from './prepared-store.mjs';

function errorMessage(error) {
  return `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`;
}

function manifestOf(result) {
  return JSON.parse(new TextDecoder().decode(result.bytes));
}

// The one shape __app.hostFile() reports, whether or not this page has a source.
export function hostFileSnapshot({
  mediaSource, targetSegmentSeconds, state = 'off', origin = null, key = null, manifest = null, refusal = null,
  failure = null, storage = null, swept = null, workerCalls = { inspect: 0, prepare: 0 }, workerBuildId = null,
}) {
  return {
    mediaSource, targetSegmentSeconds, state, origin, key, manifest,
    refusal, failure, storage, swept, workerCalls,
    workerBuildId, cleanup: 'next-host-page-start',
  };
}

function storageOf(estimateValue) {
  return { quota: estimateValue?.quota ?? null, usage: estimateValue?.usage ?? null };
}

export function createHostFileSource({ store, locks, memory, client, isTypeSupported, estimate, targetSeconds, onChange }) {
  let state = 'starting';
  let origin = null;
  let key = null;
  let manifest = null;
  let refusal = null;
  let failure = null;
  let storage = null;
  let swept = null;
  let held = null;
  let started = false;
  const workerCalls = { inspect: 0, prepare: 0 };

  function snapshot() {
    return hostFileSnapshot({
      mediaSource: 'file', targetSegmentSeconds: targetSeconds, state, origin, key, manifest,
      refusal, failure, storage, swept, workerCalls: { ...workerCalls }, workerBuildId: client.buildId(),
    });
  }

  function publish(next) {
    state = next;
    onChange(snapshot());
  }

  function release() {
    if (!held) return;
    held();
    held = null;
  }

  function fail(message) {
    release();
    key = null;
    failure = message;
    publish('failed');
  }

  function refuse(next) {
    release();
    refusal = next;
    publish('refused');
  }

  async function start() {
    if (started) return;
    started = true;
    try {
      const remembered = memory.get();
      if (remembered) held = await locks.hold(lockName(remembered));
      swept = await store.sweep({ keep: held ? remembered : null });
      storage = storageOf(await estimate());
      if (held && await store.isComplete(remembered)) {
        const result = await store.read(remembered, MANIFEST_NAME);
        key = remembered;
        origin = 'found';
        manifest = manifestOf(result);
        publish('ready');
        return;
      }
      release();
      memory.clear();
      publish('awaiting-file');
    } catch (error) {
      fail(errorMessage(error));
    }
  }

  function codecRefusal(codec) {
    return {
      reason: 'codec-unplayable', codec,
      message: `codec-unplayable: browser cannot play ${codec}`,
    };
  }

  async function choose(file) {
    if (!['awaiting-file', 'refused', 'failed'].includes(state)) return;
    refusal = null;
    failure = null;
    origin = null;
    key = null;
    manifest = null;
    publish('inspecting');
    try {
      workerCalls.inspect += 1;
      const inspected = await client.inspect(file);
      if (inspected.t === 'refused') {
        refuse({ reason: inspected.reason, message: inspected.message });
        return;
      }
      if (inspected.t !== 'inspected') throw new Error(inspected.message ?? 'worker inspection failed');
      const tracks = [
        ['video', inspected.tracks?.video?.codec, 'video/mp4'],
        ...(inspected.tracks?.audio ? [['audio', inspected.tracks.audio.codec, 'audio/mp4']] : []),
      ];
      const unsupported = tracks.find(([, codec, type]) => !isTypeSupported(`${type}; codecs="${codec}"`));
      if (unsupported) {
        refuse(codecRefusal(unsupported[1]));
        return;
      }
      const estimateValue = await estimate();
      storage = storageOf(estimateValue);
      const fit = storageFit({ sourceBytes: inspected.sourceBytes, estimate: estimateValue });
      if (!fit.fits) {
        const free = fit.freeBytes === null ? 'unknown' : fit.freeBytes;
        refuse({
          reason: 'storage', neededBytes: fit.neededBytes, freeBytes: fit.freeBytes,
          message: `storage: need ${fit.neededBytes} bytes, free ${free}`,
        });
        return;
      }
      key = storeKey({ identity: inspected.identity, targetSeconds });
      held = await locks.hold(lockName(key));
      if (held === null) {
        fail('another tab is serving this title');
        return;
      }
      publish('preparing');
      workerCalls.prepare += 1;
      const prepared = await client.prepare(file, key, targetSeconds);
      if (prepared.t === 'refused') {
        refuse({ reason: prepared.reason, message: prepared.message });
        return;
      }
      if (prepared.t !== 'prepared') throw new Error(prepared.message ?? 'worker preparation failed');
      if (!await store.isComplete(key)) throw new Error('prepared output is incomplete');
      memory.set(key);
      manifest = prepared.manifest;
      origin = 'prepared';
      publish('ready');
    } catch (error) {
      fail(errorMessage(error));
    }
  }

  async function read(path) {
    if (state !== 'ready' || !path.startsWith('/media/')) return { status: 404, bytes: new Uint8Array() };
    return store.read(key, path.slice(7));
  }

  return { start, choose, read, snapshot };
}
