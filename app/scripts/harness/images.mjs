import { fileURLToPath } from 'node:url';

import { defaultExec } from '../../harness/apply-qdisc.mjs';
import { compose, PROJECT } from './topology.mjs';

const CLIENT_IMAGE = 'wa6a-client:latest';
const ORIGIN_IMAGE = 'wa6a-origin:latest';

function imageInspection(image, exec) {
  const rows = JSON.parse(exec(['docker', 'image', 'inspect', image]));
  const inspection = rows[0];
  if (typeof inspection?.Id !== 'string' || inspection.Id.length === 0) throw new Error(`image ${image} has no id`);
  return inspection;
}

const layersOf = (inspection) => inspection?.RootFS?.Layers ?? [];
const startsWith = (layers, prefix) => prefix.length > 0 && prefix.length < layers.length
  && prefix.every((layer, index) => layers[index] === layer);

// The image the origin was built on, by layers: BuildKit records neither `Parent`
// nor a history id (`<missing>`), so the parent is the local image whose whole
// layer chain is the longest proper prefix of the origin's.
function originParent(exec, originInspection) {
  const layers = layersOf(originInspection);
  const ids = String(exec(['docker', 'image', 'ls', '--all', '--quiet', '--no-trunc']))
    .split(/\s+/).map((line) => line.trim()).filter((id) => id && id !== originInspection.Id);
  let parent = null;
  for (const id of new Set(ids)) {
    const candidate = imageInspection(id, exec);
    const chain = layersOf(candidate);
    if (startsWith(layers, chain) && chain.length > (parent?.length ?? 0)) parent = { id: candidate.Id, length: chain.length };
  }
  if (!parent) throw new Error(`origin image ${ORIGIN_IMAGE} is built on no local image`);
  return parent.id;
}

export function buildImages({ exec = defaultExec } = {}) {
  compose(['build', 'c01'], { project: PROJECT, exec });
  const client = imageInspection(CLIENT_IMAGE, exec).Id;
  compose(['build', 'origin'], { project: PROJECT, exec });
  const originInspection = imageInspection(ORIGIN_IMAGE, exec);
  const origin = originInspection.Id;
  const originParentId = originParent(exec, originInspection);
  if (originParentId !== client) {
    throw new Error(`origin parent mismatch: originParent=${originParentId}; client=${client}`);
  }
  return { client, origin, originParent: originParentId };
}

function main() {
  const ids = buildImages();
  console.log(`client: ${ids.client}`);
  console.log(`origin: ${ids.origin}`);
  console.log(`originParent: ${ids.originParent}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
