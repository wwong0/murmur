// The listening comparison's logic. Research-only; nothing here is product code.
// Each condition is a rate schedule of { tMs, rate } writes applied on wall-clock
// time measured from the element's `playing` event. Pitch preservation is off for
// every condition, so the only difference between them is the rate.
// Music covers every recorded write (last at ~42.6 s) plus settled playback. The
// speech clip is 24.7 s, which lasts 24.5 s of wall time at 1.01, so its passage
// is 24 s and replays only the trajectory's first 24 s: the 1.01 hold and the
// start of the decline.
const PASSAGE_MS = { speech: 24000, music: 48000 };
const TICK_MS = 5;
const T = window.TRAJECTORY;

const CONDITIONS = [
  { id: 'normal', label: 'Normal playback', desc: 'Rate 1 throughout.', initialRate: 1, writes: [] },
  {
    id: 'trajectory',
    label: 'Recorded correction',
    desc: `The fallback controller's actual rate writes (${T.writes.length} writes, ${T.client}), then rate 1.`,
    initialRate: T.initialRate,
    writes: T.writes,
  },
  { id: 'slow', label: 'Constant 0.99', desc: 'Worst case, slow side: the controller\'s full authority held throughout. The recorded run never slowed down.', worst: true, initialRate: 0.99, writes: [] },
  { id: 'fast', label: 'Constant 1.01', desc: 'Worst case, fast side: the controller\'s full authority held throughout.', worst: true, initialRate: 1.01, writes: [] },
];

const player = document.getElementById('player');
const rows = document.getElementById('rows');
const status = document.getElementById('status');
const reveal = document.getElementById('reveal');
const blind = document.getElementById('blind');
let order = CONDITIONS.map((_, index) => index);
let run = null;
const finished = new Map(); // condition id -> last completed run's write statistics

const selectedClip = () => document.querySelector('input[name=clip]:checked').value;
const showPassage = () => { document.getElementById('passage-s').textContent = String(PASSAGE_MS[selectedClip()] / 1000); };
showPassage();
document.getElementById('provenance').textContent = `${T.batch} / ${T.client} (${T.selection})`;

function shuffle() {
  order = CONDITIONS.map((_, index) => index);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  reveal.style.display = 'none';
}

function render() {
  stop();
  rows.replaceChildren();
  const hidden = blind.checked;
  order.forEach((conditionIndex, position) => {
    const condition = CONDITIONS[conditionIndex];
    const row = document.createElement('div');
    row.className = 'row';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = hidden ? `Play ${'ABCD'[position]}` : 'Play';
    button.addEventListener('click', () => play(condition, button, hidden ? 'ABCD'[position] : condition.label));
    const text = document.createElement('div');
    text.className = 'desc';
    if (hidden) text.textContent = `Condition ${'ABCD'[position]}`;
    else {
      const name = document.createElement('strong');
      name.textContent = condition.label;
      if (condition.worst) name.className = 'worst';
      text.append(name, document.createTextNode(` — ${condition.desc}`));
    }
    const notes = document.createElement('input');
    notes.type = 'text';
    notes.placeholder = 'notes';
    row.append(button, text, notes);
    rows.append(row);
  });
}

function stop() {
  if (run) {
    clearInterval(run.timer);
    run.button.classList.remove('playing');
    run = null;
  }
  player.pause();
  status.textContent = 'idle';
}

async function play(condition, button, name) {
  stop();
  const clip = selectedClip();
  const src = `clips/${clip}.m4a`;
  if (!player.src.endsWith(src)) {
    player.src = src;
    await new Promise((resolve) => player.addEventListener('canplaythrough', resolve, { once: true }));
  }
  player.preservesPitch = false;
  player.currentTime = 0;
  await new Promise((resolve) => (player.seeking ? player.addEventListener('seeked', resolve, { once: true }) : resolve()));
  player.playbackRate = condition.initialRate;
  const current = { condition, button, passageMs: PASSAGE_MS[clip], next: 0, timer: null, t0: null, worstLateMs: 0 };
  run = current;
  button.classList.add('playing');
  player.addEventListener('playing', () => {
    if (run !== current) return;
    current.t0 = performance.now();
    current.timer = setInterval(() => tick(current, name), TICK_MS);
  }, { once: true });
  await player.play();
}

function tick(current, name) {
  const elapsed = performance.now() - current.t0;
  const { writes } = current.condition;
  while (current.next < writes.length && writes[current.next].tMs <= elapsed) {
    player.playbackRate = writes[current.next].rate;
    current.worstLateMs = Math.max(current.worstLateMs, elapsed - writes[current.next].tMs);
    current.next += 1;
  }
  if (elapsed >= current.passageMs) {
    // The write count names the condition, so under hidden labels it waits for Reveal.
    const stats = `${current.next}/${writes.length} writes applied, latest ${current.worstLateMs.toFixed(1)} ms after its recorded time`;
    finished.set(current.condition.id, stats);
    stop();
    status.textContent = blind.checked ? `${name}: finished` : `${name}: finished — ${stats}`;
    return;
  }
  const rateText = blind.checked ? '' : `  rate ${player.playbackRate.toFixed(5)}`;
  status.textContent = `${name}: ${(elapsed / 1000).toFixed(1)} / ${current.passageMs / 1000} s${rateText}  preservesPitch=${player.preservesPitch}`;
}

document.getElementById('reshuffle').addEventListener('click', () => { shuffle(); render(); });
document.getElementById('show').addEventListener('click', () => {
  reveal.style.display = 'block';
  reveal.textContent = order.map((conditionIndex, position) => {
    const condition = CONDITIONS[conditionIndex];
    const stats = finished.get(condition.id);
    return `${'ABCD'[position]} = ${condition.label}${stats ? ` (${stats})` : ''}`;
  }).join('   ·   ');
});
blind.addEventListener('change', () => { shuffle(); render(); });
document.querySelectorAll('input[name=clip]').forEach((radio) => radio.addEventListener('change', () => { stop(); showPassage(); }));
render();
