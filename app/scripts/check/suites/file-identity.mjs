import crypto from 'node:crypto';
import { assert, assertEqual, check } from '../harness.mjs';
import { fileIdentity } from '../../../public/lib/file-identity.mjs';

const RANGE = 1024 * 1024;
const COUNT = 16;

function sourceFor(bytes, strict = false) {
  const source = {
    size: bytes.length,
    reads: [],
    async read(offset, length) {
      source.reads.push({ offset, length });
      return bytes.slice(offset, offset + length);
    },
  };
  return strict ? new Proxy(source, { get(target, property) {
    if (property !== 'size' && property !== 'read') throw new Error(`unexpected source property: ${String(property)}`);
    return target[property];
  } }) : source;
}

function ranges(size) {
  if (size <= COUNT * RANGE) {
    const out = [];
    for (let offset = 0; offset < size; offset += RANGE) out.push({ offset, length: Math.min(RANGE, size - offset) });
    return out;
  }
  return Array.from({ length: COUNT }, (_, i) => ({ offset: Math.floor(i * (size - RANGE) / 15), length: RANGE }));
}

async function reference(bytes) {
  const label = Buffer.from('watchalong-file-identity v1\n');
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(bytes.length));
  const hashes = ranges(bytes.length).map(({ offset, length }) => crypto.createHash('sha256').update(bytes.subarray(offset, offset + length)).digest());
  return `v1:${crypto.createHash('sha256').update(Buffer.concat([label, size, ...hashes])).digest('hex')}`;
}

export default async function fileIdentitySuite() {
  await check('file-identity: same bytes and only source size/read produce one identity', async () => {
    const bytes = Uint8Array.from({ length: RANGE + 17 }, (_, i) => i & 255);
    const first = sourceFor(bytes, true);
    const second = sourceFor(bytes, true);
    assertEqual(await fileIdentity(first), await fileIdentity(second), 'same bytes have same identity');
  });

  await check('file-identity: sixteen sampled ranges and size are identity inputs', async () => {
    const size = 20 * RANGE;
    const base = new Uint8Array(size);
    const cases = [
      ['first', 0],
      ['last', size - 1],
      ['range seven', ranges(size)[7].offset],
      ['between ranges', RANGE + 1000],
    ];
    const identities = [];
    for (const [, offset] of cases) {
      const bytes = base.slice();
      bytes[offset] = 1;
      identities.push(await fileIdentity(sourceFor(bytes)));
    }
    assert(new Set(identities.slice(0, 3)).size === 3, 'bytes in sampled ranges change identity');
    assertEqual(identities[3], await fileIdentity(sourceFor(base)), 'an unsampled byte does not change identity');
    const padded = new Uint8Array(size + 1);
    assert(identities[3] !== await fileIdentity(sourceFor(padded)), 'size changes identity even when samples agree');
    const logged = sourceFor(base);
    await fileIdentity(logged);
    assertEqual(await fileIdentity(sourceFor(base)), await reference(base), 'a 20 MiB identity matches the construction written with node:crypto');
    assertEqual(logged.reads.length, COUNT, 'a large file is read in sixteen ranges');
    assertEqual(logged.reads[0].offset, 0, 'the first range starts the file');
    assertEqual(logged.reads.at(-1).offset + RANGE, size, 'the last range ends the file');
    assertEqual(Math.max(...logged.reads.map((read) => read.length)), RANGE, 'no range exceeds one MiB');
    assertEqual(logged.reads.reduce((sum, read) => sum + read.length, 0), COUNT * RANGE, 'large identity reads sixteen MiB');
  });

  await check('file-identity: small files are hashed whole and match the construction', async () => {
    const bytes = Uint8Array.from({ length: 3 * RANGE + 5 }, (_, i) => (i * 17) & 255);
    assertEqual(await fileIdentity(sourceFor(bytes)), await reference(bytes), 'small identity matches the independent construction');
    const offsets = [0, RANGE - 1, RANGE + 123, 2 * RANGE + 2, bytes.length - 1];
    const identities = [];
    for (const offset of offsets) {
      const changed = bytes.slice();
      changed[offset] ^= 1;
      identities.push(await fileIdentity(sourceFor(changed)));
    }
    assertEqual(new Set(identities).size, offsets.length, 'every changed byte in a small file changes identity');
    assert(/^v1:[0-9a-f]{64}$/.test(identities[0]), 'identity has the versioned lowercase hex shape');
    assertEqual(await fileIdentity(sourceFor(new Uint8Array(0))), await reference(new Uint8Array(0)), 'an empty file has an identity and no range');
  });
}
