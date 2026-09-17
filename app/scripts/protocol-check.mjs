// scripts/protocol-check.mjs
//
// Drives the room server with several websocket clients from Node and asserts
// the routing, ordering, presence, identity, liveness, gap-detection and
// non-interpretation rules the whole transport rests on.
//
// It needs no browser and no harness — KEEP IT CHEAP. A check that takes thirty
// seconds is one you run occasionally, and a check run occasionally has stopped
// catching things early. That is why the server takes its liveness interval as
// a setting (design.md D8), and why the refusal-policy checks in the
// room-client suite run as a concurrent group rather than in sequence.
//
// The servers are started IN THIS PROCESS on ephemeral ports, so their clocks
// and this process's share a `performance.timeOrigin` and the round-trip
// assertions can check the full ordering t1 <= ts.recv <= ts.send <= t4 exactly.
//
// This file is only the running order. The assertions live in check/suites/**,
// the machinery in check/harness.mjs, and the servers in check/fixtures.mjs —
// which boots them on import, so importing a suite is enough to have something
// to run it against.
//
// No test framework — step0/ establishes invariant checks in plain scripts as
// this project's convention (see step0/scripts/aggregate.mjs).
//
// Node 24, ESM.

import { report } from './check/harness.mjs';
import { describeFixtures, disposeFixtures } from './check/fixtures.mjs';

import mediaSuite from './check/suites/media.mjs';
import joinSuite from './check/suites/join.mjs';
import hostSuite from './check/suites/host.mjs';
import identitySuite from './check/suites/identity.mjs';
import routingSuite from './check/suites/routing.mjs';
import presenceSuite from './check/suites/presence.mjs';
import timeEchoSuite from './check/suites/time-echo.mjs';
import robustnessSuite from './check/suites/robustness.mjs';
import livenessSuite from './check/suites/liveness.mjs';
import roomClientSuite from './check/suites/room-client.mjs';
import clockSuite from './check/suites/clock.mjs';
import clockSyncSuite from './check/suites/clock-sync.mjs';
import roomTimelineSuite from './check/suites/room-timeline.mjs';
import playbackStateSuite from './check/suites/playback-state.mjs';
import playbackStateRulesSuite from './check/suites/playback-state-rules.mjs';
import playbackAcquisitionSuite from './check/suites/playback-acquisition.mjs';
import playbackAcquisitionTimingSuite from './check/suites/playback-acquisition-timing.mjs';
import driftSuite from './check/suites/drift.mjs';
import driftControllerSuite from './check/suites/drift-controller.mjs';
import driftLoadSuite from './check/suites/drift-load.mjs';
import driftFiguresSuite from './check/suites/drift-figures.mjs';
import driftConvergenceSuite from './check/suites/drift-convergence.mjs';
import driftReportingSuite from './check/suites/drift-reporting.mjs';
import driftSettlingSuite from './check/suites/drift-settling.mjs';
import playbackStartSuite from './check/suites/playback-start.mjs';
import tickStepsSuite from './check/suites/tick-steps.mjs';
import settleWaitSuite from './check/suites/settle-wait.mjs';
import startResidualSuite from './check/suites/start-residual.mjs';
import startTelemetrySuite from './check/suites/start-telemetry.mjs';
import startTimingSuite from './check/suites/start-timing.mjs';
import startTreatedSuite from './check/suites/start-treated.mjs';
import driftReadoutSuite from './check/suites/drift-readout.mjs';
import diagnosticsOverlaySuite from './check/suites/diagnostics-overlay.mjs';
import d8ProductIntegrationSuite from './check/suites/d8-product-integration.mjs';
import playbackTreatmentSuite from './check/suites/playback-treatment.mjs';
import playbackTreatmentEntrySuite from './check/suites/playback-treatment-entry.mjs';
import roomControlsEntrySuite from './check/suites/room-controls-entry.mjs';

console.log(describeFixtures());

// Order matters only for legibility: each suite takes rooms of its own, so none
// of them can observe another.
for (const suite of [
  mediaSuite,
  joinSuite,
  hostSuite,
  identitySuite,
  routingSuite,
  presenceSuite,
  timeEchoSuite,
  robustnessSuite,
  livenessSuite,
  roomClientSuite,
  clockSuite,
  clockSyncSuite,
  roomTimelineSuite,
  playbackStateSuite,
  playbackStateRulesSuite,
  playbackAcquisitionSuite,
  playbackAcquisitionTimingSuite,
  driftSuite,
  driftControllerSuite,
  driftLoadSuite,
  driftFiguresSuite,
  driftConvergenceSuite,
  driftReportingSuite,
  driftSettlingSuite,
  playbackStartSuite,
  tickStepsSuite,
  settleWaitSuite,
  startResidualSuite,
  startTelemetrySuite,
  startTimingSuite,
  startTreatedSuite,
  driftReadoutSuite,
  diagnosticsOverlaySuite,
  d8ProductIntegrationSuite,
  playbackTreatmentSuite,
  playbackTreatmentEntrySuite,
  roomControlsEntrySuite,
]) {
  await suite();
}

await disposeFixtures();
process.exit(report());
