// The catalog loaded on its own (https://github.com/bgoleno/opportun/issues/764): the job kinds and
// the ATS hosts come from the modules that own them, as those load. Read before they have, the
// catalog refuses, so an entry point that never loads lib/safeFetch.ts or jobs/registry.ts fails
// loudly rather than gating telemetry against a short list. Its own file: vitest gives each file
// a fresh module graph, and nothing here imports either owner.
import { describe, expect, it } from 'vitest';
import { ATTRIBUTES, fixedServiceHosts } from '../src/obs/catalog';

describe('the catalog with its sources not loaded (#764)', () => {
  it('refuses to name the fixed service hosts', () => {
    expect(() => fixedServiceHosts()).toThrow(/lib\/safeFetch/);
  });

  it('refuses to list the job kinds', () => {
    const type = ATTRIBUTES['opportun.job.kind'];
    expect(type.kind).toBe('enum');
    if (type.kind !== 'enum' || typeof type.values !== 'function') throw new Error('not lazy');
    const values = type.values;
    expect(() => values()).toThrow(/jobs\/registry/);
  });
});
