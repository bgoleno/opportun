// The job-site module contract (https://github.com/bgoleno/opportun/issues/769): every registered
// site runs through the same checks. A site is one module, its identity in packages/core/src/sites
// and its network half in apps/server/src/sites, so adding one means that module, its registry
// line and its fixtures. sec's egress points for #769 are checked here too: the allow-list comes
// from fetch hosts only, a rule matches what it says and nothing that looks like it, no fetch host
// is a prohibited one, and a slug or id cannot move a built URL's host or path.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostMatchesRule, SITES, type HostRule } from '@opportun/core';
import { describe, expect, it } from 'vitest';
import { sanitizePosting } from '../src/lib/postingSanitize';
import {
  ATS_ALLOW_HOSTS,
  isProhibitedHost,
  PAGE_FETCH_PROHIBITED_HOSTS,
} from '../src/lib/safeFetch';
import { SITE_MODULES, type SiteModule } from '../src/sites';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/ats', name), 'utf8'));

/** Each site's recorded API answer, as the jobs its listing maps. A site with `api` needs one. */
const API_FIXTURES: Record<string, () => unknown[]> = {
  greenhouse: () => (fixture('greenhouse.json') as { jobs: unknown[] }).jobs,
};

/** A host the rule names: the exact host, or the pattern's example. */
const hostOf = (rule: HostRule): string => ('exact' in rule ? rule.exact : rule.example);

/** Hosts that look like the rule's but are not it (sec, #769 point 3). */
const lookAlikes = (rule: HostRule): string[] => {
  const h = hostOf(rule);
  return [`x.${h}`, `${h}.evil.example`, `evil-${h}`, `${h}x`];
};

const HOSTILE = [
  'a/b',
  '..',
  '.',
  'a@b',
  'a#b',
  'a?b',
  'a%2fb',
  'https://evil.example/x',
  'A B',
  '',
];

const matchesAny = (host: string, rules: readonly HostRule[]): boolean =>
  rules.some((r) => hostMatchesRule(host, r));

