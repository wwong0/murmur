import { median, percentile } from '../../public/lib/frame-drift.mjs';

const finite = (value) => Number.isFinite(value);

function inWindow(records, window, field) {
  const source = Array.isArray(records) ? records : [];
  if (!finite(window?.startMs) || !finite(window?.endMs)) return source;
  return source.filter((record) => finite(record?.[field])
    && record[field] >= window.startMs && record[field] <= window.endMs);
}

function clientRecords(client) {
  return client?.records ?? client?.driftRecords ?? [];
}

function clientPolls(client) {
  return client?.polls ?? client?.pollRecords ?? client?.controllerPolls ?? [];
}

function values(records, read) {
  return records.map(read).filter(finite);
}

function putPercentiles(result, valuesToRecord, prefix, tag) {
  const sorted = valuesToRecord.filter(finite).sort((left, right) => left - right);
  if (!sorted.length) return;
  result[`${prefix}P50ByClient`] ??= {};
  result[`${prefix}P99ByClient`] ??= {};
  result[`${prefix}P50ByClient`][tag] = median(sorted);
  result[`${prefix}P99ByClient`][tag] = percentile(sorted, 0.99);
}

function cadenceFor(manifest, tag) {
  return manifest?.cadence?.[tag];
}

function joinFigures(result, clients, tags, clockJoin) {
  for (const tag of tags) {
    const joined = Array.isArray(clockJoin?.[tag]?.joined) ? clockJoin[tag].joined : null;
    const replies = Array.isArray(clockJoin?.[tag]?.echoReplies) ? clockJoin[tag].echoReplies : null;
    if (joined && replies) {
      result.clockJoinCountByClient ??= {};
      result.clockJoinCountByClient[tag] = joined.length;
      if (joined.length && replies.length) {
        const first = Number(replies[0]?.cdpMs) - Number(joined[0]?.cdpMs);
        if (finite(first) && first >= 0) {
          result.clockFirstEstimateMsByClient ??= {};
          result.clockFirstEstimateMsByClient[tag] = first;
        } else if (finite(first) && first < 0) {
          throw new RangeError(`clock first estimate cannot be negative for ${tag}`);
        }
      }
    }
    const polls = clientPolls(clients[tag]);
    const last = polls.length ? polls.at(-1) : undefined;
    const probes = last?.clock?.probes;
    if (finite(probes?.abandoned)) {
      if (probes.abandoned < 0) throw new RangeError(`clock abandoned probes cannot be negative for ${tag}`);
      result.clockProbesAbandonedByClient ??= {};
      result.clockProbesAbandonedByClient[tag] = probes.abandoned;
      if (finite(probes.issued) && probes.issued > 0) {
        const fraction = probes.abandoned / probes.issued;
        if (!(fraction >= 0 && fraction <= 1)) throw new RangeError(`clock abandoned fraction is outside [0,1] for ${tag}`);
        result.clockProbeAbandonedFractionByClient ??= {};
        result.clockProbeAbandonedFractionByClient[tag] = fraction;
      }
    }
    if (last?.clock?.counters?.impossible > 0 && result.clockFirstEstimateMsByClient) {
      delete result.clockFirstEstimateMsByClient[tag];
    }
  }
  for (const field of ['clockFirstEstimateMsByClient']) {
    if (result[field] && !Object.keys(result[field]).length) delete result[field];
  }
}

export function driftContext({ clients = {}, tags = Object.keys(clients), window, manifest = {}, clockJoin = {} } = {}) {
  const result = {};
  for (const tag of tags) {
    const client = clients[tag] ?? {};
    const records = inWindow(clientRecords(client), window, 'displaySharedMs');
    const polls = inWindow(clientPolls(client), window, 'atMs');
    putPercentiles(result, values(records, (record) => record.clock?.halfWidthMs), 'clockHalfWidthMs', tag);
    putPercentiles(result, values(records, (record) => record.clock?.delayTermMs), 'clockDelayTermMs', tag);
    putPercentiles(result, values(records, (record) => record.clock?.ageTermMs), 'clockAgeTermMs', tag);
    putPercentiles(result, values(polls, (poll) => poll.controller?.bandMs), 'controllerBandMs', tag);
    putPercentiles(result, values(polls, (poll) => poll.controller?.stoppingThresholdMs), 'controllerStoppingThresholdMs', tag);
    if (polls.length) {
      result.thresholdUsableFractionByClient ??= {};
      result.thresholdUsableFractionByClient[tag] = polls.filter((poll) => poll.controller?.thresholdUsable === true).length / polls.length;
      const last = polls.at(-1);
      const controller = last?.controller;
      if (controller && Object.hasOwn(controller, 'settlingMs')) {
        const settling = {
          settlingMs: controller.settlingMs,
          mode: controller.mode,
          thresholdUsable: controller.thresholdUsable,
          correctionsApplied: controller.correctionsApplied,
        };
        if ((finite(controller.settlingMs) || controller.settlingMs === null)
          && typeof controller.mode === 'string' && typeof controller.thresholdUsable === 'boolean') {
          result.settlingByClient ??= {};
          result.settlingByClient[tag] = settling;
        }
      }
    }
    const cadence = cadenceFor(manifest, tag);
    if (finite(cadence?.presentIntervalMs)) {
      result.presentIntervalMsByClient ??= {};
      result.presentIntervalMsByClient[tag] = cadence.presentIntervalMs;
    }
    if (cadence?.classification !== undefined && cadence?.classification !== null) {
      result.cadenceClassificationByClient ??= {};
      result.cadenceClassificationByClient[tag] = cadence.classification;
    }
  }
  joinFigures(result, clients, tags, clockJoin);
  return result;
}

export function driftFigure({ figures = {}, pairwise = {}, context = {}, condition = {}, window = {}, content = {} } = {}) {
  const { declaredClientTags: _declaredClientTags, clients: _clients, ...contextFields } = context;
  const figure = {
    ...figures,
    ...pairwise,
    ...contextFields,
    condition,
    window,
    content,
    ...(pairwise.criterionVerdict === undefined ? {} : { criterionVerdict: pairwise.criterionVerdict }),
    ...(pairwise.p99Verdict === undefined ? {} : { p99Verdict: pairwise.p99Verdict }),
  };
  return figure;
}
