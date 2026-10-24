import { assert, assertEqual, check } from '../harness.mjs';
import { linkKind, linksText, LINKS_LINE_RE } from '../../../public/lib/link-kinds.mjs';

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
}
