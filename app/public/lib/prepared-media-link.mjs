import { sliceForRange } from './segment-protocol.mjs';

export function createPreparedMediaLink({ read }) {
  return {
    request({ path, range, handlers }) {
      let aborted = false;
      let ended = false;
      Promise.resolve().then(async () => {
        const result = await read(path);
        if (aborted) return;
        const slice = sliceForRange(result.bytes.byteLength, range);
        handlers.onHead({ status: result.status === 200 ? slice.status : result.status, length: slice.length, total: result.bytes.byteLength });
        if (slice.length > 0) handlers.onChunk(result.bytes.slice(slice.start, slice.end + 1));
        if (!aborted) {
          ended = true;
          handlers.onEnd();
        }
      }).catch(() => {
        if (!aborted) handlers.onError();
      });
      return { abort() { if (!ended) aborted = true; } };
    },
  };
}
