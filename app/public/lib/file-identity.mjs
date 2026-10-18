const RANGE = 1024 * 1024;
const COUNT = 16;
// Encoded at use: the page bundle loads this module through envelope.mjs.
const LABEL_TEXT = 'watchalong-file-identity v1\n';

export const FILE_IDENTITY_PATTERN = /^v1:[0-9a-f]{64}$/;

function hex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function ranges(size) {
  if (size === 0) return [];
  if (size <= COUNT * RANGE) {
    const out = [];
    for (let offset = 0; offset < size; offset += RANGE) out.push({ offset, length: Math.min(RANGE, size - offset) });
    return out;
  }
  return Array.from({ length: COUNT }, (_, i) => ({ offset: Math.floor(i * (size - RANGE) / (COUNT - 1)), length: RANGE }));
}

async function digest(bytes) {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
}

export async function fileIdentity(source) {
  const digests = [];
  for (const range of ranges(source.size)) {
    const bytes = await source.read(range.offset, range.length);
    if (!(bytes instanceof Uint8Array) || bytes.length !== range.length) throw new Error('identity source returned the wrong range length');
    digests.push(await digest(bytes));
  }
  const size = new Uint8Array(8);
  new DataView(size.buffer).setBigUint64(0, BigInt(source.size));
  const LABEL = new TextEncoder().encode(LABEL_TEXT);
  const material = new Uint8Array(LABEL.length + size.length + digests.length * 32);
  material.set(LABEL);
  material.set(size, LABEL.length);
  digests.forEach((value, i) => material.set(value, LABEL.length + size.length + i * 32));
  return `v1:${hex(await digest(material))}`;
}
