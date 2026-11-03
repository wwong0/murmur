import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assert, assertEqual, assertNear, check } from '../harness.mjs';
import { fixture, lab } from './measure-graphs.mjs';
import * as sharing from '../../graphs/fig-sharing.mjs';
import * as room from '../../graphs/fig-room-size.mjs';
import * as sync from '../../graphs/fig-sync.mjs';
import { sharingSvg, roomSizeSvg, syncSvg } from '../../graphs/writeup.mjs';
import { buildFigures } from '../../writeup-figures.mjs';

const net = (kind, val, container) => ({ discipline: 'netem', container, params: { [kind]: val }, direction: 'egress' });
function inputs() {
  return fixture([
    { condition: '13d-b-nop2p-20', cap: 20, value: 4.47 },
    { condition: '13d-b-nop2p-20', cap: 20, value: 5.23 },
    { condition: '13e-b2-nop2p-20', cap: 20, value: 5.06 },
    { condition: '13d-b-product-20', cap: 20, value: 0.98 },
    { condition: '13d-b-product-20', cap: 20, value: 1.03 },
    { condition: '13d-a2-two', viewers: 2, value: 1.001 },
    { condition: '13d-a2-two', viewers: 2, value: 1.004 },
    { condition: '13d-a2-three', viewers: 3, value: 1 },
    { condition: '13d-a2-three', viewers: 3, value: 1.02 },
    { condition: '13d-a-five', viewers: 5, value: 0.98, readings: lab(16.7) },
    { condition: '13d-a-five', viewers: 5, value: 1.03, readings: lab(16.8) },
    { condition: '13d-a-ten', viewers: 10, value: 1.1 },
    { condition: '13d-a-ten', viewers: 10, value: 1.11 },
    { condition: '13d-l-loss5', readings: lab(16.8), netem: [net('loss', '5%', 'origin'), net('loss', '5%', 'client')] },
    { condition: '13e-t-skew60', readings: lab(16.8), netem: [net('delay', '60ms', 'c03')] },
    { condition: '13e-t-skew60', readings: lab(17.8), netem: [net('delay', '60ms', 'c03')] },
  ]);
}

export default async function writeupFiguresSuite() {
  await check('writeup figures: 13e-b2-only no-sharing mark and ranges', async () => {
    const input = inputs(), data = sharing.data(input), svg = sharingSvg(data);
    assert(svg.includes('<title>no sharing: 5.06 copies</title>'), '13e-b2-only no-sharing mark');
    assert(!svg.includes('4.47 copies') && !svg.includes('5.23 copies'), 'older no-sharing tests omitted');
    assert(svg.includes('0.98–1.03 copies') && svg.includes('0.98–1.03</text>'), 'sharing range label');
    const top = Number(svg.match(/<path d="[^"]*Q[\d.]+,([\d.]+)[^"]*" fill="#2a78d6"[^>]*><title>with sharing: 0\.98–1\.03 copies<\/title>/)[1]);
    assertNear(top, 280 - 1.03 * 40, 0.01, 'sharing column reaches highest test');
    const charts = buildFigures(input, (id, bars) => [`${id}:${bars.length}`]);
    const mark = charts.find((chart) => chart.id === 'sharing');
    assertEqual(mark.bars[0].runs.length, 1, 'metadata keeps only the plotted no-sharing test');
    assertEqual(mark.bars[0].runs[0].value, 5.06, 'metadata records the plotted value');
    assert(mark.bars[0].runs[0].directory.startsWith('13e-b2-nop2p-20'), 'metadata records its directory');
    assertEqual(mark.sources[0], 'sharing:2', 'sources retained');
    assert(charts.every((chart) => !chart.svg.includes('%')), 'no percent signs in any SVG');
    assert(charts.every((chart) => chart.svg.includes('fill="#fcfcfb"')), 'each SVG has its own surface');
  });
  await check('writeup figures: room-size outlines match viewer counts', async () => {
    const svg = roomSizeSvg(room.data(inputs()));
    const outlines = [...svg.matchAll(/<path d="([^"]+)" fill="none" stroke="#a9a79f" stroke-width="2\.00"><title>no sharing: (\d+) copies<\/title><\/path>/g)];
    assertEqual(outlines.length, 4, 'four no-sharing marks');
    for (const [index, n] of [2, 3, 5, 10].entries()) {
      assertEqual(Number(outlines[index][2]), n, `${n} viewers marked as ${n} copies`);
      const top = Number(outlines[index][1].match(/Q[\d.]+,([\d.]+)/)[1]);
      assertNear(top, 300 - n * 26, 0.01, `${n} viewer outline height`);
    }
    assert(svg.includes('1.00</text>') && svg.includes('0.98–1.03</text>'), 'equal rounded values and range');
    const top = Number(svg.match(/<path d="[^"]*Q[\d.]+,([\d.]+)[^"]*" fill="#2a78d6"[^>]*><title>5 viewers: 0\.98–1\.03 copies<\/title>/)[1]);
    assertNear(top, 300 - 1.03 * 26, 0.01, 'room column reaches highest test');
  });
  await check('writeup figures: every test controls sync colour', async () => {
    const data = sync.data(inputs()), skew = data.bars.find((bar) => bar.label === 'one viewer 60 ms farther away');
    const gray = syncSvg(data);
    assert(gray.includes('fill="#a9a79f"><title>one viewer 60 ms farther away: 17 and 18 ms</title>'), 'one test above tolerance turns sync row gray');
    skew.runs[1].value = 16.8;
    const blue = syncSvg(data);
    assert(blue.includes('fill="#2a78d6"><title>one viewer 60 ms farther away: within one frame</title>'), 'all tests within tolerance turn sync row blue');
    assert(gray.includes('one frame, 16.7 ms') && gray.includes('stroke-dasharray="4.00 3.00"'), 'frame floor line');
    assert(gray.includes('reconstructed lab time') && !gray.includes('%'), 'sync caption and plain percent');
  });
  await check('writeup figures: existing output is refused', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'writeup-figures-'));
    try {
      const sentinel = path.join(temp, 'sentinel');
      fs.writeFileSync(sentinel, 'unchanged');
      const script = fileURLToPath(new URL('../../writeup-figures.mjs', import.meta.url));
      const result = spawnSync(process.execPath, [script, '--out', temp], { encoding: 'utf8' });
      assertEqual(result.status, 2, 'existing output refused');
      assertEqual(fs.readFileSync(sentinel, 'utf8'), 'unchanged', 'existing output preserved');
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
}
