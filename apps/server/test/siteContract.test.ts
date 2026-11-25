// The job-site module contract (https://github.com/bgoleno/opportun/issues/769): every registered
// site runs through the same checks. A site is one module, its identity in packages/core/src/sites
// and its network half in apps/server/src/sites, so adding one means that module, its registry
// line and its fixtures. sec's egress points for #769 are checked here too: the allow-list comes
// from fetch hosts only, a rule matches what it says and nothing that looks like it, no fetch host
// is a prohibited one, and a slug or id cannot move a built URL's host or path.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CAPTURE_SITES, hostMatchesRule, SITES, type HostRule } from '@opportun/core';
import { describe, expect, it } from 'vitest';
import { sanitizePosting } from '../src/lib/postingSanitize';
import {
  ATS_ALLOW_HOSTS,
  createSafeFetch,
  isProhibitedHost,
  PAGE_FETCH_PROHIBITED_HOSTS,
  type RawResponse,
} from '../src/lib/safeFetch';
import { SourceConfigError, type SourceContext } from '../src/adapters/discoverySource';
import { SITE_MODULES, SLUG_SITES, siteOfKind, type SiteModule } from '../src/sites';
import { INDEED_JOB } from './fixtures/capture/indeedPages';
import { JOB as LINKEDIN_JOB, type CapturedPage } from './fixtures/capture/pages';
import { cpuMs } from './scaling';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/ats', name), 'utf8'));

/** Each site's recorded API answer, as the jobs its listing maps. A site with `mapPosting` needs one. */
const API_FIXTURES: Record<string, () => unknown[]> = {
  greenhouse: () => (fixture('greenhouse.json') as { jobs: unknown[] }).jobs,
  lever: () => fixture('lever.json') as unknown[],
  ashby: () => (fixture('ashby.json') as { jobs: unknown[] }).jobs,
};

/** Each site's job page as the extension sends it. A site with `capture` needs one. */
const CAPTURE_FIXTURES: Record<string, CapturedPage> = {
  linkedin: LINKEDIN_JOB,
  indeed: INDEED_JOB,
};

/** Each site's alert mail, as text. A site with `alertEmail` needs one. */
const ALERT_FIXTURES: Record<string, string> = {
  linkedin: 'linkedin-alert.txt',
  indeed: 'indeed-alert.txt',
};
const alertText = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures/alerts', name), 'utf8');

/** A host the rule names: the exact host, or the pattern's example. */
const hostOf = (rule: HostRule): string => ('exact' in rule ? rule.exact : rule.example);

/** What each pattern must refuse besides the shapes below, by its example. A pattern needs a line. */
const PATTERN_REFUSES: Record<string, string[]> = {
  'www.linkedin.com': ['m.linkedin.com', 'notlinkedin.com', 'evil-linkedin.com'],
  'acme.wd5.myworkdayjobs.com': [
    'myworkdayjobs.com',
    'wd5.myworkdayjobs.com',
    'acme.myworkdayjobs.com',
    'acme.wd5.notmyworkdayjobs.com',
    'acme.wd5555.myworkdayjobs.com',
    'acme.wd5.myworkdayjobs.com.wd5.evil.example',
  ],
  'wd5.myworkdaysite.com': [
    'myworkdaysite.com',
    'acme.myworkdaysite.com',
    'wd5.notmyworkdaysite.com',
  ],
};

/** Hosts that look like the rule's but are not it (sec, #769 point 3). */
const lookAlikes = (rule: HostRule): string[] => {
  const h = hostOf(rule);
  const around = [`x.${h}`, `${h}.evil.example`, `${h}x`];
  if ('exact' in rule) return [...around, `evil-${h}`];
  const refused = PATTERN_REFUSES[rule.example];
  if (refused === undefined) throw new Error(`no look-alikes for ${rule.example}`);
  return [...around, ...refused];
};

