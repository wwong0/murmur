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
import byteAccountingSuite from './check/suites/byte-accounting.mjs';
import harnessFiguresSuite from './check/suites/harness-figures.mjs';
import harnessQueueSuite from './check/suites/harness-queue.mjs';
import harnessUdpLoadSuite from './check/suites/harness-udp-load.mjs';
import harnessPairwiseSuite from './check/suites/harness-pairwise.mjs';
import harnessDriftPublicationSuite from './check/suites/harness-drift-publication.mjs';
import harnessDriftPlotSuite from './check/suites/harness-drift-plot.mjs';
import harnessByteCohortSuite from './check/suites/harness-byte-cohort.mjs';
import receiptCohortSuite from './check/suites/receipt-cohort.mjs';
import harnessRefusalsSuite from './check/suites/harness-refusals.mjs';
import harnessArmsSuite from './check/suites/harness-arms.mjs';
import harnessImagesSuite from './check/suites/harness-images.mjs';
import harnessArmRecomputeSuite from './check/suites/harness-arm-recompute.mjs';
import harnessCadenceSuite from './check/suites/harness-cadence.mjs';
import harnessPollShapeSuite from './check/suites/harness-poll-shape.mjs';
import harnessRecordsSuite from './check/suites/harness-records.mjs';
import trackerSpawnSuite from './check/suites/tracker-spawn.mjs';
import harnessConditionsSuite from './check/suites/harness-conditions.mjs';
import harnessBehindSuite from './check/suites/harness-behind.mjs';
import harnessBehindPastSuite from './check/suites/harness-behind-past.mjs';
import harnessFrameStallsSuite from './check/suites/harness-frame-stalls.mjs';
import harnessDistanceBehindSuite from './check/suites/harness-distance-behind.mjs';
import harnessRosterEventSuite from './check/suites/harness-roster-event.mjs';
import segmentWaitSuite from './check/suites/segment-wait.mjs';
import harnessSocketControlSuite from './check/suites/harness-socket-control.mjs';
import harnessPeerConditionsSuite from './check/suites/harness-peer-conditions.mjs';
import harnessPeerTopologySuite from './check/suites/harness-peer-topology.mjs';
import topologyReadbackSuite from './check/suites/topology-readback.mjs';
import originProxySuite from './check/suites/origin-proxy.mjs';
import harnessPeerUploadSuite from './check/suites/harness-peer-upload.mjs';
import peerFiguresSuite from './check/suites/peer-figures.mjs';
import oneViewingSuite from './check/suites/one-viewing.mjs';
import nop2pSteadySuite from './check/suites/nop2p-steady.mjs';
import machineTestSuite from './check/suites/machine-test.mjs';
import qaRecomputeSuite from './check/suites/qa-recompute.mjs';
import p2pMeasurementSuite from './check/suites/p2p-measurement.mjs';
import regimesReadingSuite from './check/suites/regimes-reading.mjs';
import regimesConditionsSuite from './check/suites/regimes-conditions.mjs';
import peerSpacingSuite from './check/suites/peer-spacing.mjs';
import peerChecksSuite from './check/suites/peer-checks.mjs';
import peerChecksGroupSuite from './check/suites/peer-checks-group.mjs';
import receiptExcusalSuite from './check/suites/receipt-excusal.mjs';
import peerConservationShapedSuite from './check/suites/peer-conservation-shaped.mjs';
import peerSettleSuite from './check/suites/peer-settle.mjs';
import hostOriginRefusalsSuite from './check/suites/host-origin-refusals.mjs';
import harnessStartRequalSuite from './check/suites/harness-start-requal.mjs';
import harnessDriftRunnerSuite from './check/suites/harness-drift-runner.mjs';
import joinSuite from './check/suites/join.mjs';
import hostSuite from './check/suites/host.mjs';
import identitySuite from './check/suites/identity.mjs';
import routingSuite from './check/suites/routing.mjs';
import presenceSuite from './check/suites/presence.mjs';
import timeEchoSuite from './check/suites/time-echo.mjs';
import robustnessSuite from './check/suites/robustness.mjs';
import livenessSuite from './check/suites/liveness.mjs';
import settingsSuite from './check/suites/settings.mjs';
import mediaSourceSettingSuite from './check/suites/media-source-setting.mjs';
import roomClientSuite from './check/suites/room-client.mjs';
import clockSuite from './check/suites/clock.mjs';
import clockSyncSuite from './check/suites/clock-sync.mjs';
import segmentProtocolSuite from './check/suites/segment-protocol.mjs';
import segmentFlowSuite from './check/suites/segment-flow.mjs';
import hostLinkSuite from './check/suites/host-link.mjs';
import hostOriginSuite from './check/suites/host-origin.mjs';
import hostAccountingSuite from './check/suites/host-accounting.mjs';
import hostReceiptsSuite from './check/suites/host-receipts.mjs';
import hostOriginFiguresSuite from './check/suites/host-origin-figures.mjs';
import hostOriginBarsSuite from './check/suites/host-origin-bars.mjs';
import fetchShimBarsSuite from './check/suites/fetch-shim-bars.mjs';
import peerBytesSuite from './check/suites/peer-bytes.mjs';
import bytesReadoutSuite from './check/suites/bytes-readout.mjs';
import peerEngineConfigSuite from './check/suites/peer-engine-config.mjs';
import hostLoadTimeoutSuite from './check/suites/host-load-timeout.mjs';
import engineWindowsSuite from './check/suites/engine-windows.mjs';
import urgentSourceSuite from './check/suites/urgent-source.mjs';
import edgeAssignmentSuite from './check/suites/edge-assignment.mjs';
import edgeSpreadSuite from './check/suites/edge-spread.mjs';
import edgeSourceSuite from './check/suites/edge-source.mjs';
import edgeRequestSuite from './check/suites/edge-request.mjs';
import runwayEntrySuite from './check/suites/runway-entry.mjs';
import edgeControlSuite from './check/suites/edge-control.mjs';
import enginePatchSuite from './check/suites/engine-patch.mjs';
import edgeAsksSuite from './check/suites/edge-asks.mjs';
import capacityEstimateSuite from './check/suites/capacity-estimate.mjs';
import sendPaceSuite from './check/suites/send-pace.mjs';
import hostPaceSuite from './check/suites/host-pace.mjs';
import sendArbiterSuite from './check/suites/send-arbiter.mjs';
import urgentRequestSuite from './check/suites/urgent-request.mjs';
import edgePositionSuite from './check/suites/edge-position.mjs';
import wireEstimateSuite from './check/suites/wire-estimate.mjs';
import echoDelaySuite from './check/suites/echo-delay.mjs';
import harnessJoinOrderSuite from './check/suites/harness-join-order.mjs';
import qualificationEarlySuite from './check/suites/qualification-early.mjs';
import boundaryAsyncSuite from './check/suites/boundary-async.mjs';
import assignmentControlSuite from './check/suites/assignment-control.mjs';
import capacityScheduleSuite from './check/suites/capacity-schedule.mjs';
import scheduleRecoverySuite from './check/suites/schedule-recovery.mjs';
import runwaySuite from './check/suites/runway.mjs';
import askEvidenceSuite from './check/suites/ask-evidence.mjs';
import edgeFiguresSuite from './check/suites/edge-figures.mjs';
import edgeReadingSuite from './check/suites/edge-reading.mjs';
import edgeConditionsSuite from './check/suites/edge-conditions.mjs';
import paceBoundSuite from './check/suites/pace-bound.mjs';
import capUsedSuite from './check/suites/cap-used.mjs';
import steadyCapUsedSuite from './check/suites/steady-cap-used.mjs';
import controlEvidenceSuite from './check/suites/control-evidence.mjs';
import controlFiguresSuite from './check/suites/control-figures.mjs';
import controlReadingSuite from './check/suites/control-reading.mjs';
import controlReadingScriptSuite from './check/suites/control-reading-script.mjs';
import buildMatchSuite from './check/suites/build-match.mjs';
import controlReadingRepairsSuite from './check/suites/control-reading-repairs.mjs';
import harnessContentSuite from './check/suites/harness-content.mjs';
import segmentSecondsSuite from './check/suites/segment-seconds.mjs';
import controlRereadSuite from './check/suites/control-reread.mjs';
import headroomSuite from './check/suites/headroom.mjs';
import seekEntrySuite from './check/suites/seek-entry.mjs';
import capacityStepSuite from './check/suites/capacity-step.mjs';
import seekEvidenceSuite from './check/suites/seek-evidence.mjs';
import seekHoldSuite from './check/suites/seek-hold.mjs';
import trapFiguresSuite from './check/suites/trap-figures.mjs';
import trapReadingSuite from './check/suites/trap-reading.mjs';
import starvedRecomputeSuite from './check/suites/starved-recompute.mjs';
import heldAheadSuite from './check/suites/held-ahead.mjs';
import spanCourseSuite from './check/suites/span-course.mjs';
import peerExchangeEntrySuite from './check/suites/peer-exchange-entry.mjs';
import peerExchangeBarsSuite from './check/suites/peer-exchange-bars.mjs';
import positionOffsetSuite from './check/suites/position-offset.mjs';
import roomTimelineSuite from './check/suites/room-timeline.mjs';
import aheadRelaySuite from './check/suites/ahead-relay.mjs';
import playbackHoldSuite from './check/suites/playback-hold.mjs';
import heldAheadLiveSuite from './check/suites/held-ahead-live.mjs';
import holdResumeSuite from './check/suites/hold-resume.mjs';
import playbackStateSuite from './check/suites/playback-state.mjs';
import playbackStateRulesSuite from './check/suites/playback-state-rules.mjs';
import playbackAcquisitionSuite from './check/suites/playback-acquisition.mjs';
import playbackAcquisitionTimingSuite from './check/suites/playback-acquisition-timing.mjs';
import playbackElectionSuite from './check/suites/playback-election.mjs';
import driftSuite from './check/suites/drift.mjs';
import driftControllerSuite from './check/suites/drift-controller.mjs';
import driftLoadSuite from './check/suites/drift-load.mjs';
import driftFiguresSuite from './check/suites/drift-figures.mjs';
import driftConvergenceSuite from './check/suites/drift-convergence.mjs';
import driftReportingSuite from './check/suites/drift-reporting.mjs';
import driftSettlingSuite from './check/suites/drift-settling.mjs';
import playbackStartSuite from './check/suites/playback-start.mjs';
import playbackStartReparkSuite from './check/suites/playback-start-repark.mjs';
import playbackStartCoverSuite from './check/suites/playback-start-cover.mjs';
import farSkipSuite from './check/suites/far-skip.mjs';
import farSkipEntrySuite from './check/suites/far-skip-entry.mjs';
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
import hostEntrySuite from './check/suites/host-entry.mjs';
import runnerCoreSuite from './check/suites/runner-core.mjs';
import remuxCutPlanSuite from './check/suites/remux-cut-plan.mjs';
import remuxIndexSuite from './check/suites/remux-index.mjs';
import remuxWriterSuite from './check/suites/remux-writer.mjs';
import remuxPublishSuite from './check/suites/remux-publish.mjs';
import fileIdentitySuite from './check/suites/file-identity.mjs';
import remuxRunnerSuite from './check/suites/remux-runner.mjs';
import preparedStoreSuite from './check/suites/prepared-store.mjs';
import prepareRunnerSuite from './check/suites/prepare-runner.mjs';
import hostFileSourceSuite from './check/suites/host-file-source.mjs';
import hostFileEntrySuite from './check/suites/host-file-entry.mjs';
import hostFileStepsSuite from './check/suites/host-file-steps.mjs';
import browserCheckListSuite from './check/suites/browser-check-list.mjs';
import browserResultLogSuite from './check/suites/browser-result-log.mjs';

