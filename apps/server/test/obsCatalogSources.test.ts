// The catalog's lists that other modules own (https://github.com/bgoleno/opportun/issues/764): the
// job kinds (jobs/registry.ts) and the public ATS hosts (lib/safeFetch.ts) are handed to the
// catalog by those modules as they load, so the catalog imports neither. What a booted server's
// catalog says is pinned here against the output captured from main 98ce1d5, before that change:
// every enum attribute's values, and the fixed service hosts.
import { describe, expect, it } from 'vitest';
import { ATTRIBUTES, fixedServiceHosts, type AttrType } from '../src/obs/catalog';
import { testApp } from './helpers';

function catalogOutput(): Record<string, unknown> {
  const out: Record<string, unknown> = { fixedServiceHosts: [...fixedServiceHosts()] };
  for (const [key, type] of Object.entries(ATTRIBUTES) as [string, AttrType][]) {
    if (type.kind !== 'enum' && type.kind !== 'enum_list') continue;
    out[key] = [...(typeof type.values === 'function' ? type.values() : type.values)];
  }
  return out;
}

describe("the catalog's lists on a booted server (#764)", () => {
  it('are what they were before the catalog took them as data', async () => {
    const { app } = await testApp();
    try {
      await expect(`${JSON.stringify(catalogOutput(), null, 2)}\n`).toMatchFileSnapshot(
        './fixtures/obsCatalogOutput.json',
      );
    } finally {
      await app.close();
    }
  });
});
