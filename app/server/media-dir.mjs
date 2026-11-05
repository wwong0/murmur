// server/media-dir.mjs
//
// The one default for the media directory, imported by the server and every
// script that serves or reads the content. `npm run content`
// writes there; `APP_MEDIA_DIR` overrides it, resolved against the working
// directory.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MEDIA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'content');

export function mediaDirFrom(env = process.env) {
  return path.resolve(env.APP_MEDIA_DIR ?? DEFAULT_MEDIA_DIR);
}
