// scripts/check/suites/clock.mjs
//
// The clock filter, against manufactured inputs whose true offset is known.
//
// NOTHING IN HERE TOUCHES A NETWORK OR A TIMER. The filter reads no clock — the
// caller supplies the instant (design.md D2) — so every branch, including the
// ones about samples ageing for ten minutes, is reachable synchronously and
// costs no wall-clock time. If a check in this file ever needs to wait for
// something, something in the filter has grown a timer it must not have.
//
// The fake probe is the instrument, so §1 below checks the instrument before
// anything is checked with it. CONSTRAINTS.md → *Measurement*: an
// uninstrumented rig reports the builder's expectation.

import { check, assert, assertEqual } from '../harness.mjs';
import { createFakeProbe } from '../fake-probe.mjs';
import { createClockFilter, deriveSample, DEFAULT_DRIFT_RATE, DEFAULT_WINDOW } from '../../../public/lib/clock-filter.mjs';

/** Feed a probe's exchanges straight through, the way the driver does. */
function feed(filter, probe, count) {
  const fed = [];
  for (let i = 0; i < count; i++) {
    const exchange = probe.next();
    filter.add(exchange.sample);
    fed.push(exchange);
  }
  return fed;
}

/** The one invariant: the truth lies inside the reported interval. Two-sided. */
function assertContains(record, trueOffsetMs, where) {
  const error = Math.abs(trueOffsetMs - record.offsetMs);
  assert(
    error <= record.halfWidthMs,
    `${where}: the reported interval must contain the truth — |${trueOffsetMs} - ${record.offsetMs.toFixed(3)}| = ${error.toFixed(3)}ms > halfWidth ${record.halfWidthMs.toFixed(3)}ms`
  );
}

