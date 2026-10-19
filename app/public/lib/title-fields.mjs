// A title's two wire fields: its file identity (computed by file-identity.mjs) and its name.

const FILE_IDENTITY_PATTERN = /^v1:[0-9a-f]{64}$/;

export function isFileIdentity(value) {
  return typeof value === 'string' && FILE_IDENTITY_PATTERN.test(value);
}

export function isValidHostName(name) {
  return typeof name === 'string' && name.length >= 1 && name.length <= 255
    && !/[\\/\u0000-\u001f\u007f]/.test(name);
}
