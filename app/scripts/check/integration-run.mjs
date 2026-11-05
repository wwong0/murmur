// scripts/check/integration-run.mjs
//
// One manufactured product client, driven through the real treatment adapter
// and the real product kernel, and the on-disk verifier run built from it.
// Shared by the product-integration-evidence and product-integration-supervisor
// suites.

import fs from 'node:fs';
import path from 'node:path';

import { fakeVideo } from './entry-harness.mjs';
import { rig } from './controller-rig.mjs';
import { INTEGRATION_SCHEMA, pitchReference } from '../drift-capture.mjs';
import { OFFLINE_STEP_INHERITED_ALLOWLIST, OFFLINE_STEP_ROUTE_SIGNATURE, auditClient, integrationSummary } from '../product-integration-evidence.mjs';
import { createDriftController } from '../../public/lib/drift-controller.mjs';
import { initializePlaybackTreatment } from '../../public/lib/playback-treatment.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * One client through the real adapter and kernel: an optional pre-settle
 * budget hold (U = 16, so S > 20), a correction, a 0 ms dwell to settled, and
 * `after` for whatever the case does once settled.
 */
export function simulate({ preSettleHold = true, videoOptions = {}, after = () => {} } = {}) {
  let controllerRig = null;
  const { video, control } = fakeVideo(videoOptions);
  const treatment = initializePlaybackTreatment({ video, opened: false, now: () => controllerRig?.state.nowMs ?? 0, evidence: true });
  controllerRig = rig({
    factory: createDriftController,
    settings: treatment.settings,
    options: { apply: (rate) => treatment.applyRate(rate), now: treatment.controllerNow },
  });
  const startups = [];
  const lines = [];
  const samples = [];
  const stream = { startups: 0, eventsWritten: 0, firstId: null, lastId: null, gaps: 0, lost: 0, unavailable: 0, pendingAtLastDrain: 0 };
  const step = (driftMs) => {
    treatment.pollController(() => controllerRig.poll(driftMs));
    const atMs = controllerRig.state.nowMs;
    const pitch = treatment.pitch();
    if (!startups.some((startup) => startup.id === pitch.startup.id)) startups.push(pitch.startup);
    const sample = { atMs, schema: INTEGRATION_SCHEMA, controller: treatment.view(controllerRig.controller.state()), pitch: pitchReference(pitch) };
    samples.push({ ...sample, source: 'capture' });
    if (samples.length % 2 === 0) samples.push({ ...clone(sample), source: 'settle' });
    const drained = treatment.drainEvidence();
    for (const event of drained.events) lines.push(event);
    Object.assign(stream, { lost: drained.lost, pendingAtLastDrain: drained.pending, eventsWritten: lines.length, firstId: lines[0]?.id ?? null, lastId: lines.at(-1)?.id ?? null, startups: startups.length });
  };
  const ctx = { step, control, treatment, rig: controllerRig };
  if (preSettleHold) {
    controllerRig.state.halfWidthMs = 16;
    for (let index = 0; index < 3; index += 1) step(0);
    controllerRig.state.halfWidthMs = 4;
  }
  for (let index = 0; index < 4; index += 1) step(12);
  for (let index = 0; index < 8; index += 1) step(0);
  after(ctx);
  for (let index = 0; index < 3; index += 1) step(0);
  return { label: 'A', startups, events: lines, samples, stream, missing: [] };
}

export const HEALTHY_ROUTE = clone({ ...OFFLINE_STEP_ROUTE_SIGNATURE, offlineSignature: { ...OFFLINE_STEP_ROUTE_SIGNATURE.offline, halfWidthWidened: true } });

export function writeRun(dir, clients, { failures = [...OFFLINE_STEP_INHERITED_ALLOWLIST], route = HEALTHY_ROUTE, notExercised = [] } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const audited = clients.map((client) => ({ ...auditClient(client), label: client.label }));
  for (const client of clients) {
    const treatmentLines = [
      ...client.startups.map((startup) => ({ kind: 'startup', atMs: startup.atMs, startup })),
      ...client.events.map((event) => ({ kind: 'event', atMs: event.atMs, event })),
    ];
    const write = (name, rows) => fs.writeFileSync(path.join(dir, `${client.label}.${name}.ndjson`), rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
    write('treatment', treatmentLines);
    write('captures', client.samples.filter((sample) => sample.source === 'capture').map(({ source, ...rest }) => rest));
    write('settle', client.samples.filter((sample) => sample.source === 'settle').map(({ source, ...rest }) => rest));
  }
  const manifest = {
    schemaVersion: 2,
    integrationSchema: INTEGRATION_SCHEMA,
    windows: clients.map((client) => ({ label: client.label, counts: { treatment: client.stream } })),
    integration: { summary: integrationSummary(audited) },
    outcome: failures.length === 0 ? 'pass' : 'failed',
    failures,
    notExercised,
    offlineStepRoute: route,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

export const pair = () => [simulate(), { ...simulate(), label: 'B' }];
