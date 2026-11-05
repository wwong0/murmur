// The NC row evaluator: missing evidence is never a pass, and a row that did not happen is not a fail.

import { assertEqual, check } from '../harness.mjs';
import { evaluateAll, evaluateRow, inOrder, ROW_IDS, STATUS } from '../../names-and-chat-steps.mjs';

const GOOD = {
  NC0: { bundleMatches: true, pageIdInServed: true, chromeRecorded: true },
  NC1: { hostAnswered: true, viewerAnswered: true, hostListNames: 2, viewerListNames: 2, rosterRows: 2, rosterShaped: 2, rosterNameHits: 0 },
  NC2: { renameAnswered: true, hostRenameLines: 1, viewerRenameLines: 1 },
  NC3: { reloaded: true, renamed: true, promptSamplesShown: 0, storagePresent: true, hostListHasName: true, viewerListHasName: true },
  NC4: { sent: true, hostOrdered: true, viewerOrdered: true },
  NC5: { sent: true, literalOnHost: true, literalOnViewer: true, boldElements: 0, fitsOnHost: true, fitsOnViewer: true },
  NC6: { sends: 3, burst: 5, warnedViewer: 1, warnedHost: 0, inputHolds: true, hostHasRefused: false },
  NC7: { noticeHits: 0, rosterHits: 0, serverHits: 0, serverLines: 4 },
};

export default async function namesAndChatStepsSuite() {
  await check('names-and-chat-steps: complete good evidence passes every row', async () => {
    assertEqual(evaluateAll(GOOD).map((row) => row.status).join(','), ROW_IDS.map(() => STATUS.PASS).join(','), 'statuses');
  });

  await check('names-and-chat-steps: absent evidence, or a missing field, reads EVIDENCE MISSING and never PASS', async () => {
    for (const id of ROW_IDS) {
      assertEqual(evaluateRow(id, undefined).status, STATUS.MISSING, `${id} with no evidence`);
      assertEqual(evaluateRow(id, null).status, STATUS.MISSING, `${id} with null`);
      for (const key of Object.keys(GOOD[id])) {
        const { [key]: _dropped, ...rest } = GOOD[id];
        assertEqual(evaluateRow(id, rest).status, STATUS.MISSING, `${id} without ${key}`);
      }
    }
    assertEqual(evaluateRow('NC99', GOOD.NC0).status, STATUS.MISSING, 'an unknown row');
  });

  await check('names-and-chat-steps: each row turns FAIL when its own condition breaks', async () => {
    const broken = {
      NC0: { bundleMatches: false }, NC1: { rosterNameHits: 1 }, NC2: { viewerRenameLines: 0 }, NC3: { promptSamplesShown: 2 },
      NC4: { viewerOrdered: false }, NC5: { boldElements: 1 }, NC6: { warnedHost: 1 }, NC7: { serverHits: 1 },
    };
    for (const id of ROW_IDS) assertEqual(evaluateRow(id, { ...GOOD[id], ...broken[id] }).status, STATUS.FAIL, id);
    assertEqual(evaluateRow('NC6', { ...GOOD.NC6, sends: 7 }).status, STATUS.FAIL, 'more than burst + 1 sends');
    assertEqual(evaluateRow('NC6', { ...GOOD.NC6, sends: 6 }).status, STATUS.PASS, 'burst + 1 sends');
  });

  await check('names-and-chat-steps: a row whose precondition did not happen is NOT EXERCISED, not a fail', async () => {
    assertEqual(evaluateRow('NC1', { ...GOOD.NC1, viewerAnswered: false }).status, STATUS.NOT_EXERCISED, 'no prompt answered');
    assertEqual(evaluateRow('NC7', { ...GOOD.NC7, serverLines: 0 }).status, STATUS.NOT_EXERCISED, 'no server line captured');
    assertEqual(evaluateRow('NC6', { ...GOOD.NC6, sends: 0 }).status, STATUS.NOT_EXERCISED, 'nothing sent');
    assertEqual(evaluateRow('NC3', { ...GOOD.NC3, renamed: false, hostListHasName: false }).status, STATUS.NOT_EXERCISED, 'no rename to keep');
  });

  await check('names-and-chat-steps: order needs both lines, the first above the second', async () => {
    assertEqual(inOrder(['a hello', 'b hi'], 'hello', 'hi'), true, 'in order');
    assertEqual(inOrder(['b hi', 'a hello'], 'hello', 'hi'), false, 'swapped');
    assertEqual(inOrder(['a hello'], 'hello', 'hi'), false, 'one missing');
  });
}
