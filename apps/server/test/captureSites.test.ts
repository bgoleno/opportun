// Posting identity (design D20). The capture and the lead it completes describe one req two
// different ways, so matching them on a dedupe key built from company, title and location
// fails whenever the AI refine step did not run (no key, budget spent, provider error): the
// capture then carries no location at all. Identity is exact and needs no AI.
import { CAPTURE_SITES, indeed, INDEED_JOB_KEY, type NormalizedPosting } from '@opportun/core';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseIndeedAlert } from '../src/lib/alertParsers/indeed';
import { postingIdentity, siteLabel, siteOfLabel, siteOfUrl } from '../src/lib/captureSites';

const posting = (over: Partial<NormalizedPosting>): NormalizedPosting => ({
  company: 'Initech',
  title: 'Staff Product Manager',
  ...over,
});

describe('postingIdentity', () => {
  it('reads the two shapes the 2026-10-18 collision actually held', () => {
    // The extension capture stored `linkedin:1000000001`; the alert-email lead for the same
    // req stored a bare `1000000001`. They are the same posting.
    const capture = posting({
      externalId: 'linkedin:1000000001',
      postingUrl: 'https://www.linkedin.com/jobs/view/1000000001',
    });
    const alert = posting({
      externalId: '1000000001',
      postingUrl: 'https://www.linkedin.com/jobs/view/1000000001/',
    });
    expect(postingIdentity(capture)).toBe('linkedin:1000000001');
    expect(postingIdentity(alert)).toBe('linkedin:1000000001');
  });

  it('reads the id from the URL when there is no externalId at all', () => {
    expect(
      postingIdentity(posting({ postingUrl: 'https://www.linkedin.com/jobs/view/1000000001/' })),
    ).toBe('linkedin:1000000001');
  });

  it('accepts the country subdomains and the bare apex that LinkedIn also serves', () => {
    for (const host of ['www.linkedin.com', 'linkedin.com', 'uk.linkedin.com', 'de.linkedin.com']) {
      expect(
        postingIdentity(posting({ postingUrl: `https://${host}/jobs/view/1000000001/` })),
      ).toBe('linkedin:1000000001');
    }
  });

  it('is null for a bare externalId with no site to attach it to', () => {
    // A Greenhouse lead's externalId means nothing without its board, and must never be
    // matched against a LinkedIn capture that happens to carry the same digits.
    expect(postingIdentity(posting({ externalId: '1000000001' }))).toBeNull();
  });

  it('does not invent a site from an unknown prefix', () => {
    expect(postingIdentity(posting({ externalId: 'wellfound:12' }))).toBeNull();
  });

  it('is case-insensitive about the host and the stored prefix', () => {
    expect(postingIdentity(posting({ externalId: 'LINKEDIN:1000000001' }))).toBe(
      'linkedin:1000000001',
    );
    expect(
      postingIdentity(posting({ postingUrl: 'https://WWW.LinkedIn.COM/jobs/view/1000000001/' })),
    ).toBe('linkedin:1000000001');
  });

  it('refuses a lookalike host', () => {
    expect(
      postingIdentity(posting({ postingUrl: 'https://linkedin.com.evil.test/jobs/view/1/' })),
    ).toBeNull();
    expect(
      postingIdentity(posting({ postingUrl: 'https://notlinkedin.com/jobs/view/1/' })),
    ).toBeNull();
  });

  // #769: the host rules differ on purpose, so moving them to the site registry keeps each.
  it('reads a host with one trailing dot, and not with two', () => {
    for (const [href, id] of [
      ['https://www.linkedin.com./jobs/view/1/', 'linkedin:1'],
      ['https://www.indeed.com./viewjob?jk=0000000000000a01', 'indeed:0000000000000a01'],
    ] as const) {
      // An id beside it that the URL's own id must win over.
      const posted = posting({ externalId: '0000000000000b02', postingUrl: href });
      expect(postingIdentity(posted), href).toBe(id);
      const twoDots = href.replace('.com.', '.com..');
      expect(postingIdentity({ ...posted, postingUrl: twoDots }), twoDots).toBeNull();
      expect(siteOfUrl(twoDots), twoDots).toBeNull();
    }
  });

  it('refuses a job id that is not one', () => {
    expect(
      postingIdentity(posting({ postingUrl: 'https://www.linkedin.com/jobs/view/not-an-id/' })),
    ).toBeNull();
    expect(postingIdentity(posting({ postingUrl: 'https://www.linkedin.com/jobs/' }))).toBeNull();
  });

  it('ignores a non-https posting URL', () => {
    expect(
      postingIdentity(posting({ postingUrl: 'http://www.linkedin.com/jobs/view/1000000001/' })),
    ).toBeNull();
  });
});

