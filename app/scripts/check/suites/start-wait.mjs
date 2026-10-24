import { assert, assertEqual, check } from '../harness.mjs';
import {
  createStartWait,
  startWaitText,
  START_WAIT_LINE_RE,
  START_WAIT_LINE_WAITING,
} from '../../../public/lib/start-wait.mjs';

export default async function startWaitSuite() {
  await check('start wait: one asked instant and first frame produce the published line', async () => {
    const wait = createStartWait();
    assertEqual(startWaitText(wait.waitMs()), START_WAIT_LINE_WAITING, 'before asked and frame is waiting');
    assert(wait.asked(1_000), 'the first asked instant is accepted');
    assertEqual(startWaitText(wait.waitMs()), START_WAIT_LINE_WAITING, 'after asked before frame is waiting');
    assert(wait.framePresented(3_250), 'the first frame is accepted');
    assertEqual(wait.waitMs(), 2_250, 'wait duration');
    const line = startWaitText(wait.waitMs());
    assert(START_WAIT_LINE_RE.test(line), 'measured line matches its published shape');
  });

  await check('start wait: a second asked instant cannot change the first start', async () => {
    const wait = createStartWait();
    wait.asked(1_000);
    assert(!wait.asked(2_000), 'a second asked instant is ignored');
    wait.framePresented(3_250);
    assertEqual(wait.waitMs(), 2_250, 'the first asked instant remains authoritative');
    wait.reset();
    assertEqual(startWaitText(wait.waitMs()), START_WAIT_LINE_WAITING, 'reset returns to waiting');
    assert(!START_WAIT_LINE_RE.test(START_WAIT_LINE_WAITING), 'waiting is not the measured shape');
  });

  await check('start wait: a frame before asked is ignored and negative wait is refused', async () => {
    const wait = createStartWait();
    assert(!wait.framePresented(500), 'a frame before asked is ignored');
    wait.asked(1_000);
    let threw = false;
    try { wait.framePresented(999); } catch { threw = true; }
    assert(threw, 'a negative wait cannot be published');
  });
}
