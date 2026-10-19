import { formatMediaTime } from './media-time.mjs';

const UNKNOWN = 'Someone';

/**
 * The roster as the room shows its members: the host is "Host", the rest "Guest N" in
 * roster order with the host skipped (design.md D12). The text carries no tab or client id.
 */
export function memberLabels(roster) {
  let guests = 0;
  return (Array.isArray(roster) ? roster : [])
    .filter((member) => member !== null && typeof member === 'object')
    .map((member) => {
      if (member.role === 'host') return { clientId: member.clientId, label: 'Host', initial: 'H', host: true };
      guests += 1;
      return { clientId: member.clientId, label: `Guest ${guests}`, initial: String(guests), host: false };
    });
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
