import { assertEqual, check } from '../harness.mjs';
import { namePromptDue } from '../../../public/lib/name-prompt.mjs';

export default async function namePromptSuite() {
  await check('name-prompt: a plain invite link is due', async () => {
    assertEqual(namePromptDue('?room=r', null), true, 'no flag');
    assertEqual(namePromptDue('?room=r', ''), true, 'an empty flag is not the flag');
    assertEqual(namePromptDue('?room=r&other=1', null), true, 'a parameter that is not role or tab');
  });

  await check('name-prompt: a role or a tab on the link is never due', async () => {
    assertEqual(namePromptDue('?room=r&tab=t', null), false, 'tab only');
    assertEqual(namePromptDue('?room=r&role=viewer', null), false, 'role viewer');
    assertEqual(namePromptDue('?room=r&role=host&tab=t', null), false, 'role and tab');
  });

  await check('name-prompt: no room is never due', async () => {
    assertEqual(namePromptDue('', null), false, 'empty search');
    assertEqual(namePromptDue('?room=', null), false, 'a room with no value is the front page');
    assertEqual(namePromptDue('?seed=viewer', null), false, 'a search without a room');
  });

  await check('name-prompt: the flag turns a due link off, and only the flag "1" does', async () => {
    assertEqual(namePromptDue('?room=r', '1'), false, 'flag set');
    assertEqual(namePromptDue('?room=r&role=viewer&tab=t', '1'), false, 'flag set with a role URL');
    assertEqual(namePromptDue('?room=r', '0'), true, 'another value is not the flag');
  });
}
