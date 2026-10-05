export const CONTROL_PRODUCT = 'product';
export const CONTROL_8B = '8b';

export function readControl(supplied) {
  const result = supplied === undefined
    ? { control: CONTROL_PRODUCT, supplied: false, error: null }
    : supplied === CONTROL_8B
      ? { control: CONTROL_8B, supplied: true, error: null }
      : { control: CONTROL_PRODUCT, supplied: true, error: 'control-must-be-8b' };
  return Object.freeze(result);
}

const CONTROL_IN_FORCE = readControl(globalThis.__waControl);

export function controlInForce() {
  return CONTROL_IN_FORCE;
}
