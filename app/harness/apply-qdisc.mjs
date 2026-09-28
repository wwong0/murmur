// Attaching a condition's qdiscs, and refusing the run when the kernel reports
// something other than what was asked for.
//
// Two rules from design.md D1 are operable here and nowhere else. **A qdisc is
// attached to one interface in one direction, and the condition says which** —
// so nothing in this file guesses a container, an interface or a direction;
// each is read out of the condition. And **the interface is resolved by its
// IPv4 address on the declared network's subnet, never named `eth0`**: a
// container on two networks receives them in an order Docker does not promise,
// and shaping the control interface would shape the channel the measurement is
// read over (executor-spec.md §3.1).
//
// The read-back is the proof, not the exit code. `tc qdisc add` can exit zero
// and leave a discipline whose parameters the kernel rounded, replaced or
// ignored, so every declared parameter is compared against the text
// `tc qdisc show` reports afterwards — numerically, because `tc` answers
// `burst 32kbit` with `burst 4Kb` and a string comparison would read a correct
// attachment as a mismatch.
//
// Runs on the HOST and reaches the containers with `docker exec`. Every path
// and interface name it handles is a container's.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export class QdiscMismatch extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'QdiscMismatch';
    this.detail = detail;
  }
}

export function defaultExec(argv, { input = undefined } = {}) {
  const result = execFileSync(argv[0], argv.slice(1), { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
  return result ?? '';
}

export function dockerExec(container, argv, exec = defaultExec) {
  return exec(['docker', 'exec', container, ...argv]);
}

// --- resolving the interface --------------------------------------------

export function ipToInteger(address) {
  const parts = String(address).split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts.reduce((total, part) => total * 256 + part, 0);
}

export function addressInSubnet(address, cidr) {
  const [network, bits] = String(cidr).split('/');
  const prefix = Number(bits);
  const left = ipToInteger(address);
  const right = ipToInteger(network);
  if (left === null || right === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return ((left & mask) >>> 0) === ((right & mask) >>> 0);
}

export function parseAddresses(json) {
  return JSON.parse(json).flatMap((entry) => (entry.addr_info ?? [])
    .filter((info) => info.family === 'inet')
    .map((info) => ({ ifName: entry.ifname, address: info.local, prefixLength: info.prefixlen })));
}

// A condition declares the logical network (`wa-media`); compose creates it as
// `<project>_wa-media`. The prefix is applied here so no condition has to carry
// the name of the project it happens to be run under.
export const COMPOSE_PROJECT = process.env.APP_HARNESS_PROJECT ?? 'wa6a';

export function networkSubnet(networkName, exec = defaultExec, project = COMPOSE_PROJECT) {
  const errors = [];
  for (const candidate of [`${project}_${networkName}`, networkName]) {
    try {
      const inspected = JSON.parse(exec(['docker', 'network', 'inspect', candidate]));
      const config = inspected?.[0]?.IPAM?.Config ?? [];
      const subnet = config.map((entry) => entry.Subnet).find(Boolean);
      if (subnet) return subnet;
      errors.push(`${candidate} declares no IPv4 subnet`);
    } catch (error) {
      errors.push(error.message.split('\n')[0]);
    }
  }
  throw new Error(`no IPv4 subnet for network ${networkName}: ${errors.join(' · ')}`);
}

/**
 * The interface carrying `subnet` inside `container`. Refuses a container whose
 * addresses match the subnet twice as readily as one that matches none: both
 * mean the topology is not what the condition declared, and picking either of
 * two is the guess this function exists to prevent.
 */
export function resolveInterface(container, subnet, exec = defaultExec) {
  const addresses = parseAddresses(dockerExec(container, ['ip', '-json', '-4', 'addr', 'show'], exec));
  const matches = addresses.filter((entry) => addressInSubnet(entry.address, subnet));
  if (matches.length !== 1) {
    throw new QdiscMismatch(
      `container ${container} has ${matches.length} interfaces on ${subnet}, expected exactly 1`,
      { container, subnet, addresses }
    );
  }
  return { ...matches[0], subnet, container };
}

// --- reading what the kernel reports back --------------------------------

const SIZE_SUFFIX = { b: 1, kb: 1000, k: 1000, mb: 1e6, m: 1e6, gb: 1e9, kib: 1024, mib: 1024 * 1024 };
const RATE_SUFFIX = { bit: 1, kbit: 1000, mbit: 1e6, gbit: 1e9, bps: 8, kbps: 8000, mbps: 8e6 };
const TIME_SUFFIX = { s: 1000, sec: 1000, secs: 1000, ms: 1, msec: 1, msecs: 1, us: 0.001, usec: 0.001 };

function suffixed(text, table, byteScale = 1) {
  const match = String(text).trim().match(/^([0-9]*\.?[0-9]+)\s*([a-zA-Z%]*)$/);
  if (!match) return null;
  const value = Number(match[1]);
  const suffix = match[2].toLowerCase();
  if (suffix === '%') return value;
  if (suffix === '') return value * byteScale;
  const scale = table[suffix];
  return scale === undefined ? null : value * scale;
}

/** `10mbit` and `10Mbit` are the same rate; `bps` is bytes per second in tc. */
export const parseRate = (text) => suffixed(text, RATE_SUFFIX, 8);

/** `32kbit` declared, `4Kb` reported — both are 4000 bytes. */
export function parseSize(text) {
  const asRate = String(text).trim().match(/^([0-9]*\.?[0-9]+)\s*(k|m|g)?bit$/i);
  if (asRate) return Number(asRate[1]) * ({ undefined: 1, k: 1000, m: 1e6, g: 1e9 }[asRate[2]?.toLowerCase()] ?? 1) / 8;
  return suffixed(text, SIZE_SUFFIX);
}

export const parseTime = (text) => suffixed(text, TIME_SUFFIX);

export const parseFraction = (text) => {
  const value = suffixed(text, {});
  return value === null ? null : value;
};

// What each declared parameter is called in the read-back, how to read both
// sides as a number, and how close the kernel is allowed to land. `burst` gets
// a cell-size tolerance because tc rounds it; nothing else gets one.
const PARAMETERS = {
  rate: { keys: ['rate'], parse: parseRate, tolerance: 0 },
  burst: { keys: ['burst', 'buffer'], parse: parseSize, tolerance: 0.05 },
  latency: { keys: ['lat', 'latency'], parse: parseTime, tolerance: 0.02 },
  limit: { keys: ['limit'], parse: (text) => Number(text), tolerance: 0 },
  loss: { keys: ['loss'], parse: parseFraction, tolerance: 0 },
  delay: { keys: ['delay'], parse: parseTime, tolerance: 0 },
  jitter: { keys: ['delay'], parse: parseTime, tolerance: 0, index: 1 },
};

export function parseQdiscLines(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('qdisc '))
    .map((line) => {
      const parts = line.split(/\s+/);
      const parentIndex = parts.indexOf('parent');
      return {
        line,
        kind: parts[1] ?? null,
        handle: parts[2] ?? null,
        parent: parentIndex === -1 ? (parts.includes('root') ? 'root' : null) : parts[parentIndex + 1],
      };
    });
}

function readValue(line, keys, index = 0) {
  for (const key of keys) {
    const match = line.match(new RegExp(`\\b${key}\\s+((?:[0-9]*\\.?[0-9]+\\s*[a-zA-Z%]*\\s*){1,2})`));
    if (match) {
      const words = match[1].trim().split(/\s+/);
      if (words[index] !== undefined) return words[index];
    }
  }
  return null;
}

/**
 * Every declared parameter, compared against the line the kernel printed. A
 * parameter the read-back does not mention is a mismatch, not a pass: the
 * silent case is the one where a discipline accepted the attachment and applied
 * a default.
 */
export function compareParameters(declared, line) {
  const mismatches = [];
  const readings = {};
  for (const [name, wanted] of Object.entries(declared ?? {})) {
    const rule = PARAMETERS[name];
    if (!rule) {
      mismatches.push({ parameter: name, reason: 'no read-back rule for this parameter', wanted });
      continue;
    }
    const raw = readValue(line, rule.keys, rule.index ?? 0);
    const got = raw === null ? null : rule.parse(raw);
    const want = rule.parse(wanted);
    readings[name] = { wanted, want, raw, got };
    if (raw === null || got === null || want === null) {
      mismatches.push({ parameter: name, reason: 'absent from the read-back', wanted, raw });
      continue;
    }
    const slack = Math.abs(want) * rule.tolerance;
    if (Math.abs(got - want) > slack) {
      mismatches.push({ parameter: name, reason: 'kernel reports a different value', wanted, raw, want, got, slack });
    }
  }
  return { mismatches, readings };
}

// --- attaching -----------------------------------------------------------

function paramArgv(params) {
  return Object.entries(params ?? {}).flatMap(([key, value]) => [key, String(value)]);
}

/**
 * The argv for one qdisc. `order` decides where it attaches: the first
 * discipline is the root, the second hangs under it. The two orders do not
 * shape identically, which is why the condition declares it and this function
 * never sorts (executor-spec.md §3.4).
 */
export function qdiscArgv({ ifName, discipline, params, order }) {
  const handle = `${order}0:`;
  const placement = order === 1 ? ['root', 'handle', handle] : ['parent', `${order - 1}0:1`, 'handle', handle];
  return ['tc', 'qdisc', 'add', 'dev', ifName, ...placement, discipline, ...paramArgv(params)];
}

export function changeArgv({ ifName, discipline, params }) {
  return ['tc', 'qdisc', 'change', 'dev', ifName, 'root', 'handle', '10:', discipline, ...paramArgv(params)];
}

export function changeQdisc({ state, capacityStep, exec = defaultExec }) {
  const container = state?.containers?.[capacityStep?.container];
  const ifName = state?.origin?.ifName;
  if (!container || !ifName) throw new QdiscMismatch('origin interface is unavailable for capacity step', { state, capacityStep });
  const argv = changeArgv({ ifName, discipline: capacityStep.discipline, params: capacityStep.params });
  dockerExec(container, argv, exec);
  const show = dockerExec(container, ['tc', 'qdisc', 'show', 'dev', ifName], exec);
  const lines = parseQdiscLines(show);
  const found = lines.find((entry) => entry.kind === capacityStep.discipline && entry.handle === '10:');
  if (!found) return { readings: {}, matches: false, line: null };
  const { mismatches, readings } = compareParameters(capacityStep.params, found.line);
  return { readings, matches: mismatches.length === 0, line: found.line };
}

export function clearArgv(ifName) {
  return ['tc', 'qdisc', 'del', 'dev', ifName, 'root'];
}

export function clearInterface(container, ifName, exec = defaultExec) {
  try {
    dockerExec(container, clearArgv(ifName), exec);
    return { container, ifName, cleared: true, error: null };
  } catch (error) {
    // `del root` on an interface with no qdisc exits non-zero, which is the
    // normal state before the first attachment and is not a failure.
    return { container, ifName, cleared: false, error: error.message };
  }
}

/**
 * Apply one condition's declared qdiscs and read every one of them back.
 *
 * `containers` maps a condition's container role (`origin`, `c01`, …) to the
 * running container's name. A condition naming a role with no container is a
 * refusal: the impairment it declared would simply not exist, and the run would
 * report a shaped link it never had.
 */
/**
 * `container: "client"` in a condition means EVERY client, because loss is
 * applied symmetrically unless a condition records a reason not to (design.md
 * D1) and a room where one client is impaired and the rest are not is a
 * different experiment. The expansion is explicit so the manifest records one
 * row per container actually shaped, not the word "client".
 */
export function expandQdiscs(condition) {
  return (condition.qdiscs ?? []).flatMap((qdisc) => {
    if (qdisc.container !== 'client') return [qdisc];
    return Array.from({ length: condition.clients }, (_, index) => ({
      ...qdisc,
      container: `c${String(index + 1).padStart(2, '0')}`,
      declaredContainer: 'client',
    }));
  });
}

export function applyQdiscs({ condition, containers, exec = defaultExec, subnets = new Map() }) {
  const records = [];
  const declared = expandQdiscs(condition);
  const byInterface = new Map();

  for (const qdisc of declared) {
    const container = containers[qdisc.container];
    if (!container) throw new QdiscMismatch(`condition names container ${qdisc.container}, which is not running`, { qdisc, containers });
    if (qdisc.direction !== 'egress') {
      throw new QdiscMismatch(`only egress disciplines are attached; condition declares ${qdisc.direction}`, { qdisc });
    }
    if (!subnets.has(qdisc.network)) subnets.set(qdisc.network, networkSubnet(qdisc.network, exec));
    const resolved = resolveInterface(container, subnets.get(qdisc.network), exec);
    const key = `${container}/${resolved.ifName}`;
    if (!byInterface.has(key)) {
      byInterface.set(key, true);
      clearInterface(container, resolved.ifName, exec);
    }
    const argv = qdiscArgv({ ifName: resolved.ifName, discipline: qdisc.discipline, params: qdisc.params, order: qdisc.order });
    dockerExec(container, argv, exec);
    records.push({
      ...qdisc,
      container,
      containerRole: qdisc.container,
      interface: resolved.ifName,
      resolvedAddress: resolved.address,
      subnet: resolved.subnet,
      command: argv.join(' '),
      appliedAt: new Date().toISOString(),
    });
  }

  for (const record of records) {
    const show = dockerExec(record.container, ['tc', 'qdisc', 'show', 'dev', record.interface], exec);
    const lines = parseQdiscLines(show);
    const found = lines.find((entry) => entry.kind === record.discipline && entry.handle === `${record.order}0:`);
    if (!found) {
      throw new QdiscMismatch(
        `${record.container}/${record.interface}: ${record.discipline} at handle ${record.order}0: is not attached`,
        { record, show }
      );
    }
    const { mismatches, readings } = compareParameters(record.params, found.line);
    record.readBack = { line: found.line, handle: found.handle, parent: found.parent, readings };
    if (mismatches.length) {
      throw new QdiscMismatch(
        `${record.container}/${record.interface}: ${record.discipline} read back with ${mismatches.length} mismatched parameter(s)`,
        { record, mismatches, show }
      );
    }
  }

  return records;
}

export function clearCondition({ condition, containers, exec = defaultExec, subnets = new Map() }) {
  const cleared = [];
  for (const qdisc of expandQdiscs(condition)) {
    const container = containers[qdisc.container];
    if (!container) continue;
    try {
      if (!subnets.has(qdisc.network)) subnets.set(qdisc.network, networkSubnet(qdisc.network, exec));
      const resolved = resolveInterface(container, subnets.get(qdisc.network), exec);
      cleared.push(clearInterface(container, resolved.ifName, exec));
    } catch (error) {
      cleared.push({ container, error: error.message, cleared: false });
    }
  }
  return cleared;
}

function cliArgument(name) {
  const found = process.argv.slice(2).find((argument) => argument.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { conditionForName } = await import('../scripts/harness-run.mjs');
  const { composeContainers } = await import('../scripts/harness/topology.mjs');
  const condition = conditionForName(cliArgument('condition'));
  const containers = composeContainers(cliArgument('project') ?? undefined);
  const records = cliArgument('clear') === null
    ? applyQdiscs({ condition, containers })
    : clearCondition({ condition, containers });
  process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
}