export default async function clockSuite() {
  // -------------------------------------------------------------------------
  // 1. The instrument
  // -------------------------------------------------------------------------

  await check('fake-probe: a symmetric jitter-free path derives back to the offset and round trip it was built from', async () => {
    // The construction runs FORWARDS from (offset, out, back) to four
    // timestamps; the filter derives BACKWARDS from four timestamps to (offset,
    // delay). Two independent directions through the same arithmetic, compared
    // against the configuration rather than against each other. A fake probe
    // that builds its samples wrongly makes every assertion below test nothing.
    const TRUE_OFFSET = 1234;
    const probe = createFakeProbe({ trueOffsetMs: TRUE_OFFSET, outMs: 17, backMs: 17, serviceMs: 3 });
    for (const exchange of probe.take(5)) {
      const d = deriveSample(exchange.sample);
      assertEqual(d.offsetMs, TRUE_OFFSET, `${probe.describe()}: a symmetric path derives the true offset exactly`);
      assertEqual(d.delayMs, 34, 'and the round trip it was configured with, with the service time removed');
      assertEqual(d.atMs, exchange.sample.t4, 'the sample is timed at t4, when it became complete');
    }

    // An asymmetric path biases the offset by exactly half the difference, and
    // leaves the delay alone — which is the property the whole bound rests on.
    const skewed = createFakeProbe({ trueOffsetMs: TRUE_OFFSET, outMs: 200, backMs: 5, serviceMs: 11 });
    const one = deriveSample(skewed.next().sample);
    assertEqual(one.offsetMs, TRUE_OFFSET + 97.5, 'the offset carries (out - back) / 2 of bias');
    assertEqual(one.delayMs, 205, 'and the delay is unaffected by the asymmetry, and by the service time');
  });

  await check('fake-probe: the same seed produces the same samples and a different seed does not', async () => {
    const spec = { trueOffsetMs: 40, outMs: 12, backMs: 9, jitterMs: 30, lossRate: 0.2 };
    const asText = (p) => JSON.stringify(p.take(60).map((e) => (e.lost ? 'lost' : e.sample)));

    const a = asText(createFakeProbe({ ...spec, seed: 7 }));
    const b = asText(createFakeProbe({ ...spec, seed: 7 }));
    const c = asText(createFakeProbe({ ...spec, seed: 8 }));

    assertEqual(a, b, 'the same seed twice, in a jittered and lossy regime, produced identical samples');
    assert(a !== c, 'and two different seeds did not');
    // A regime that fails one run in fifty trains everyone to re-run failures
    // away, and an unreproducible failure has nothing to investigate.
    assert(JSON.parse(a).some((s) => s === 'lost'), 'the lossy regime did lose exchanges, so the determinism above is not vacuous');
  });

  // -------------------------------------------------------------------------
  // 2. The invariant, in every regime
  // -------------------------------------------------------------------------

  await check('clock-filter: the reported interval contains the true offset in every regime', async () => {
    const TRUE_OFFSET = -732.5;
    const regimes = [
      ['symmetric with jitter', { outMs: 12, backMs: 12, jitterMs: 40 }],
      ['200/5 asymmetric', { outMs: 200, backMs: 5 }],
      ['5% loss', { outMs: 15, backMs: 15, jitterMs: 20, lossRate: 0.05 }],
      ['an isolated 800ms spike', { outMs: 12, backMs: 12, spikes: { 11: { outMs: 800 } } }],
    ];

    for (const [label, spec] of regimes) {
      const probe = createFakeProbe({ seed: 11, trueOffsetMs: TRUE_OFFSET, ...spec });
      const filter = createClockFilter();
      let checked = 0;
      for (let i = 0; i < 60; i++) {
        const exchange = probe.next();
        filter.add(exchange.sample);
        if (filter.sampleCount < DEFAULT_WINDOW) continue;
        // Read at the instant the sample landed, and again a minute later: the
        // bound has to hold at both, and the second is where the age term earns
        // its place.
        const at = exchange.sample ? exchange.sample.t4 : null;
        if (at === null) continue;
        assertContains(filter.read(at), TRUE_OFFSET, `${label} ${probe.describe()}`);
        assertContains(filter.read(at + 60000), TRUE_OFFSET, `${label}, read a minute later`);
        checked += 1;
      }
      assert(checked > 20, `${label}: the window filled and the invariant was actually exercised (${checked} reads)`);
      assertEqual(filter.counters.impossible, 0, `${label}: no honest sample was counted impossible`);
    }
  });

  // -------------------------------------------------------------------------
  // 3. The other side of it — the bound is EXACT, not merely containing
  // -------------------------------------------------------------------------

  await check('clock-filter: the half-width equals delay/2 + drift * age exactly', async () => {
    // Containment alone is one-sided: a filter reporting a half-width of one
    // million milliseconds satisfies every assertion above, in every regime,
    // and change 4 would then decline to correct anything forever with the
    // whole suite green. AN OVER-WIDE BOUND IS NOT A SAFE FAILURE.
    const probe = createFakeProbe({ trueOffsetMs: 500, outMs: 20, backMs: 20, serviceMs: 7, intervalMs: 1000 });
    const filter = createClockFilter();
    const fed = feed(filter, probe, DEFAULT_WINDOW);
    const last = fed[fed.length - 1].sample;

    const READ_AT = last.t4 + 45000;
    const record = filter.read(READ_AT);
    const expectedAge = READ_AT - last.t4;

    assertEqual(record.bestDelayMs, 40, 'the selected sample is one of the 40ms round trips');
    assertEqual(record.ageMs, expectedAge, 'the age is measured from the selected sample, at the instant supplied');
    assertEqual(record.delayTermMs, 20, 'the delay term is half the selected round trip');
    assertEqual(record.ageTermMs, DEFAULT_DRIFT_RATE * expectedAge, 'the age term is the drift rate over that age');
    const expected = 20 + DEFAULT_DRIFT_RATE * expectedAge;
    assert(
      Math.abs(record.halfWidthMs - expected) < 1e-9,
      `the half-width is exactly the sum and no wider: expected ${expected}, got ${record.halfWidthMs}`
    );
    // Reported separately as well as summed: change 6 has to tell a slow path
    // from a stalled one, and cannot do that from the total.
    assert(
      Math.abs(record.delayTermMs + record.ageTermMs - record.halfWidthMs) < 1e-9,
      'the two named terms are the whole of the half-width'
    );
    // A diagnostic, and deliberately not part of the bound.
    assertEqual(record.spreadMs, 0, 'the spread across a jitter-free window is zero, and did not enter the half-width');
  });

  await check('clock-filter: with no further sample the half-width grows by exactly drift * elapsed', async () => {
    const probe = createFakeProbe({ trueOffsetMs: 0, outMs: 25, backMs: 25 });
    const filter = createClockFilter();
    const fed = feed(filter, probe, DEFAULT_WINDOW);
    const at = fed[fed.length - 1].sample.t4;

    const base = filter.read(at);
    for (const elapsed of [1000, 60000, 600000]) {
      const later = filter.read(at + elapsed);
      assertEqual(later.offsetMs, base.offsetMs, `the estimate itself did not move over ${elapsed}ms`);
      assertEqual(later.delayTermMs, base.delayTermMs, 'and neither did the delay term');
      assert(
        Math.abs(later.halfWidthMs - base.halfWidthMs - DEFAULT_DRIFT_RATE * elapsed) < 1e-9,
        `after ${elapsed}ms the half-width grew by exactly drift * elapsed (${later.halfWidthMs} vs ${base.halfWidthMs})`
      );
    }
    // Ten minutes of silence is ~24ms of unknown, which is more than half the
    // 40ms budget criterion 1 names. That is the number D8 rests on: keeping a
    // stale estimate is honest only while the uncertainty says it is stale.
    assert(filter.read(at + 600000).halfWidthMs > 24, 'a ten-minute-old sample reports at least the drift it could have accumulated');

    // The reachable direction of a caller bug narrows the bound, so it is
    // refused rather than reported.
    assertEqual(filter.read(at - 5000).ageMs, 0, 'reading at an instant before the sample reports no age, never a negative one');
  });

  await check('clock-filter: the estimate is the selected sample’s own offset, and the selected sample is the quietest', async () => {
    // Independent of the filter's own arithmetic: the expected values come from
    // the configuration the samples were built from. This is the assertion that
    // goes red if a smoothing or averaging term is ever reintroduced.
    const TRUE_OFFSET = 300;
    // One sample in the window has a quieter path than the rest, and it is
    // asymmetric, so an average would land somewhere it cannot.
    const probe = createFakeProbe({
      trueOffsetMs: TRUE_OFFSET,
      outMs: (i) => (i === 3 ? 4 : 60),
      backMs: (i) => (i === 3 ? 2 : 60),
    });
    const filter = createClockFilter();
    const fed = feed(filter, probe, DEFAULT_WINDOW);
    const quietest = fed[3].truth;
    const record = filter.read(fed[fed.length - 1].sample.t4);

    assertEqual(record.bestDelayMs, quietest.delayMs, 'the quietest sample was selected');
    assertEqual(
      record.offsetMs,
      TRUE_OFFSET + (quietest.outMs - quietest.backMs) / 2,
      'and the estimate is that sample’s own offset, not a blend of the window'
    );
    assert(record.spreadMs > 0, 'the window did hold offsets that differ, so an average would have been visible');
    assertContains(record, TRUE_OFFSET, 'quietest-sample selection');
  });

  await check('clock-filter: a persistent 200/5 asymmetry is reported, not absorbed', async () => {
    // No filter can remove this bias — the information is not in the data — so
    // the only honest thing is to report an interval wide enough to contain it.
    // THE NAMED REGRESSION GUARD against someone later making the filter look
    // confident on an asymmetric path.
    const probe = createFakeProbe({ trueOffsetMs: 0, outMs: 200, backMs: 5 });
    const filter = createClockFilter();
    const fed = feed(filter, probe, DEFAULT_WINDOW);
    const record = filter.read(fed[fed.length - 1].sample.t4);

    assert(record.halfWidthMs >= 97.5, `the half-width covers the bias it cannot see (${record.halfWidthMs}ms)`);
    assert(Math.abs(record.offsetMs) > 90, 'the estimate really is biased by most of the asymmetry');
    assertContains(record, 0, '200/5 path');
    // Which says, truthfully: this clock cannot support a 40ms budget.
    assert(record.halfWidthMs > 40, 'and the reported bound exceeds criterion 1’s budget, which is the point');
  });

  await check('clock-filter: an isolated spike is not selected and barely moves the estimate', async () => {
    const SPIKE_MS = 800;
    const probe = createFakeProbe({ trueOffsetMs: 0, outMs: 10, backMs: 10, spikes: { 4: { outMs: SPIKE_MS } } });
    const filter = createClockFilter();

    const before = feed(filter, probe, 4);
    const beforeRecord = filter.read(before[3].sample.t4);
    const spike = probe.next();
    filter.add(spike.sample);
    const after = filter.read(spike.sample.t4);

    const spikeOffsetError = SPIKE_MS / 2;
    assertEqual(spike.truth.delayMs, SPIKE_MS + 20, 'the spiked exchange really did carry the whole extra delay');
    assert(after.bestDelayMs < spike.truth.delayMs, 'the spiked sample is not the selected one');
    assert(
      Math.abs(after.offsetMs - beforeRecord.offsetMs) < spikeOffsetError / 10,
      `the estimate moved by less than a tenth of the spike’s own offset error (${Math.abs(after.offsetMs - beforeRecord.offsetMs)}ms)`
    );
    assertContains(after, 0, 'isolated spike');
  });

  // -------------------------------------------------------------------------
  // 4. Admission
  // -------------------------------------------------------------------------

  await check('clock-filter: an impossible sample is counted and excluded, and honest ones never are', async () => {
    const probe = createFakeProbe({ trueOffsetMs: 88, outMs: 15, backMs: 15, impossibleAt: { 5: true } });
    const filter = createClockFilter();

    const fed = feed(filter, probe, 5);
    const before = filter.read(fed[4].sample.t4);
    assertEqual(filter.counters.impossible, 0, 'nothing honest was counted impossible on the way here');

    const bad = probe.next();
    const result = filter.add(bad.sample);
    const after = filter.read(fed[4].sample.t4);

    assertEqual(result.accepted, false, 'the impossible sample was refused');
    assertEqual(result.reason, 'impossible', 'and named as impossible rather than lost');
    assertEqual(filter.counters.impossible, 1, 'it was counted');
    assertEqual(after.offsetMs, before.offsetMs, 'and it changed nothing about the estimate');
    assertEqual(after.sampleCount, before.sampleCount, 'it never entered the window');

    // Two-sided on purpose: a counter only ever asserted non-zero would pass
    // while the filter rejected everything it was given.
    const honest = createClockFilter();
    const noisy = createFakeProbe({ seed: 3, trueOffsetMs: -50, outMs: 200, backMs: 5, jitterMs: 60, lossRate: 0.05 });
    const exchanges = feed(honest, noisy, 80);
    assertEqual(honest.counters.impossible, 0, 'jitter, loss and persistent asymmetry produce no impossible samples');
    assertEqual(honest.counters.lost, exchanges.filter((e) => e.lost).length, 'and every lost exchange was counted as lost');
    assert(honest.counters.lost > 0, 'the lossy regime really did lose some');
  });

  await check('clock-filter: no estimate exists before the first accepted sample', async () => {
    // An offset of zero is a CLAIM — that this client is already aligned with
    // the room — and it is indistinguishable from success in every number
    // downstream. Change 3 would record a plausible drift trace for a client
    // that was never synchronised at all.
    const filter = createClockFilter();
    const empty = filter.read(1_000_000);
    assertEqual(empty.offsetMs, null, 'the estimate is absent, not zero');
    assertEqual(empty.halfWidthMs, null, 'and so is its uncertainty');
    assertEqual(empty.sampleCount, 0, 'with nothing in the window');

    filter.add(null);
    assertEqual(filter.read(1_000_000).offsetMs, null, 'a lost exchange does not conjure one');
    assertEqual(filter.counters.lost, 1, 'it is counted as lost');

    const probe = createFakeProbe({ trueOffsetMs: 17, outMs: 8, backMs: 8, impossibleAt: { 0: true } });
    filter.add(probe.next().sample);
    assertEqual(filter.read(1_000_000).offsetMs, null, 'and neither does a rejected one');

    const good = probe.next();
    filter.add(good.sample);
    const record = filter.read(good.sample.t4);
    assertEqual(record.sampleCount, 1, 'one accepted sample is one sample');
    assertContains(record, 17, 'a single sample');
  });

  // -------------------------------------------------------------------------
  // 5. Step detection
  // -------------------------------------------------------------------------

  await check('clock-filter: a step in the true offset is tracked, and the interval is violated before it is', async () => {
    const STEP_AT = 10;
    const BEFORE = 0;
    const AFTER = 5000;
    // Every pre-step sample is QUIETER than every post-step one, so
    // minimum-delay selection cannot stumble onto the new era by itself and
    // what is measured is detection rather than luck.
    const probe = createFakeProbe({
      trueOffsetMs: (i) => (i < STEP_AT ? BEFORE : AFTER),
      outMs: (i) => (i < STEP_AT ? 5 : 30),
      backMs: (i) => (i < STEP_AT ? 5 : 30),
    });
    const filter = createClockFilter();
    const K = filter.settings.confirmations;

    feed(filter, probe, STEP_AT);

    let trackedAfter = null;
    for (let n = 1; n <= K + 1 && trackedAfter === null; n++) {
      const exchange = probe.next();
      filter.add(exchange.sample);
      const record = filter.read(exchange.sample.t4);
      const contained = Math.abs(AFTER - record.offsetMs) <= record.halfWidthMs;
      if (contained) trackedAfter = n;
      else assert(n < K + 1, `after ${n} post-step samples the new offset should still be outside the interval, or detection is not what is being measured`);
    }

    assert(trackedAfter !== null && trackedAfter <= K + 1, `the step was tracked within K+1 samples (took ${trackedAfter})`);
    assertEqual(filter.counters.reanchors, 1, 'and it re-anchored exactly once');
    // THE PURGE CAN NEVER EMPTY THE WINDOW, and this is the assertion saying
    // so. It keeps every sample that does not contradict the newest one, and a
    // sample cannot contradict itself — |0| > 0 is false for any delay and any
    // drift allowance. If that ever stopped holding, the filter would report no
    // estimate at all in the sample after having a perfectly good one, which
    // presents downstream as an unsynchronised client rather than as a fault
    // here.
    assert(filter.sampleCount >= 1, `the re-anchor kept the sample that triggered it (${filter.sampleCount} left in the window)`);

    // ...and it is a real estimate afterwards, not a wide interval hiding a
    // wrong number.
    const settled = feed(filter, probe, 4);
    const record = filter.read(settled[3].sample.t4);
    assertContains(record, AFTER, 'after the re-anchor');
    assert(record.halfWidthMs < 100, `and the interval is tight again (${record.halfWidthMs}ms)`);
  });

  await check('clock-filter: a queueing burst does not re-anchor but a same-sized step does', async () => {
    // THE ASSERTION THAT SHOWS THE TEST DISCRIMINATES, and the whole reason it
    // is sample-to-sample. Both regimes move the offset by 500ms for two
    // consecutive samples. In the first the samples carry a round trip large
    // enough to account for that error themselves, so they are permitted; in
    // the second they do not, so they are a contradiction.
    const EXCURSION = 500;

    const burst = createFakeProbe({
      trueOffsetMs: 0,
      outMs: 10,
      backMs: 10,
      spikes: { 8: { outMs: 2 * EXCURSION }, 9: { outMs: 2 * EXCURSION } },
    });
    const burstFilter = createClockFilter();
    const burstFed = feed(burstFilter, burst, 14);
    assertEqual(burstFilter.counters.reanchors, 0, 'a burst of queueing delay is not a step');
    assertContains(burstFilter.read(burstFed[13].sample.t4), 0, 'queueing burst');

    const step = createFakeProbe({
      trueOffsetMs: (i) => (i < 8 ? 0 : EXCURSION),
      outMs: 10,
      backMs: 10,
    });
    const stepFilter = createClockFilter();
    const stepFed = feed(stepFilter, step, 14);
    assert(stepFilter.counters.reanchors >= 1, 'the same excursion on quiet samples is a step');
    assertContains(stepFilter.read(stepFed[13].sample.t4), EXCURSION, 'genuine step');
  });

  await check('clock-filter: a single outlier does not re-anchor, and is never published', async () => {
    // One corrupt sample must not be able to purge a good window. It is why the
    // confirmation count exists, and it is a narrower job than rejecting
    // spikes.
    const OUTLIER_AT = 9;
    const probe = createFakeProbe({
      trueOffsetMs: (i) => (i === OUTLIER_AT ? 4000 : 0),
      outMs: 10,
      backMs: 10,
    });
    const filter = createClockFilter();
    feed(filter, probe, OUTLIER_AT);
    const outlier = probe.next();
    filter.add(outlier.sample);

    // READ MID-RUN, WHICH IS THE POINT. The outlier is displaced by the next
    // sample, so a check that reads only at the end cannot see this at all —
    // and until 2026-08-22 that is exactly what this one did, while the filter
    // published 4000ms ± 10ms here and the suite stayed green. Every sample in
    // this regime carries the same delay and ties go to the newest (D3), so
    // nothing about selection keeps the outlier out: its ineligibility does.
    const during = filter.read(outlier.sample.t4);
    assert(
      during.offsetMs !== outlier.truth.offsetMs,
      `an unconfirmed contradicting sample is never the published estimate (published ${during.offsetMs} ± ${during.halfWidthMs})`
    );
    assertContains(during, 0, 'while an unconfirmed contradicting sample is in the window');

    const after = feed(filter, probe, 6);
    assertEqual(filter.counters.reanchors, 0, 'one isolated outlier is not a step');
    assertContains(filter.read(after[5].sample.t4), 0, 'after an isolated outlier');
  });

  await check('clock-filter: a corrupt sample immediately before a step does not veto detecting it', async () => {
    // WHAT THE CONFIRMATION RUN'S CAP IS FOR. The run holds consecutive samples
    // that each contradict the anchor, and it re-anchors only once they agree
    // with EACH OTHER as well. Uncapped, one corrupt sample stays in the run for
    // as long as the run lives, contradicts every post-step sample that follows
    // it, and the run can therefore never agree with itself again — the
    // detector is off permanently, not merely delayed.
    //
    // Measured over this exact regime with the cap removed (session D,
    // 2026-08-21): `reanchors` stayed 0 and the filter published
    // -9000ms ± 5ms for seven further samples, recovering only when window
    // turnover carried the old era out on its own. The cap is also the more
    // faithful reading of D7, whose rule is about K CONSECUTIVE samples.
    const STEP_AT = 10;
    const OUTLIER_AT = 9;
    const AFTER = 5000;
    // Every pre-step sample is quieter than every post-step one, so minimum-
    // delay selection cannot stumble onto the new era by itself and what is
    // measured is detection rather than turnover.
    const probe = createFakeProbe({
      trueOffsetMs: (i) => (i === OUTLIER_AT ? -9000 : i >= STEP_AT ? AFTER : 0),
      outMs: (i) => (i < STEP_AT ? 5 : 30),
      backMs: (i) => (i < STEP_AT ? 5 : 30),
    });
    const filter = createClockFilter();
    const K = filter.settings.confirmations;

    feed(filter, probe, STEP_AT); // ...through the corrupt sample, which is the last of them
    assertEqual(filter.counters.reanchors, 0, 'the corrupt sample alone did not re-anchor anything');

    const post = feed(filter, probe, K);
    assertEqual(filter.counters.reanchors, 1, `the step was detected on the Kth post-step sample despite the corrupt one before it (K = ${K})`);

    const record = filter.read(post[K - 1].sample.t4);
    assertContains(record, AFTER, 'after re-anchoring past a corrupt sample');
    assert(record.sampleCount >= 1, `and the purge kept the samples that agree with the newest (${record.sampleCount})`);
  });

  await check('clock-filter: a long gap is not a step, and the drift allowance is what makes it so', async () => {
    // D8's reconnect case. Two samples ten minutes apart SHOULD differ by up to
    // the drift rate over that interval — 24ms — and a detector that called
    // that a server restart would mislead whoever later reads `reanchors`.
    const GAP_MS = 600000;
    // More than the two delays permit between them (10 + 10 = 20ms), less than
    // those delays plus the drift the gap allows (20 + 40ppm * 10min = 44ms).
    const DRIFTED_BY = 30;
    const spec = {
      trueOffsetMs: (i) => (i < 6 ? 0 : DRIFTED_BY),
      outMs: 10,
      backMs: 10,
      gapBeforeMs: { 6: GAP_MS },
    };

    const filter = createClockFilter();
    const probe = createFakeProbe(spec);
    const fed = feed(filter, probe, 12);
    assertEqual(filter.counters.reanchors, 0, 'a gap large enough to explain the difference is not a step');
    assertContains(filter.read(fed[11].sample.t4), DRIFTED_BY, 'after a long gap');

    // ...and that is the allowance doing it, not the delays: with the drift
    // rate at zero the same samples ARE a contradiction. Shown rather than
    // argued, because the allowance is the only thing standing between a
    // reconnect and a reported server restart.
    const noDrift = createClockFilter({ driftRate: 0 });
    feed(noDrift, createFakeProbe(spec), 12);
    assert(noDrift.counters.reanchors >= 1, 'with no drift allowance the same gap reads as a step');
  });

  // -------------------------------------------------------------------------
  // 6. The window length is a setting, and the checks run it away from default
  // -------------------------------------------------------------------------

  await check('clock-filter: with re-anchoring off, tracking a step takes exactly the configured window length', async () => {
    // The setting-discrimination task (openspec/config.yaml): this suite runs
    // the window length away from its shipped default, so at least one
    // assertion has to be pinned to the SETTING rather than to a constant.
    //
    // Deterministic by construction: every pre-step sample has a smaller round
    // trip than every post-step one, so minimum-delay selection keeps
    // publishing the old era until the last pre-step sample is pushed out of
    // the window — which happens on exactly the Nth post-step sample.
    const STEP_AT = 12;
    const AFTER = 5000;
    const spec = {
      trueOffsetMs: (i) => (i < STEP_AT ? 0 : AFTER),
      outMs: (i) => (i < STEP_AT ? 5 : 30),
      backMs: (i) => (i < STEP_AT ? 5 : 30),
    };

    for (const windowSize of [4, 8]) {
      const filter = createClockFilter({ windowSize, reanchor: false });
      const probe = createFakeProbe(spec);
      feed(filter, probe, STEP_AT);

      let trackedAt = null;
      for (let n = 1; n <= windowSize + 3 && trackedAt === null; n++) {
        const exchange = probe.next();
        filter.add(exchange.sample);
        const record = filter.read(exchange.sample.t4);
        if (Math.abs(AFTER - record.offsetMs) <= record.halfWidthMs) trackedAt = n;
      }

      assertEqual(trackedAt, windowSize, `at N = ${windowSize} the step is tracked after exactly N samples, not a proportion of them`);
      assertEqual(filter.counters.reanchors, 0, `at N = ${windowSize} nothing re-anchored, so window turnover is what was measured`);
    }
  });
}