describe('siteLabel', () => {
  it('names a known site the way the merge heading will read', () => {
    expect(siteLabel('linkedin')).toBe('LinkedIn');
  });

  it('falls back to the id for a site it does not know', () => {
    expect(siteLabel('wellfound')).toBe('wellfound');
  });

  it('names Indeed', () => {
    expect(siteLabel('indeed')).toBe('Indeed');
  });

  it('ships LinkedIn and Indeed, in that order, so adding a site is additive', () => {
    expect(CAPTURE_SITES.map((s) => s.id)).toEqual(['linkedin', 'indeed']);
  });
});

// https://github.com/bgoleno/opportun/issues/96: a stored capture names its site by label.
describe('siteOfLabel', () => {
  it('finds each site by its label', () => {
    expect(siteOfLabel('LinkedIn')?.id).toBe('linkedin');
    expect(siteOfLabel('Indeed')?.id).toBe('indeed');
  });

  it('ignores case and surrounding spaces', () => {
    expect(siteOfLabel('linkedin')?.id).toBe('linkedin');
    expect(siteOfLabel('  INDEED ')?.id).toBe('indeed');
    expect(siteOfLabel('\tIndeed\n')?.id).toBe('indeed');
  });

  it('finds nothing for a label no site has, or an empty one', () => {
    expect(siteOfLabel('wellfound')).toBeNull();
    expect(siteOfLabel('Indeed Jobs')).toBeNull();
    expect(siteOfLabel('In deed')).toBeNull();
    expect(siteOfLabel('')).toBeNull();
    expect(siteOfLabel('   ')).toBeNull();
  });
});

