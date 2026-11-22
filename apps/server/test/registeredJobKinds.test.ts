// The job kinds a booted server registers (https://github.com/bgoleno/opportun/issues/788): the
// handlers that lived in lib/ (lib/greenhouseEmbed.ts, lib/importer.ts, lib/linkedinExport.ts) are
// defined in jobs/ now, and still register at the same point at startup. The list is pinned
// against the one captured from main 48f15e1 before they moved (tl on #788).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { registeredJobKinds } from '../src/jobs/registry';
import { testApp } from './helpers';

describe('the job kinds a booted server registers (#788)', () => {
  it('are the ones it registered before the lib/ handlers moved to jobs/', async () => {
    const { app } = await testApp();
    try {
      const before: unknown = JSON.parse(
        readFileSync(new URL('./fixtures/registeredJobKinds.json', import.meta.url), 'utf8'),
      );
      expect(registeredJobKinds()).toEqual(before);
    } finally {
      await app.close();
    }
  });
});
