// The two member sends the server reads, `name` and `chat` (change 12d), and the allowance
// both spend. Each is checked for address, then shape, then rate, so a refused shape spends
// nothing. Detail text is fixed: nothing the sender wrote is quoted or logged.

import {
  ADDR_ROOM,
  ADDR_SERVER,
  ERROR_CODES,
  TYPE_CHAT,
  TYPE_NAME,
  readChatMessage,
  readNameRequest,
} from '../public/lib/envelope.mjs';

const DEFAULT_BURST = 5;
const DEFAULT_REFILL_MS = 1000;

const SENDS = {
  [TYPE_NAME]: {
    to: ADDR_SERVER,
    read: readNameRequest,
    misaddressed: 'name must be addressed to "server"',
    malformed: 'name must be 1 to 32 characters with no control or direction characters',
  },
  [TYPE_CHAT]: {
    to: ADDR_ROOM,
    read: readChatMessage,
    misaddressed: 'chat must be addressed to "room"',
    malformed: 'chat must hold only text of 1 to 500 characters with no control or direction characters',
  },
};

export const isMemberSend = (type) => Object.hasOwn(SENDS, type);

function requirePositiveSafeInteger(value, setting) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${setting} must be a positive integer`);
  }
}

/** The allowance settings, defaulted and validated; throws on a bad one. */
export function allowanceRule(chatBurst, chatRefillMs, burstSetting = 'APP_CHAT_BURST', refillSetting = 'APP_CHAT_REFILL_MS') {
  const burst = chatBurst ?? DEFAULT_BURST;
  const refillMs = chatRefillMs ?? DEFAULT_REFILL_MS;
  requirePositiveSafeInteger(burst, burstSetting);
  requirePositiveSafeInteger(refillMs, refillSetting);
  return { burst, refillMs };
}

/** The protocol envelope bucket uses the same token rules as member sends. */
export function envelopeRule(envelopeBurst, envelopeRefillMs) {
  return allowanceRule(envelopeBurst, envelopeRefillMs, 'APP_ENVELOPE_BURST', 'APP_ENVELOPE_REFILL_MS');
}

/** The per-address membership bucket uses the same token rules as member sends. */
export function joinRule(joinBurst, joinRefillMs) {
  return allowanceRule(joinBurst, joinRefillMs, 'APP_JOIN_BURST', 'APP_JOIN_REFILL_MS');
}

/** `APP_CHAT_BURST` and `APP_CHAT_REFILL_MS` as `startRoomServer` options; unset is undefined. */
export function allowanceFromEnv(env) {
  const digitsOnly = (name) => {
    const text = env[name];
    if (text === undefined) return undefined;
    if (!/^\d+$/.test(text)) throw new TypeError(`${name} must contain decimal digits only`);
    return Number(text);
  };
  return {
    chatBurst: digitsOnly('APP_CHAT_BURST'),
    chatRefillMs: digitsOnly('APP_CHAT_REFILL_MS'),
    envelopeBurst: digitsOnly('APP_ENVELOPE_BURST'),
    envelopeRefillMs: digitsOnly('APP_ENVELOPE_REFILL_MS'),
    joinBurst: digitsOnly('APP_JOIN_BURST'),
    joinRefillMs: digitsOnly('APP_JOIN_REFILL_MS'),
  };
}

/** A new membership's allowance: a full burst. */
export const newAllowance = (rule, now) => ({ tokens: rule.burst, atMs: now });

// Token bucket, refilled when a send arrives; true when one was spent.
export function spend(allowance, rule, now) {
  const gained = Math.floor((now - allowance.atMs) / rule.refillMs);
  if (gained > 0) {
    allowance.tokens = Math.min(rule.burst, allowance.tokens + gained);
    allowance.atMs += gained * rule.refillMs;
  }
  if (allowance.tokens >= rule.burst) allowance.atMs = now;
  if (allowance.tokens === 0) return false;
  allowance.tokens -= 1;
  return true;
}

/** Admit a joined member's `name` or `chat`: `{ ok: true, request }` or the refusal's code and detail. */
export function admitMemberSend(env, allowance, rule, now) {
  const send = SENDS[env.type];
  if (env.to !== send.to) return { ok: false, code: ERROR_CODES.BAD_ENVELOPE, detail: send.misaddressed };
  const request = send.read(env);
  if (!request.ok) return { ok: false, code: ERROR_CODES.BAD_ENVELOPE, detail: send.malformed };
  if (!spend(allowance, rule, now)) return { ok: false, code: ERROR_CODES.RATE_LIMITED, detail: 'sending too fast' };
  return { ok: true, request };
}
