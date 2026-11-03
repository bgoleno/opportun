// The body a queued comms.classify job carries, as the job itself will read it. It is sealed
// with the instance's secretBox key (#175), so tests open it with the app's own database key
// rather than reading a plaintext field.
import { decryptSecret } from '../src/lib/secretBox';
import type { HasDb } from './db';

/** The queued job's body, opened; undefined when the payload carries none. */
export function queuedBodyOf(app: HasDb, payload: unknown): string | undefined {
  const sealed = (payload as { bodySealed?: unknown } | null)?.bodySealed;
  if (sealed === undefined) return undefined;
  if (typeof sealed !== 'string') throw new Error('bodySealed is not a string');
  return decryptSecret(app.db, sealed);
}
