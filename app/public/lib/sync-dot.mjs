import { signed } from './drift-readout.mjs';

export const IN_SYNC_MS = 40;

export function syncDot({ playing, mode, estimateMs }) {
  if (playing !== true || !Number.isFinite(estimateMs)) return { state: 'idle', title: 'no figure' };
  const correcting = mode === 'correcting' || mode === 'beyond-rate-authority';
  const state = correcting || Math.abs(estimateMs) > IN_SYNC_MS ? 'correcting' : 'in-sync';
  return { state, title: signed(estimateMs).replace(/ms$/, ' ms') };
}
