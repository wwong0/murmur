import { MANIFEST_NAME, lockName, storageFit, storeKey } from './prepared-store.mjs';

function errorMessage(error) {
  return `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`;
}

function manifestOf(result) {
  return JSON.parse(new TextDecoder().decode(result.bytes));
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
    return {
      mediaSource: 'file', targetSegmentSeconds: targetSeconds, state, origin, key, manifest,
      refusal, failure, storage, swept, workerCalls: { ...workerCalls },
      workerBuildId: client.buildId(), cleanup: 'next-host-page-start',
    };
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

  async function start() {
    if (started) return;
    started = true;
    try {
      const remembered = memory.get();
      if (remembered) held = await locks.hold(lockName(remembered));
      swept = await store.sweep({ keep: held ? remembered : null });
      const estimateValue = await estimate();
      storage = { quota: estimateValue?.quota ?? null, usage: estimateValue?.usage ?? null };
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
        refusal = { reason: inspected.reason, message: inspected.message };
        publish('refused');
        return;
      }
      if (inspected.t !== 'inspected') throw new Error(inspected.message ?? 'worker inspection failed');
      const tracks = [
        ['video', inspected.tracks?.video?.codec, 'video/mp4'],
        ...(inspected.tracks?.audio ? [['audio', inspected.tracks.audio.codec, 'audio/mp4']] : []),
      ];
      const unsupported = tracks.find(([, codec, type]) => !isTypeSupported(`${type}; codecs="${codec}"`));
      if (unsupported) {
        refusal = codecRefusal(unsupported[1]);
        publish('refused');
        return;
      }
      const estimateValue = await estimate();
      storage = { quota: estimateValue?.quota ?? null, usage: estimateValue?.usage ?? null };
      const fit = storageFit({ sourceBytes: inspected.sourceBytes, estimate: estimateValue });
      if (!fit.fits) {
        const free = fit.freeBytes === null ? 'unknown' : fit.freeBytes;
        refusal = {
          reason: 'storage', neededBytes: fit.neededBytes, freeBytes: fit.freeBytes,
          message: `storage: need ${fit.neededBytes} bytes, free ${free}`,
        };
        publish('refused');
        return;
      }
      key = storeKey({ identity: inspected.identity, targetSeconds });
      held = await locks.hold(lockName(key));
      if (held === null) {
        key = null;
        throw new Error('another tab is serving this title');
      }
      publish('preparing');
      workerCalls.prepare += 1;
      const prepared = await client.prepare(file, key, targetSeconds);
      if (prepared.t === 'refused') {
        refusal = { reason: prepared.reason, message: prepared.message };
        release();
        publish('refused');
        return;
      }
      if (prepared.t !== 'prepared') throw new Error(prepared.message ?? 'worker preparation failed');
      if (!await store.isComplete(key)) throw new Error('prepared output is incomplete');
      memory.set(key);
      manifest = prepared.manifest;
      origin = 'prepared';
      publish('ready');
    } catch (error) {
      if (error?.message === 'another tab is serving this title') fail(error.message);
      else fail(errorMessage(error));
    }
  }

  async function read(path) {
    if (state !== 'ready' || !path.startsWith('/media/')) return { status: 404, bytes: new Uint8Array() };
    return store.read(key, path.slice(7));
  }

  return { start, choose, read, snapshot };
}
