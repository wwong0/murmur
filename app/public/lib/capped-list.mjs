export function appendCapped(list, entry, cap) {
  if (!Array.isArray(list)) throw new TypeError('appendCapped list must be an array');
  if (!Number.isInteger(cap) || cap < 0) throw new TypeError('appendCapped cap must be a non-negative integer');
  return cap === 0 ? [] : [...list, entry].slice(-cap);
}
