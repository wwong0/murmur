export const CONTROL_PRODUCT = 'product';
export const CONTROL_ARCHIVED = '8b';

export function readControl(supplied) {
  const result = supplied === undefined
    ? { control: CONTROL_PRODUCT, supplied: false, error: null }
    : supplied === CONTROL_ARCHIVED
      ? { control: CONTROL_ARCHIVED, supplied: true, error: null }
      : { control: CONTROL_PRODUCT, supplied: true, error: 'control-must-be-8b' };
  return Object.freeze(result);
}

const CONTROL_IN_FORCE = readControl(globalThis.__waControl);

export function controlInForce() {
  return CONTROL_IN_FORCE;
}
