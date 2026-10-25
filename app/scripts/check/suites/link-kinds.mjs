import { assert, assertEqual, check } from '../harness.mjs';
import { createLinkKinds, linkKind, linksText, LINKS_LINE_RE } from '../../../public/lib/link-kinds.mjs';

export default async function linkKindsSuite() {
  await check('link kinds: the selected pair decides direct versus relayed', async () => {
    assertEqual(linkKind({ relayed: false, candidateTypes: { local: 'host', remote: 'host' } }), 'direct', 'a host pair is direct');
    assertEqual(linkKind({ relayed: true, candidateTypes: { local: 'relay', remote: 'host' } }), 'relayed', 'a relay pair is relayed');
    assertEqual(linkKind(null), 'pending', 'no selected pair is pending');
  });

  await check('link kinds: gathered relay candidates do not relabel a selected host pair', async () => {
    const selectedHostPair = { relayed: false, candidateTypes: { local: 'host', remote: 'host' }, gathered: ['relay'] };
    assertEqual(linkKind(selectedHostPair), 'direct', 'gathered relay candidates are not selected');
  });

  await check('link kinds: the line includes direct, relayed and pending counts including zeroes', async () => {
    const line = linksText({ direct: 1, relayed: 0, pending: 1 });
    assertEqual(line, 'host links: 1 direct · 0 relayed · 1 pending', 'link count line');
    assert(LINKS_LINE_RE.test(line), 'link count line matches its published shape');
    assertEqual(linksText({ direct: 0, relayed: 0, pending: 0 }), 'host links: 0 direct · 0 relayed · 0 pending', 'closed links drop to zero');
  });

  await check('link kinds: a refresh counts only links still open when their reads return', async () => {
    const pc = (kind, state = 'connected') => ({ connectionState: state, iceConnectionState: state, getStats: async () => kind });
    const direct = pc('direct');
    const relayed = pc('relayed');
    const pending = pc(null);
    const gone = pc('direct');
    let open = [direct, relayed, pending, gone, pc('direct', 'closed')];
    const lines = [];
    const kinds = createLinkKinds({
      links: () => open,
      readStats: () => (kind) => (kind === null ? null : { relayed: kind === 'relayed' }),
      onChange: (line) => lines.push(line),
    });
    const refreshing = kinds.refresh();
    open = [direct, relayed, pending];
    await refreshing;
    assertEqual(lines.at(-1), 'host links: 1 direct · 1 relayed · 1 pending', 'closed and departed links are not counted');
    assertEqual(kinds.text(), lines.at(-1), 'the overlay text is the last count');
  });

  await check('link kinds: no read before the transport loads, and ticks are spaced', async () => {
    let reads = 0;
    let readStats = null;
    const kinds = createLinkKinds({
      links: () => [{ connectionState: 'connected', iceConnectionState: 'connected', getStats: async () => { reads += 1; return null; } }],
      readStats: () => readStats,
      onChange: () => {},
      intervalMs: 2_000,
    });
    await kinds.refresh();
    assertEqual(reads, 0, 'no stats are read without the transport');
    readStats = () => null;
    kinds.tick(10_000);
    kinds.tick(11_999);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEqual(reads, 1, 'a tick inside the interval reads nothing');
  });
}
