// The job queue before any handler can exist (https://github.com/bgoleno/opportun/issues/788):
// this file imports lib/jobQueue and nothing that registers a handler, so every kind is
// unregistered, and an enqueue stores its payload as given with the default attempts, as an
// unregistered kind always has. The insert is captured by a fake executor (no dedupe key, so
// enqueue takes its plain insert), since the test database helper boots the whole app.
import { describe, expect, it } from 'vitest';
import type { Exec } from '../src/db/client';
import { DEFAULT_MAX_ATTEMPTS, enqueue } from '../src/lib/jobQueue';

describe('enqueue with no handler registered (#788)', () => {
  it('stores the payload unchecked, with the default attempts', async () => {
    const inserted: Record<string, unknown>[] = [];
    const exec = {
      insert: () => ({
        values: (row: Record<string, unknown>) => ({
          run: async () => {
            inserted.push(row);
          },
        }),
      }),
    } as unknown as Exec;
    await enqueue(exec, 'comms.classify', { not: 'a classify payload' });
    expect(inserted).toEqual([
      expect.objectContaining({
        kind: 'comms.classify',
        payload: { not: 'a classify payload' },
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
      }),
    ]);
  });
});