console.log(describeFixtures());

// Order matters only for legibility: each suite takes rooms of its own, so none
// of them can observe another.
for (const suite of [
  mediaSuite,
  byteAccountingSuite,
  harnessFiguresSuite,
  harnessQueueSuite,
  harnessUdpLoadSuite,
  harnessPairwiseSuite,
  harnessDriftPublicationSuite,
  harnessDriftPlotSuite,
  harnessByteCohortSuite,
  receiptCohortSuite,
  harnessRefusalsSuite,
  harnessArmsSuite,
  harnessImagesSuite,
  harnessArmRecomputeSuite,
  harnessCadenceSuite,
  harnessPollShapeSuite,
  harnessRecordsSuite,
  trackerSpawnSuite,
  harnessConditionsSuite,
  harnessBehindSuite,
  harnessBehindPastSuite,
  harnessFrameStallsSuite,
  harnessDistanceBehindSuite,
  harnessRosterEventSuite,
  segmentWaitSuite,
  harnessSocketControlSuite,
  harnessPeerConditionsSuite,
  harnessPeerTopologySuite,
  topologyReadbackSuite,
  originProxySuite,
  harnessPeerUploadSuite,
  peerFiguresSuite,
  oneViewingSuite,
  nop2pSteadySuite,
  machineTestSuite,
  qaRecomputeSuite,
  p2pMeasurementSuite,
  regimesReadingSuite,
  regimesConditionsSuite,
  peerSpacingSuite,
  peerChecksSuite,
  peerChecksGroupSuite,
  receiptExcusalSuite,
  peerConservationShapedSuite,
  peerSettleSuite,
  hostOriginRefusalsSuite,
  harnessStartRequalSuite,
  harnessDriftRunnerSuite,
  joinSuite,
  hostSuite,
  identitySuite,
  routingSuite,
  presenceSuite,
  timeEchoSuite,
  robustnessSuite,
  livenessSuite,
  settingsSuite,
  mediaSourceSettingSuite,
  roomClientSuite,
  clockSuite,
  clockSyncSuite,
  segmentProtocolSuite,
  segmentFlowSuite,
  hostLinkSuite,
  hostOriginSuite,
  hostAccountingSuite,
  hostReceiptsSuite,
  hostOriginFiguresSuite,
  hostOriginBarsSuite,
  fetchShimBarsSuite,
  peerBytesSuite,
  bytesReadoutSuite,
  peerEngineConfigSuite,
  hostLoadTimeoutSuite,
  engineWindowsSuite,
  urgentSourceSuite,
  edgeAssignmentSuite,
  edgeSpreadSuite,
  edgeSourceSuite,
  edgeRequestSuite,
  runwayEntrySuite,
  edgeControlSuite,
  enginePatchSuite,
  edgeAsksSuite,
  capacityEstimateSuite,
  sendPaceSuite,
  hostPaceSuite,
  sendArbiterSuite,
  urgentRequestSuite,
  edgePositionSuite,
  wireEstimateSuite,
  echoDelaySuite,
  harnessJoinOrderSuite,
  qualificationEarlySuite,
  boundaryAsyncSuite,
  assignmentControlSuite,
  capacityScheduleSuite,
  scheduleRecoverySuite,
  runwaySuite,
  askEvidenceSuite,
  edgeFiguresSuite,
  edgeReadingSuite,
  edgeConditionsSuite,
  paceBoundSuite,
  capUsedSuite,
  steadyCapUsedSuite,
  controlEvidenceSuite,
  controlFiguresSuite,
  controlReadingSuite,
  controlReadingScriptSuite,
  buildMatchSuite,
  controlReadingRepairsSuite,
  harnessContentSuite,
  segmentSecondsSuite,
  controlRereadSuite,
  headroomSuite,
  seekEntrySuite,
  capacityStepSuite,
  seekEvidenceSuite,
  seekHoldSuite,
  trapFiguresSuite,
  trapReadingSuite,
  starvedRecomputeSuite,
  heldAheadSuite,
  spanCourseSuite,
  peerExchangeEntrySuite,
  peerExchangeBarsSuite,
  positionOffsetSuite,
  roomTimelineSuite,
  aheadRelaySuite,
  playbackHoldSuite,
  heldAheadLiveSuite,
  holdResumeSuite,
  playbackStateSuite,
  playbackStateRulesSuite,
  playbackAcquisitionSuite,
  playbackAcquisitionTimingSuite,
  playbackElectionSuite,
  driftSuite,
  driftControllerSuite,
  driftLoadSuite,
  driftFiguresSuite,
  driftConvergenceSuite,
  driftReportingSuite,
  driftSettlingSuite,
  playbackStartSuite,
  playbackStartReparkSuite,
  playbackStartCoverSuite,
  farSkipSuite,
  farSkipEntrySuite,
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
  hostEntrySuite,
  runnerCoreSuite,
  remuxCutPlanSuite,
  remuxIndexSuite,
  remuxWriterSuite,
  remuxPublishSuite,
  fileIdentitySuite,
  remuxRunnerSuite,
  preparedStoreSuite,
  prepareRunnerSuite,
  hostFileSourceSuite,
  hostFileEntrySuite,
  hostFileStepsSuite,
  browserCheckListSuite,
  browserResultLogSuite,
]) {
  await suite();
}

await disposeFixtures();
process.exit(report());