/** Ways a host can be written that are not it (sec on #769). */
const HOSTILE_HOSTS = (h: string): string[] => [
  `a@${h}`,
  `${h}:443`,
  `${h} `,
  `${h}\n`,
  ` ${h}`,
  '',
];

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

  it('lists the capture sites, in order, as the extension reads them', () => {
    expect(CAPTURE_SITES.map((s) => s.id)).toEqual(['linkedin', 'indeed']);
    expect([...CAPTURE_SITES]).toEqual(SITES.filter((s) => s.routes.capture !== undefined));
  });

  // Probing order is behaviour: the first board with a posting wins (lib/atsDetect.ts).
  it('tries a name on the slug-addressed boards only, in this order', () => {
    expect(SLUG_SITES.map((m) => m.identity.sourceKind)).toEqual([
      'ats_greenhouse',
      'ats_lever',
      'ats_ashby',
    ]);
  });

  it('builds the requests the boards have always been sent', () => {
    const built = (kind: string) => {
      const { identity, api } = siteOfKind(kind)!;
      const board = { site: identity.id, slug: 'initech' };
      return [
        api!.urls.board(board),
        api!.urls.board(board, { content: true }),
        api!.urls.page?.(board, 2),
        api!.urls.probe?.(board),
      ];
    };
    expect(built('ats_greenhouse')).toEqual([
      'https://boards-api.greenhouse.io/v1/boards/initech/jobs',
      'https://boards-api.greenhouse.io/v1/boards/initech/jobs?content=true',
      undefined,
      'https://boards-api.greenhouse.io/v1/boards/initech/jobs',
    ]);
    expect(built('ats_lever')).toEqual([
      'https://api.lever.co/v0/postings/initech?mode=json',
      'https://api.lever.co/v0/postings/initech?mode=json',
      'https://api.lever.co/v0/postings/initech?mode=json&skip=200&limit=100',
      'https://api.lever.co/v0/postings/initech?mode=json&limit=1',
    ]);
    expect(built('ats_ashby')).toEqual([
      'https://api.ashbyhq.com/posting-api/job-board/initech',
      'https://api.ashbyhq.com/posting-api/job-board/initech?includeCompensation=true',
      undefined,
      'https://api.ashbyhq.com/posting-api/job-board/initech',
    ]);
  });

  it.each(['ats_greenhouse', 'ats_lever', 'ats_ashby'])(
    '%s: a slug no board has is no board, and nothing is requested',
    async (kind) => {
      const { identity, api } = siteOfKind(kind)!;
      const asked: unknown[] = [];
      const sctx = {
        fetch: async (url: unknown) => {
          asked.push(url);
          throw new Error('not asked');
        },
        log: { warn: () => undefined },
      } as unknown as SourceContext;
      for (const slug of HOSTILE) {
        expect(await api!.probe!(sctx, { site: identity.id, slug }), slug).toBe('no');
      }
      expect(asked).toEqual([]);
    },
  );

  it('normalizes a host (case, spaces, trailing dots) in one pass, however long', () => {
    const rule = { exact: 'boards-api.greenhouse.io' };
    expect(hostMatchesRule(' Boards-API.greenhouse.io.. ', rule)).toBe(true);
    // CPU time, which a busy host does not add to (#948).
    const started = cpuMs();
    expect(hostMatchesRule(`${'.'.repeat(100_000)}x`, rule)).toBe(false);
    expect(hostMatchesRule(`x${'.'.repeat(100_000)}`, rule)).toBe(false);
    expect(cpuMs() - started).toBeLessThan(1_000);
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
        const config = site.board.configOf(board!);
        expect(site.board.configSchema.safeParse(config).success).toBe(true);
        expect(site.board.fromConfig(config)).toEqual(board);
        const page = new URL(site.board.pageUrl(board!));
        expect(matchesAny(page.hostname, site.pageHosts), page.href).toBe(true);
        expect(site.board.fromUrl(page)).toEqual(board);
        // It names a board and no job.
        expect(site.jobFromUrl(new URL(link)), link).toBeNull();
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
      const built = [urls.board(board), urls.board(board, { content: true })];
      if (urls.page !== undefined) built.push(urls.page(board, 0), urls.page(board, 1));
      if (urls.probe !== undefined) built.push(urls.probe(board));
      if (urls.job !== undefined) built.push(urls.job(board, job.id));
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
      // The whole slug, and the second part of one that has two (`<tenant>/<site>`).
      const [first, second] = board.slug.split('/');
      const slugs = [
        ...HOSTILE,
        ...(second === undefined ? [] : HOSTILE.map((b) => `${first}/${b}`)),
      ];
      for (const bad of slugs) {
        const named = { ...board, slug: bad };
        expect(() => urls.board(named), JSON.stringify(bad)).toThrow();
        if (urls.page !== undefined) expect(() => urls.page!(named, 0), bad).toThrow();
        if (urls.probe !== undefined) expect(() => urls.probe!(named), bad).toThrow();
        if (urls.job !== undefined) expect(() => urls.job!(board, bad), bad).toThrow();
        expect(() => site.board!.configOf(named), JSON.stringify(bad)).toThrow();
        expect(() => site.board!.pageUrl(named), JSON.stringify(bad)).toThrow();
      }
      // The first part alone, and with a letter more: no site is named, and none is made of it.
      for (const bad of second === undefined ? [] : [first!, `${first}X`]) {
        const named = { ...board, slug: bad };
        expect(() => urls.board(named), bad).toThrow();
        if (urls.page !== undefined) expect(() => urls.page!(named, 0), bad).toThrow();
        if (urls.probe !== undefined) expect(() => urls.probe!(named), bad).toThrow();
        expect(() => site.board!.configOf(named), bad).toThrow();
        expect(() => site.board!.pageUrl(named), bad).toThrow();
      }
      for (const bad of HOSTILE) {
        expect(site.board!.fromConfig({ org: bad }), bad).toBeNull();
        // Each part of a board that is more than one slug, in turn.
        const config = site.board!.configOf(board);
        for (const key of Object.keys(config)) {
          const moved = { ...config, [key]: bad };
          expect(site.board!.configSchema.safeParse(moved).success, `${key} ${bad}`).toBe(false);
          expect(site.board!.fromConfig(moved), `${key} ${bad}`).toBeNull();
        }
      }
    });

    // A board on a host of its own (Workday): the host is the tenant's or it is no board.
    it('makes no config, link or request of a board whose host is not its own', async () => {
      const board = site.board?.fromUrl(new URL(site.samples.boardUrls[0]!));
      if (board?.host === undefined) return;
      const others = [
        undefined,
        `other.${board.host.split('.').slice(1).join('.')}`,
        `x.${board.host}`,
        `${board.host}.evil.example`,
        ...HOSTILE_HOSTS(board.host),
      ];
      for (const host of others) {
        const moved = { ...board, host };
        expect(() => site.board!.configOf(moved), String(host)).toThrow();
        expect(() => site.board!.pageUrl(moved), String(host)).toThrow();
        expect(() => mod.api!.urls.board(moved), String(host)).toThrow();
        const asked: unknown[] = [];
        const sctx = {
          fetch: async (url: unknown) => asked.push(url),
          log: { warn: () => undefined },
        } as unknown as SourceContext;
        expect(await mod.api!.probe!(sctx, moved), String(host)).toBe('no');
        const config = { ...site.board!.configOf(board), host };
        const listing = mod.api!.listBoard!(sctx, config, null)[Symbol.asyncIterator]();
        await expect(listing.next(), String(host)).rejects.toThrow(SourceConfigError);
        expect(asked, String(host)).toEqual([]);
      }
    });

    it('builds no job page from a path that could move it, or one of another job', () => {
      const job = site.jobFromUrl(new URL(site.samples.jobUrls[0]!))!;
      if (job.path === undefined) return;
      for (const bad of HOSTILE) {
        for (const path of [bad, `/job/${bad}`, `/job/x/${bad}`, `${job.path}/${bad}`]) {
          expect(() => site.jobPageUrl({ ...job, path }), path).toThrow();
        }
      }
      expect(() => site.jobPageUrl({ ...job, path: undefined })).toThrow();
      expect(() => site.jobPageUrl({ ...job, id: 'ANOTHER-1' })).toThrow();
      for (const host of [undefined, ...HOSTILE_HOSTS(job.host!)]) {
        expect(() => site.jobPageUrl({ ...job, host }), String(host)).toThrow();
      }
    });

    it('builds no job page link for an id that is not one (sec, #769 point 5)', () => {
      const job = site.jobFromUrl(new URL(site.samples.jobUrls[0]!))!;
      for (const bad of HOSTILE) {
        expect(site.isJobId(bad), JSON.stringify(bad)).toBe(false);
        expect(() => site.jobPageUrl({ ...job, id: bad }), JSON.stringify(bad)).toThrow();
      }
    });

    it('reads no job from a look-alike host', () => {
      for (const link of site.samples.jobUrls) {
        for (const rule of site.pageHosts) {
          for (const fake of lookAlikes(rule)) {
            const url = new URL(link);
            url.hostname = fake;
            expect(site.jobFromUrl(url), url.href).toBeNull();
            expect(site.storedJobFromUrl?.(url) ?? null, url.href).toBeNull();
          }
        }
      }
    });

    it('matches each host rule exactly, and none of its look-alikes (sec, #769 point 3)', () => {
      for (const rule of [...site.fetchHosts, ...site.pageHosts]) {
        expect(hostMatchesRule(hostOf(rule), rule)).toBe(true);
        expect(hostMatchesRule(hostOf(rule).toUpperCase(), rule)).toBe(true);
        expect(hostMatchesRule(`${hostOf(rule)}.`, rule)).toBe(true);
        for (const fake of lookAlikes(rule)) expect(hostMatchesRule(fake, rule), fake).toBe(false);
        if ('exact' in rule) continue;
        expect(rule.pattern.flags).toBe('');
        expect(rule.pattern.source.startsWith('^') && rule.pattern.source.endsWith('$')).toBe(true);
        for (const fake of HOSTILE_HOSTS(hostOf(rule))) {
          expect(rule.pattern.test(fake), JSON.stringify(fake)).toBe(false);
        }
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
      for (const rule of site.fetchHosts) {
        // An exact host is in the list; a pattern puts nothing there (tl and sec on #769).
        if ('exact' in rule) expect(ATS_ALLOW_HOSTS).toContain(rule.exact);
        else expect(ATS_ALLOW_HOSTS.filter((h) => hostMatchesRule(h, rule))).toEqual([]);
      }
    });

    // Each API call passes the site's own rules, so a redirect from a fetch host to one of its
    // subdomains is refused through the real safeFetch: nothing is asked of the subdomain.
    it('follows no API redirect onto a subdomain of a fetch host (sec, #769 point 3)', async () => {
      const network = mod.api;
      if (network === undefined) return;
      const board = site.board!.fromUrl(new URL(site.samples.boardUrls[0]!))!;
      const job = site.jobFromUrl(new URL(site.samples.jobUrls[0]!))!;
      const requested: string[] = [];
      const fetch = createSafeFetch({
        now: () => 0,
        sleep: async () => undefined,
        resolve: async () => ['93.184.216.34'],
        request: async (target): Promise<RawResponse> => {
          requested.push(target.url.hostname);
          return {
            status: 302,
            headers: { location: `https://x.${target.url.hostname}${target.url.pathname}` },
            body: (async function* () {})(),
          };
        },
      });
      const log = { warn: () => undefined } as unknown as SourceContext['log'];
      const sctx: SourceContext = { fetch, log };
      if (network.listBoard !== undefined) {
        const run = async () => {
          const config = site.board!.configOf(board);
          for await (const _ of network.listBoard!(sctx, config, null)) void _;
        };
        await expect(run()).rejects.toThrow();
      }
      if (network.probe !== undefined) {
        expect(await network.probe(sctx, board)).toBe('unknown');
      }
      if (network.holdsJob !== undefined) {
        expect(await network.holdsJob(sctx, board.slug, job.id, undefined)).toBe('unknown');
      }
      expect(requested.length).toBeGreaterThan(0);
      for (const h of requested) expect(matchesAny(h, site.fetchHosts), h).toBe(true);
    });

    // The same for a module whose rule is a pattern (sec), which takes another tenant's host too. Its
    // requests carry a body or headers, so the real safeFetch follows no redirect of theirs at all;
    // what each one allows is asserted where it is made (workdayAdapter.test.ts).
    it('follows no redirect off the one host a board is on', async () => {
      const board = site.board?.fromUrl(new URL(site.samples.boardUrls[0]!));
      if (board?.host === undefined) return;
      const { host } = board;
      const elsewhere = [
        `other.${host.split('.').slice(1).join('.')}`,
        `x.${host}`,
        'wd5.myworkday.com',
        'community.workday.com',
        'myworkdayjobs.com',
      ];
      for (const to of elsewhere) {
        const requested: string[] = [];
        const fetch = createSafeFetch({
          now: () => 0,
          sleep: async () => undefined,
          resolve: async () => ['93.184.216.34'],
          request: async (target): Promise<RawResponse> => {
            requested.push(target.url.hostname);
            return {
              status: 302,
              headers: { location: `https://${to}${target.url.pathname}` },
              body: (async function* () {})(),
            };
          },
        });
        const log = { warn: () => undefined } as unknown as SourceContext['log'];
        expect(await mod.api!.probe!({ fetch, log }, board), to).toBe('unknown');
        const run = async () => {
          const config = site.board!.configOf(board);
          for await (const _ of mod.api!.listBoard!({ fetch, log }, config, null)) void _;
        };
        await expect(run(), to).rejects.toThrow();
        expect(new Set(requested), to).toEqual(new Set([host]));
      }
    });

    it('recognizes its capture page as a job its own links name, and reads its description back', () => {
      if (mod.capture === undefined) return;
      const page = CAPTURE_FIXTURES[site.id];
      expect(page, `a capture page for ${site.id}`).toBeDefined();
      const read = mod.capture.recognize(page!);
      if (read.kind !== 'job') throw new Error(`read as ${read.kind}`);
      expect(site.isJobId(read.jobId)).toBe(true);
      const link = new URL(read.jobUrl);
      expect(matchesAny(link.hostname, site.pageHosts), link.href).toBe(true);
      expect(site.jobFromUrl(link)).toEqual({ site: site.id, board: null, id: read.jobId });
      expect(mod.capture.storedDescriptionOf(page!.text)).toBe(read.descriptionMd);
    });

    it('parses its alert mail into leads on its own pages, named by its own job ids', () => {
      if (mod.alertEmail === undefined) return;
      const name = ALERT_FIXTURES[site.id];
      expect(name, `an alert mail for ${site.id}`).toBeDefined();
      expect(mod.alertEmail.senders.length).toBeGreaterThan(0);
      for (const sender of mod.alertEmail.senders) {
        expect(sender).toBe(sender.trim().toLowerCase());
        expect(sender).toMatch(/^[^@\s]+@[^@\s]+$/);
      }
      const leads = mod.alertEmail.parse(alertText(name!));
      expect(leads.length).toBeGreaterThan(0);
      for (const raw of leads) {
        const lead = sanitizePosting(raw);
        expect(lead.title.trim()).not.toBe('');
        const id = lead.externalId ?? '';
        expect(site.isJobId(id), id).toBe(true);
        expect(lead.postingUrl).toBe(site.jobPageUrl({ site: site.id, board: null, id }));
      }
      // No other site's mail is read as this site's.
      for (const [other, file] of Object.entries(ALERT_FIXTURES)) {
        if (other !== site.id) expect(mod.alertEmail.parse(alertText(file)), other).toEqual([]);
      }
    });

    it('asks a board whether it is serving a posting, and says when it has no answer', async () => {
      const network = mod.api;
      // The service window's answers are Workday's own (workdayAdapter.test.ts).
      if (network?.probe === undefined || network.slugAddressed !== true) return;
      const board = site.board!.fromUrl(new URL(site.samples.boardUrls[0]!))!;
      const answer = (status: number, body: string) =>
        ({
          fetch: async () => ({ status, headers: new Headers(), body: Buffer.from(body) }),
          log: { warn: () => undefined },
        }) as unknown as SourceContext;
      const listed = JSON.stringify(fixture(`${site.id}.json`));
      for (const status of [429, 500, 503]) {
        expect(await network.probe(answer(status, listed), board), `${status}`).toBe('unknown');
      }
      for (const status of [301, 400, 403, 404]) {
        expect(await network.probe(answer(status, listed), board), `${status}`).toBe('no');
      }
      expect(await network.probe(answer(200, listed), board)).toBe('yes');
      for (const body of ['[]', '{}', '{"jobs":[]}', '{"jobs":{}}', 'null', 'not json', '']) {
        expect(await network.probe(answer(200, body), board), body).toBe('no');
      }
    });

    it('reads the links of its recorded API answer', () => {
      const links = mod.api?.boardLinks;
      if (links === undefined) return;
      const read = links(fixture(`${site.id}.json`));
      expect(read.length).toBe(API_FIXTURES[site.id]!().length);
      for (const link of read) {
        expect(link.text.trim()).not.toBe('');
        expect(matchesAny(new URL(link.url).hostname, site.pageHosts), link.url).toBe(true);
      }
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
