const MEDIA = /\.(mp4|m4s|m4v|mkv|webm|mov|avi|ts|mp3|m4a|aac|flac|wav|ogg|opus)$/i;
const TEST = /(?:^|\/)test_videos(?:\/|$)/i;
const SECRET_PATH = /(?:^|\/)(?:[^/]*\.env|[^/]*\.(?:pem|key)|id_[^/]+)$/i;
const PERSONAL_PATH = /(?:^|\/)(?:\.scratch|\.coordinator|\.impeccable)(?:\/|$)/i;
const sample = (value) => `${value.slice(0, 4)}… (${value.length})`;
const hit = (classNo, sub, extra = {}) => ({ class: classNo, sub, ...extra });

export function parseTerms(text) {
  return text.split(/\r?\n/).map((line, i) => ({ value: line.trim(), line: i + 1 }))
    .filter(({ value }) => value && !value.startsWith('#'));
}

export function scanText(text, terms = []) {
  const hits = [];
  const sensitive = [];
  for (const term of terms) {
    let at = 0;
    const lower = text.toLowerCase(), needle = term.value.toLowerCase();
    while ((at = lower.indexOf(needle, at)) !== -1) {
      hits.push(hit(1, 'term', { sample: `term #${term.line}` }));
      at += needle.length;
    }
  }
  for (const m of text.matchAll(/-----BEGIN (?:[A-Z0-9]+ )*(?:PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/g)) {
    hits.push(hit(3, 'private-key', { sample: sample(m[0]) })); sensitive.push(m[0]);
  }
  const assignment = /["']?([A-Za-z0-9_.-]*(?:token|secret|key|password|passwd|turn|duckdns)[A-Za-z0-9_.-]*)["']?\s*[:=]\s*["']?([A-Za-z0-9_+\/=.-]{16,})/gi;
  for (const m of text.matchAll(assignment)) {
    hits.push(hit(3, 'assignment', { sample: `${m[1]}=${m[2].slice(0, 2)}… (${m[2].length})` })); sensitive.push(m[2]);
  }
  for (const m of text.matchAll(/\beyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\b/g)) {
    hits.push(hit(3, 'jwt', { sample: sample(m[0]) })); sensitive.push(m[0]);
  }
  for (const m of text.matchAll(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi)) {
    hits.push(hit(3, 'uuid', { sample: sample(m[0]) })); sensitive.push(m[0]);
  }
  const hosts = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    try {
      const url = new URL(m[0]);
      hosts.push(url.host);
      if (/[?&]room=/i.test(url.search)) {
        hits.push(hit(4, 'room-link', { sample: sample(m[0]) })); sensitive.push(m[0]);
        for (const [key, value] of url.searchParams) if (key.toLowerCase() === 'room' && value) sensitive.push(value);
      }
    } catch { /* malformed URL */ }
  }
  const profile = /(?:[A-Za-z]:(?:\\{1,2}|\/+)+Users(?:\\{1,2}|\/+)+|\/Users\/|\/home\/)([^\\/\r\n]+)/gi;
  for (const m of text.matchAll(profile)) {
    hits.push(hit(6, 'profile', { sample: `Users/${m[1][0]}…` })); sensitive.push(m[0]);
  }
  return { hits, hosts, sensitive };
}

export function pathKind(path) {
  const normalized = path.replaceAll('\\', '/');
  const ext = normalized.match(MEDIA)?.[1]?.toLowerCase();
  return { test: TEST.test(normalized), ext, first: normalized.split('/')[0] };
}

export function scanPath(path, size = 0, terms = []) {
  const normalized = path.replaceAll('\\', '/');
  const { test, ext } = pathKind(normalized);
  const hits = scanText(normalized, terms);
  if (SECRET_PATH.test(normalized)) hits.hits.push(hit(3, 'secret-path'));
  if (ext) hits.hits.push(hit(5, 'media'));
  if (test) hits.hits.push(hit(5, 'test-videos'));
  if (size > 50_000_000) hits.hits.push(hit(5, size > 100_000_000 ? 'over-100MB' : 'over-50MB', { size }));
  if (PERSONAL_PATH.test(normalized)) hits.hits.push(hit(6, 'committed-path'));
  return hits;
}

export function identityCounts(identities) {
  const emails = new Set(identities.map((identity) => identity.email.toLowerCase()));
  return { distinct: emails.size, nonNoreply: [...emails].filter((email) => !email.endsWith('@users.noreply.github.com')).length };
}