describe('the site registry (#769)', () => {
  it('lists each site once, in core and on the server alike', () => {
    const ids = SITE_MODULES.map((m) => m.identity.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(SITE_MODULES.map((m) => m.identity)).toEqual([...SITES]);
  });

  // An explicit list, so a new or widened host shows in review as a change here (sec, #769).
  // The registry's fetch hosts first, then the hand-written rest until their sites move (step 6).
  it('builds the ATS allow-list from fetch hosts, as written out here', () => {
    expect([...ATS_ALLOW_HOSTS]).toEqual([
      'boards-api.greenhouse.io',
      'api.lever.co',
      'api.ashbyhq.com',
      'api.smartrecruiters.com',
      'apply.workable.com',
    ]);
  });
});

describe.each(SITE_MODULES.map((m): [string, SiteModule] => [m.identity.id, m]))(
  'site %s (#769)',
  (_id, mod) => {
    const site = mod.identity;

    it('has a label and a category', () => {
      expect(site.label.trim()).not.toBe('');
      expect(['ats', 'aggregator']).toContain(site.category);
    });

    it('implements every route it declares, and declares every route it implements', () => {
      for (const route of ['api', 'mcp', 'capture', 'alertEmail'] as const) {
        expect(mod[route] !== undefined, route).toBe(site.routes[route] !== undefined);
      }
      const supplies = site.routes.api?.supplies ?? [];
      if (supplies.includes('boardListing')) expect(mod.api?.listBoard).toBeTypeOf('function');
      if (supplies.includes('byId')) expect(mod.api?.holdsJob).toBeTypeOf('function');
      if (supplies.includes('description')) expect(mod.api?.listBoard).toBeTypeOf('function');
      if (supplies.includes('search')) expect(mod.api).toHaveProperty('search');
    });

    it('registers an automated route only with the terms decision allowed, naming its issue', () => {
      for (const route of ['api', 'mcp'] as const) {
        const decl = site.routes[route];
        if (decl === undefined) continue;
        expect(decl.terms?.decision, route).toBe('allowed');
        expect(decl.terms?.issue, route).toMatch(
          /^https:\/\/github\.com\/bgoleno\/opportun\/issues\/\d+$/,
        );
        expect(decl.terms?.url, route).toMatch(/^https:\/\//);
      }
    });

    it('reads its sample job links, and its job page link reads back as the same job', () => {
      expect(site.samples.jobUrls.length).toBeGreaterThan(0);
      for (const link of site.samples.jobUrls) {
        const ref = site.jobFromUrl(new URL(link));
        expect(ref, link).not.toBeNull();
        expect(site.isJobId(ref!.id)).toBe(true);
        const page = new URL(site.jobPageUrl(ref!));
        expect(matchesAny(page.hostname, site.pageHosts), page.href).toBe(true);
        expect(site.jobFromUrl(page)).toEqual(ref);
      }
    });

    it('reads its sample board links, and its board page link reads back as the same board', () => {
      if (site.board === undefined) return;
      expect(site.samples.boardUrls.length).toBeGreaterThan(0);
      for (const link of site.samples.boardUrls) {
        const board = site.board.fromUrl(new URL(link));
        expect(board, link).not.toBeNull();
        expect(site.board.configSchema.safeParse({ org: board!.slug }).success).toBe(true);
        const page = new URL(site.board.pageUrl(board!));
        expect(matchesAny(page.hostname, site.pageHosts), page.href).toBe(true);
        expect(site.board.fromUrl(page)).toEqual(board);
      }
    });

    it('builds every API URL inside its fetch hosts, and uses every fetch host', () => {
      const urls = mod.api?.urls;
      if (urls === undefined) {
        expect(site.fetchHosts).toEqual([]);
        return;
      }
      const board = site.board!.fromUrl(new URL(site.samples.boardUrls[0]!))!;
      const job = site.jobFromUrl(new URL(site.samples.jobUrls[0]!))!;
      const built = [urls.board(board.slug), urls.board(board.slug, { content: true })];
      if (urls.job !== undefined) built.push(urls.job(board.slug, job.id));
      const hosts = built.map((u) => new URL(u).hostname);
      for (const h of hosts) expect(matchesAny(h, site.fetchHosts), h).toBe(true);
      for (const rule of site.fetchHosts) {
        expect(
          hosts.some((h) => hostMatchesRule(h, rule)),
          hostOf(rule),
        ).toBe(true);
      }
    });

    it('refuses a slug or id that could move the host or path (sec, #769 point 5)', () => {
      const urls = mod.api?.urls;
      if (urls === undefined) return;
      const board = site.board!.fromUrl(new URL(site.samples.boardUrls[0]!))!;
      for (const bad of HOSTILE) {
        expect(() => urls.board(bad), JSON.stringify(bad)).toThrow();
        if (urls.job !== undefined) expect(() => urls.job!(board.slug, bad), bad).toThrow();
      }
      for (const bad of HOSTILE) {
        expect(site.board!.configSchema.safeParse({ org: bad }).success, bad).toBe(false);
      }
    });

    it('matches each host rule exactly, and none of its look-alikes (sec, #769 point 3)', () => {
      for (const rule of [...site.fetchHosts, ...site.pageHosts]) {
        expect(hostMatchesRule(hostOf(rule), rule)).toBe(true);
        expect(hostMatchesRule(hostOf(rule).toUpperCase(), rule)).toBe(true);
        for (const fake of lookAlikes(rule)) expect(hostMatchesRule(fake, rule), fake).toBe(false);
      }
    });

    it('fetches from no prohibited host, and a site with one among its pages fetches nothing', () => {
      for (const rule of site.fetchHosts) {
        const h = hostOf(rule);
        expect(isProhibitedHost(h), h).toBe(false);
        expect(
          PAGE_FETCH_PROHIBITED_HOSTS.some((p) => h === p || h.endsWith(`.${p}`)),
          h,
        ).toBe(false);
      }
      const prohibitedPage = site.pageHosts.some((r) => {
        const h = hostOf(r);
        return (
          isProhibitedHost(h) ||
          PAGE_FETCH_PROHIBITED_HOSTS.some((p) => h === p || h.endsWith(`.${p}`))
        );
      });
      if (prohibitedPage) {
        expect(site.fetchHosts).toEqual([]);
        expect(site.routes.api).toBeUndefined();
        expect(site.routes.mcp).toBeUndefined();
      }
    });

    it('puts no page-only host in the allow-list (sec, #769 point 2)', () => {
      for (const rule of site.pageHosts) {
        if (matchesAny(hostOf(rule), site.fetchHosts)) continue;
        expect(ATS_ALLOW_HOSTS, hostOf(rule)).not.toContain(hostOf(rule));
      }
      for (const rule of site.fetchHosts) expect(ATS_ALLOW_HOSTS).toContain(hostOf(rule));
    });

    it('maps its recorded API answer to postings the sanitizer accepts', () => {
      if (mod.api?.mapPosting === undefined) return;
      const jobs = API_FIXTURES[site.id]?.();
      expect(jobs, `a fixture for ${site.id}`).toBeDefined();
      expect(jobs!.length).toBeGreaterThan(0);
      for (const raw of jobs!) {
        const posting = sanitizePosting(mod.api.mapPosting(raw, 'initech'));
        expect(posting.title.trim()).not.toBe('');
        expect(posting.externalId).not.toBeNull();
        const link = posting.postingUrl == null ? null : new URL(posting.postingUrl);
        if (link !== null) expect(matchesAny(link.hostname, site.pageHosts), link.href).toBe(true);
      }
    });
  },
);
