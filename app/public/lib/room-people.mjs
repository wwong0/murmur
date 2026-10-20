import { formatMediaTime } from './media-time.mjs';

const UNKNOWN = 'Someone';

// How many guest chip colours `room.css` defines (`--chip-N`); a guest past them wraps round.
const GUEST_TONES = 5;

/**
 * The roster as the room shows its members: the host first as "Host", then the rest as
 * "Guest N" in roster order with the host skipped (design.md D12). `tone` picks the chip
 * colour: `'host'`, or a guest number cycling through the guest palette in guest order
 * (executor-spec §0a A4). The text carries no tab or client id.
 */
export function memberLabels(roster) {
  const members = (Array.isArray(roster) ? roster : []).filter((member) => member !== null && typeof member === 'object');
  const hosts = members.filter((member) => member.role === 'host');
  const guests = members.filter((member) => member.role !== 'host');
  return [
    ...hosts.map((member) => ({ clientId: member.clientId, label: 'Host', initial: 'H', host: true, tone: 'host' })),
    ...guests.map((member, index) => ({
      clientId: member.clientId,
      label: `Guest ${index + 1}`,
      initial: String(index + 1),
      host: false,
      tone: (index % GUEST_TONES) + 1,
    })),
  ];
}

/** The lookup `activityText` reads: clientId to label, from one `memberLabels` result. */
export function labelMap(people) {
  return new Map(people.map((person) => [person.clientId, person.label]));
}

/**
 * One activity line, or null where the event says nothing (design.md D13). `labels` is the
 * lookup for the roster the event names: a leaver is in the one held before the leave, a
 * joiner in the one after.
 */
export function activityText(event, labels) {
  const who = (clientId) => labels.get(clientId) ?? UNKNOWN;
  switch (event.kind) {
    case 'join': return `${who(event.clientId)} joined`;
    case 'leave': return `${who(event.clientId)} left`;
    case 'play': return `${who(event.from)} played`;
    case 'pause': return `${who(event.from)} paused at ${formatMediaTime(event.positionMs)}`;
    case 'seek': return `${who(event.from)} skipped to ${formatMediaTime(event.positionMs)}`;
    case 'ended': return 'The film ended';
    case 'refused': return `Your ${event.op === 'seek' ? 'skip' : event.op} was refused — host only`;
    case 'reconnecting': return 'Reconnecting…';
    case 'reconnected': return 'Reconnected';
    default: return null;
  }
}
