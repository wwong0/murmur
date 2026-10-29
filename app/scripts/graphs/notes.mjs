import { MAX_RATE_DEVIATION } from '../../public/lib/drift-controller.mjs';
import { median, select } from './public-common.mjs';
import { countText } from './rules.mjs';
export function alsoTested(inputs) {
  const study = inputs.nights['13d'].verdicts.tests.E,
    pairs = study.pairs.filter((p) => p.valid),
    ten = inputs.nights['13e'].verdicts.tests.E10.pairs.filter((p) => p.valid);
  const comparisons = ['start', 'seek'].map((key) => {
    const newer = median(pairs.map((p) => p.product[key].stalls)) / 1000,
      earlier = median(pairs.map((p) => p.control[key].stalls)) / 1000,
      fewer = pairs.filter((p) => p.product[key].stalls < p.control[key].stalls).length;
    return `${key === 'start' ? 'Starting' : 'Jumping'}: the newer way froze for a middle ${
      newer.toFixed(1)
    } seconds in total, added across viewers, the earlier way ${earlier.toFixed(1)} seconds; fewer in ${
      countText(fewer, pairs.length, 'pairs')
    }.`;
  });
  const cuts = select(inputs, '13d-j-cut').map((row) => {
    const stalls = Object.values(row.readings['event-clocks']?.supplierCut?.stalls ?? {});
    const stalled = stalls.length && stalls.every((s) => Number.isFinite(s.count))
      ? stalls.filter((s) => s.count > 0).length
      : null;
    return countText(stalled, stalls.length || null, 'froze');
  });
  const catches = select(inputs, ['13e-k-half', '13e-k-two']).map((r) => {
    const v = r.readings['catch-up'];
    return {
      directory: r.entry.directory,
      pause: r.run.manifest.disturbance.pauseMs,
      time: v.timeInto40Ms,
      resolvedBy: v.resolvedBy,
    };
  });
  const paragraphs = [
    `Freezing when everyone starts or jumps at once. ${comparisons.join(' ')} ` +
    'The test also looked for the sharer sending fewer copies at those moments, and that was not shown. ' +
    `The version with ten viewers had ${ten.length} valid pairs.`,
    `A viewer passing video on leaves suddenly: ${cuts.join('; ')}.`,
    `Catching up: ${
      catches.map((r) =>
        `after a ${(r.pause / 1000).toFixed(1)} second pause, the viewer caught up in ${
          (r.time / 1000).toFixed(1)
        } seconds ${r.resolvedBy === 'rate' ? 'by playing slightly faster' : 'by jumping'}`
      ).join('; ')
    }. A viewer that falls behind speeds up by at most ${
      MAX_RATE_DEVIATION * 100
    }%, so a small gap takes close to a minute to close; a large one closes at once by jumping.`,
  ];
  return { paragraphs, data: { label: study.label, pairs, tenValid: ten.length, cuts, catches } };
}
export function limits(drawn) {
  const maxViewers = Math.max(
    ...drawn.flatMap((d) => d.regimes.map((r) => r.regime.viewers)).filter(Number.isFinite),
  );
  const counts = drawn.flatMap((d) =>
    d.bins
      ? [d.runs.length]
      : d.bars?.flatMap((b) => b.currentRun ? [1, 1] : b.runs ? [b.runs.length] : []) ?? []
  );
  const minTests = Math.min(...counts), maxTests = Math.max(...counts);
  return [
    'Every test ran on one computer, with the network between the browsers imitated on it. ' +
    'Nothing was measured over the real internet.',
    `One video was used throughout, at one quality.`,
    `Only uploads were limited. Downloads ran at the computer's full speed.`,
    `The largest room tested had ${maxViewers} viewers, the most the test computer could run.`,
    `Each setup was tested ${minTests} to ${maxTests} times. ` +
    'The figures show the middle value and the notes list every test. ' +
    'These are small samples, not statistical averages.',
    `Timing was measured on the pictures only. Sound was not timed.`,
  ];
}
export function notesDocument(sections, also, limit) {
  return '# Results: notes on the figures\n\n' +
    'Rough draft: the numbers are final, but the look of the figures is not.\n\n' +
    "A group watches a video in step, shared from one person's computer; " +
    'viewers pass pieces of it on to each other.\n\n' +
    `${sections.map((s) => `## ${s.title}\n\n${s.notes}`).join('\n\n')}\n\n` +
    `## Also tested\n\n${also.paragraphs.join('\n\n')}\n\n` +
    `## Limits\n\n${limit.map((s) => `- ${s}`).join('\n')}\n`;
}
