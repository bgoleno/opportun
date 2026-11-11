// Import order (https://github.com/bgoleno/opportun/issues/343): safeFetch imports obs/outbound,
// which imports the catalog, which reads safeFetch's ATS_ALLOW_HOSTS. Loaded with safeFetch
// first (as the server's adapters load it), the catalog must not read that list while
// safeFetch is still initialising. Vitest gives each file a fresh module graph, so the
// dynamic import below is the first load of each module.
import { describe, expect, it } from 'vitest';

describe('loading safeFetch before the catalog (#343)', () => {
  it('works, and server.address still takes the ATS hosts', async () => {
    const { ATS_ALLOW_HOSTS } = await import('../src/lib/safeFetch');
    const { fixedServiceHosts } = await import('../src/obs/catalog');
    for (const host of ATS_ALLOW_HOSTS) expect(fixedServiceHosts()).toContain(host);
  });
});