// https://github.com/bgoleno/opportun/issues/73. Job keys here are obviously fake hex.
describe('postingIdentity: Indeed', () => {
  it('gives every lead the Indeed alert parser makes an identity of indeed:<jk>', async () => {
    const text = await readFile(join(__dirname, 'fixtures/alerts/indeed-alert.txt'), 'utf8');
    const leads = parseIndeedAlert(text);
    expect(leads.length).toBeGreaterThan(0);
    for (const lead of leads) {
      expect(postingIdentity(lead)).toBe(`indeed:${lead.externalId}`);
    }
  });

  it('reads the job key from a /viewjob URL when there is no externalId', () => {
    expect(
      postingIdentity(
        posting({ postingUrl: 'https://www.indeed.com/viewjob?jk=0000000000000A01' }),
      ),
    ).toBe('indeed:0000000000000a01');
  });

  it('agrees with the alert parser on what a job key is', () => {
    const url = (jk: string) => new URL(`https://www.indeed.com/viewjob?jk=${jk}`);
    for (const jk of ['0000000a', '0000000000000a01', '0'.repeat(32), '00000000000000AF']) {
      expect(INDEED_JOB_KEY.test(jk), jk).toBe(true);
      expect(indeed.jobFromUrl(url(jk))?.id, jk).toBe(jk.toLowerCase());
    }
    for (const jk of ['000000a', '0'.repeat(33), '000000000000000g', '']) {
      expect(INDEED_JOB_KEY.test(jk), jk).toBe(false);
      expect(indeed.jobFromUrl(url(jk)), jk).toBeNull();
    }
  });

  it('reads a job key only from a single-posting URL', () => {
    for (const href of [
      'https://www.indeed.com/jobs?q=example&vjk=0000000000000a01',
      'https://www.indeed.com/?vjk=0000000000000a01',
      'https://www.indeed.com/viewjob/?jk=0000000000000a01',
      'https://www.indeed.com/cmp/Example-Corp',
      'https://www.indeed.com/viewjob',
    ]) {
      expect(indeed.jobFromUrl(new URL(href)), href).toBeNull();
    }
  });

  it('claims indeed.com and www.indeed.com only', () => {
    expect(siteOfUrl('https://indeed.com/viewjob?jk=0000000000000a01')?.id).toBe('indeed');
    expect(siteOfUrl('https://WWW.Indeed.COM/viewjob?jk=0000000000000a01')?.id).toBe('indeed');
    for (const href of [
      'https://uk.indeed.com/viewjob?jk=0000000000000a01',
      'https://www.indeed.co.uk/viewjob?jk=0000000000000a01',
      'https://indeed.com.evil.test/viewjob?jk=0000000000000a01',
      'https://notindeed.com/viewjob?jk=0000000000000a01',
      'http://www.indeed.com/viewjob?jk=0000000000000a01',
    ]) {
      expect(siteOfUrl(href), href).toBeNull();
    }
  });

  it('prefers the URL job key to an opaque externalId another source stored', () => {
    // A user-mapped MCP source can store its own id beside the Indeed URL. Read as the site's
    // id, it would contradict a capture of the same posting.
    expect(
      postingIdentity(
        posting({
          externalId: 'mcp-job-123',
          postingUrl: 'https://www.indeed.com/viewjob?jk=0000000000000a01',
        }),
      ),
    ).toBe('indeed:0000000000000a01');
  });

  it('takes a bare externalId only in the site id shape when the URL has no job key', () => {
    const elsewhere = 'https://www.indeed.com/rc/clk?from=ja';
    expect(
      postingIdentity(posting({ externalId: '0000000000000a01', postingUrl: elsewhere })),
    ).toBe('indeed:0000000000000a01');
    expect(
      postingIdentity(posting({ externalId: 'mcp-job-123', postingUrl: elsewhere })),
    ).toBeNull();
    expect(
      postingIdentity(
        posting({ externalId: 'mcp-job-123', postingUrl: 'https://www.linkedin.com/jobs/' }),
      ),
    ).toBeNull();
  });

  it('is still null for a bare externalId on a URL no site claims', () => {
    expect(
      postingIdentity(
        posting({
          externalId: '0000000000000a01',
          postingUrl: 'https://boards.example.test/jobs/0000000000000a01',
        }),
      ),
    ).toBeNull();
  });
});

