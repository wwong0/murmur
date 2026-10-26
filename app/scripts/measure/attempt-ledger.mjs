// The runner names a directory `<arm>-<condition>-<ISO stamp>` (`harness-run.mjs` `defaultRunDir`); the stamp
// keeps `edge` from claiming `edge-drop`'s directories.
function runDirectoryOf(name, slug) {
  const at = name.indexOf(`${slug}-`);
  return (at === 0 || (at > 0 && /^[0-9][0-9a-z]*-$/.test(name.slice(0, at))))
    && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/.test(name.slice(at + slug.length + 1));
}

function timeoutFailure(value) {
  return (value?.failures ?? []).some((failure) => /deadline|timed? ?out/i.test(String(failure?.message ?? '')));
}

function refusalReasons(manifest, finalization) {
  const reasons = [];
  if (finalization?.reason && finalization.reason !== 'published') reasons.push(finalization.reason);
  for (const failure of manifest?.failures ?? []) if (failure?.message) reasons.push(failure.message);
  for (const reason of manifest?.refusalReasons ?? []) reasons.push(reason);
  return [...new Set(reasons)];
}

function outcomeOf(manifest, finalization) {
  if (!manifest) return 'no-manifest';
  if (manifest.status === 'aborted') return timeoutFailure(manifest) ? 'timed-out' : 'aborted';
  if (manifest.status === 'refused' || finalization?.reason === 'publication-refusal') return 'refused';
  return 'published';
}

export function attemptLedger({ registry, manifests = {}, finalizations = {}, resultNames = [] } = {}) {
  const entries = (registry?.runs ?? []).map((entry) => {
    const directory = entry?.directory;
    const manifest = manifests instanceof Map ? manifests.get(directory) : manifests[directory];
    const finalization = finalizations instanceof Map ? finalizations.get(directory) : finalizations[directory];
    return {
      directory,
      condition: entry?.condition ?? manifest?.condition?.name ?? null,
      status: manifest?.status ?? null,
      outcome: outcomeOf(manifest, finalization),
      refusalReasons: refusalReasons(manifest, finalization),
    };
  });
  const registered = new Set(entries.map((entry) => entry.directory));
  const slugs = [...new Set(entries.map((entry) => String(entry.condition ?? '').replaceAll('/', '-').replaceAll(':', '-'))
    .filter(Boolean))];
  const unregistered = (resultNames ?? []).filter((name) => slugs.some((slug) => runDirectoryOf(name, slug))
    && !registered.has(name)).map((name) => ({ directory: name, outcome: 'unregistered' }));
  return { entries, unregistered };
}
