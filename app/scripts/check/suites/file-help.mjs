import { assert, assertEqual, check } from '../harness.mjs';
import { keyframeNotice, refusalHelp } from '../../../public/lib/file-help.mjs';

const COMMANDS = {
  video: 'ffmpeg -i input.mp4 -c:v libx264 -pix_fmt yuv420p -profile:v high -crf 18 -c:a copy output.mp4',
  audio: 'ffmpeg -i input.mp4 -c:v copy -c:a aac -b:a 192k output.mp4',
  container: 'ffmpeg -i input.mkv -c copy -movflags +faststart output.mp4',
  keyframe: 'ffmpeg -i input.mp4 -c:v libx264 -crf 18 -force_key_frames "expr:gte(t,n_forced*2)" -c:a copy output.mp4',
};

export default async function fileHelpSuite() {
  await check('F1 file-help: each refusal chooses the D9 command or reason only', async () => {
    const cases = [
      [{ reason: 'video-codec' }, COMMANDS.video],
      [{ reason: 'codec-unplayable', codec: 'avc1.4d401f' }, COMMANDS.video],
      [{ reason: 'audio-codec' }, COMMANDS.audio],
      [{ reason: 'codec-unplayable', codec: 'mp4a.40.2' }, COMMANDS.audio],
      [{ reason: 'not-mp4' }, COMMANDS.container],
      [{ reason: 'fragmented' }, COMMANDS.container],
      [{ reason: 'no-video' }, null],
      [{ reason: 'encrypted' }, null],
      [{ reason: 'edit-list' }, null],
      [{ reason: 'unsupported-structure' }, null],
      [{ reason: 'storage', neededBytes: 10, freeBytes: 20 }, null],
      [{ reason: 'new-cause' }, null],
    ];
    for (const [refusal, command] of cases) {
      const help = refusalHelp(refusal);
      assertEqual(help.command, command, `${refusal.reason} command`);
      assert(typeof help.reason === 'string' && help.reason.length > 0, `${refusal.reason} has a reason`);
      assertEqual(help.note, command === null ? null : 'ffmpeg is free from ffmpeg.org', `${refusal.reason} note`);
    }
    assertEqual(refusalHelp({ reason: 'codec-unplayable', codec: 'mp4a.40.2' }).command, COMMANDS.audio, 'mp4a codec stays on the audio arm');
  });

  await check('F2 file-help: commands use placeholders, never a source file name', async () => {
    for (const refusal of [{ reason: 'video-codec' }, { reason: 'audio-codec' }, { reason: 'not-mp4' }, { reason: 'fragmented' }]) {
      const command = refusalHelp({ ...refusal, fileName: 'secret-title.mov' }).command;
      assert(!command.includes('secret-title'), `${refusal.reason} has no source name`);
      assert(command.includes('input.mp4') || command.includes('input.mkv'), `${refusal.reason} has an input placeholder`);
      assert(command.includes('output.mp4'), `${refusal.reason} has an output placeholder`);
    }
  });

  await check('F3 file-help: storage reason publishes both byte values', async () => {
    assertEqual(refusalHelp({ reason: 'storage', neededBytes: 1234, freeBytes: 5678 }).reason, 'storage: neededBytes 1234, freeBytes 5678', 'storage numbers');
    assertEqual(refusalHelp({ reason: 'storage', neededBytes: null, freeBytes: null }).reason, 'storage: neededBytes unknown, freeBytes unknown', 'storage unknowns');
  });

  await check('F4 file-help: only a sparse p95 triggers the keyframe notice', async () => {
    const sparse = keyframeNotice({ keyframeSpacing: { p95: 5, max: 5 }, targetSeconds: 2 });
    assertEqual(sparse.longestSeconds, 5, 'sparse notice longest gap');
    assert(sparse.text.includes('starts and seeks') && sparse.text.includes('5 s'), 'sparse notice text');
    assertEqual(sparse.command, COMMANDS.keyframe, 'sparse notice command');
    assertEqual(keyframeNotice({ keyframeSpacing: { p95: 2, max: 5 }, targetSeconds: 2 }), null, 'p95 equal to target is quiet');
    assertEqual(keyframeNotice({ keyframeSpacing: { p95: 1.5, max: 5 }, targetSeconds: 2 }), null, 'one outlier below p95 is quiet');
    assertEqual(keyframeNotice({ targetSeconds: 2 }), null, 'absent spacing is quiet');
  });
}
