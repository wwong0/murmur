import { formatMediaTime } from './media-time.mjs';
import { readChatMessage } from './envelope.mjs';

const UNKNOWN = 'Someone';

// How many guest chip colours `room.css` defines (`--chip-N`); a guest past them wraps round.
const GUEST_TONES = 5;

// Where labels repeat, every one after the first in list order gains " (2)", " (3)"… (exact compare).
function numberRepeats(people) {
  const seen = new Map();
  return people.map((person) => {
    const count = (seen.get(person.label) ?? 0) + 1;
    seen.set(person.label, count);
    return count === 1 ? person : { ...person, label: `${person.label} (${count})` };
  });
}

/**
 * The roster as the room shows its members: the host first, then the rest in roster order with
 * the host skipped. A named member shows its name; an unnamed one "Host" or
 * "Guest N". `tone` picks the chip colour: `'host'`, or a guest number cycling through the
 * guest palette in guest order. The text carries no tab or client id.
 */
export function memberLabels(roster) {
  const members = (Array.isArray(roster) ? roster : []).filter((member) => member !== null && typeof member === 'object');
  const hosts = members.filter((member) => member.role === 'host');
  const guests = members.filter((member) => member.role !== 'host');
  const named = (member) => (typeof member.name === 'string' && member.name.length > 0 ? member.name : null);
  const initialOf = (name, fallback) => (name === null ? fallback : [...name][0].toUpperCase());
  return numberRepeats([
    ...hosts.map((member) => ({
      clientId: member.clientId, label: named(member) ?? 'Host', initial: initialOf(named(member), 'H'), host: true, tone: 'host',
    })),
    ...guests.map((member, index) => ({
      clientId: member.clientId,
      label: named(member) ?? `Guest ${index + 1}`,
      initial: initialOf(named(member), String(index + 1)),
      host: false,
      tone: (index % GUEST_TONES) + 1,
    })),
  ]);
}

/** The lookup `activityText` reads: clientId to label, from one `memberLabels` result. */
export function labelMap(people) {
  return new Map(people.map((person) => [person.clientId, person.label]));
}

/**
 * One activity line, or null where the event says nothing. `labels` is the
 * lookup for the roster the event names: a leaver is in the one held before the leave, a
 * joiner in the one after. A `rename` carries its own two labels.
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
    case 'rename': {
      const before = event.before ?? UNKNOWN;
      const after = event.after ?? UNKNOWN;
      return before === after ? null : `${before} is now ${after}`;
    }
    case 'rate': return "You're sending too fast — wait a moment";
    default: return null;
  }
}

/** A relayed chat as an activity entry body, or null where the message is not one. */
export function chatLine(env, people) {
  const message = readChatMessage(env);
  if (!message.ok) return null;
  const sender = people.find((person) => person.clientId === env.from);
  return { kind: 'chat', label: sender?.label ?? UNKNOWN, tone: sender?.tone ?? null, text: message.text };
}