// The addresses one posting goes by (https://github.com/bgoleno/opportun/issues/967; tl's W5 ruling,
// https://github.com/bgoleno/opportun/issues/967#issuecomment-7120119028). A tab is captured at fewer
// of them than a stored link may hold: a redirect is an address a tab passes through.
describe('the addresses of one posting', () => {
  const LI = '1000000001';
  const JK = '0000000000000a01';
  const tab = (href: string) => {
    const site = siteOfUrl(href);
    const job = site?.jobFromUrl(new URL(href)) ?? null;
    return job === null ? null : `${job.site}:${job.id}`;
  };
  const stored = (href: string) =>
    postingIdentity(posting({ postingUrl: href, externalId: 'opaque-1' }));

  it.each([
    [`https://www.linkedin.com/jobs/view/${LI}/`, `linkedin:${LI}`],
    [`https://www.linkedin.com/jobs/view/staff-engineer-at-initech-${LI}/`, `linkedin:${LI}`],
    [`https://www.linkedin.com/jobs/view/staff-engineer-at-initech-${LI}?trk=x`, `linkedin:${LI}`],
    [`https://de.linkedin.com/jobs/view/ing%C3%A9nieur-${LI}`, `linkedin:${LI}`],
    [`https://www.linkedin.com/comm/jobs/view/${LI}/?trackingId=x`, `linkedin:${LI}`],
    [`https://www.linkedin.com/comm/jobs/view/staff-engineer-${LI}`, `linkedin:${LI}`],
    ['https://www.linkedin.com/jobs/view/engineer-123456', 'linkedin:123456'],
    [`https://www.indeed.com/viewjob?jk=${JK}&from=serp`, `indeed:${JK}`],
  ])('a tab and a stored link at %s are %s', (href, identity) => {
    expect(tab(href)).toBe(identity);
    expect(stored(href)).toBe(identity);
  });

  it.each([
    [`https://www.linkedin.com/jobs/search/?currentJobId=${LI}&keywords=x`, `linkedin:${LI}`],
    [`https://www.linkedin.com/jobs/search-results/?currentJobId=${LI}`, `linkedin:${LI}`],
    [`https://www.linkedin.com/jobs/collections/recommended/?currentJobId=${LI}`, `linkedin:${LI}`],
    [`https://www.indeed.com/m/viewjob?jk=${JK}`, `indeed:${JK}`],
    [`https://www.indeed.com/rc/clk?jk=${JK.toUpperCase()}&bb=x`, `indeed:${JK}`],
    [`https://indeed.com/pagead/clk?mo=r&jk=${JK}`, `indeed:${JK}`],
    [`https://www.indeed.com/jobs?q=x&vjk=${JK}`, `indeed:${JK}`],
    [`https://www.indeed.com/?vjk=${JK}`, `indeed:${JK}`],
  ])('a stored link at %s is %s, and no tab is', (href, identity) => {
    expect(stored(href)).toBe(identity);
    expect(tab(href)).toBeNull();
  });

  it.each([
    // No id, and not enough digits for one: a year is not an id.
    'https://www.linkedin.com/jobs/view/staff-engineer-at-initech/',
    'https://www.linkedin.com/jobs/view/staff-engineer-2024/',
    'https://www.linkedin.com/jobs/view/staff-engineer-12345',
    'https://www.linkedin.com/jobs/view/staff-engineer-1000000001x',
    'https://www.linkedin.com/jobs/view/-1000000001',
    `https://www.linkedin.com/jobs/view/a-${'1'.repeat(21)}`,
    'https://www.linkedin.com/jobs/view/a-1000000001/apply',
    'https://www.linkedin.com/x/jobs/view/1000000001',
    'https://www.linkedin.com/jobs/search/?currentJobId=not-an-id',
    'https://www.linkedin.com/jobs/?currentJobId=1000000001',
    'https://www.linkedin.com/feed/?currentJobId=1000000001',
    'https://m.linkedin.com/jobs/view/1000000001',
    'https://www.indeed.com/pagead/clk?mo=r',
    'https://www.indeed.com/rc/clk?vjk=0000000000000a01',
    'https://www.indeed.com/jobs?jk=0000000000000a01',
    'https://www.indeed.com/cmp/Example?jk=0000000000000a01',
    'https://uk.indeed.com/viewjob?jk=0000000000000a01',
  ])('names no posting: %s', (href) => {
    expect(tab(href)).toBeNull();
    expect(postingIdentity(posting({ postingUrl: href, externalId: 'opaque-1' }))).toBeNull();
  });

  it('the id in the path wins over one in the query', () => {
    const href = `https://www.linkedin.com/jobs/view/${LI}/?currentJobId=2000000002`;
    expect(stored(href)).toBe(`linkedin:${LI}`);
    expect(tab(href)).toBe(`linkedin:${LI}`);
  });
});
