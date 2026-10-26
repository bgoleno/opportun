import { AiUnavailableError, runStructured } from '@opportun/ai';
import { newId } from '@opportun/core';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activities,
  communications,
  companies,
  jobs,
  opportunities,
  roleTargets,
} from '../src/db/schema';
import {
  anchorsOf,
  bestTitleMatch,
  candidateDomains,
  careersLink,
  dollarAmounts,
  enrichOpportunity,
  OPPORTUNITY_ENRICH_KIND,
  pageNamesCompany,
  senderDomain,
} from '../src/jobs/opportunityEnrich';
import { ATS_DETECT_KIND } from '../src/jobs/atsDetect';
import { createSafeFetch } from '../src/lib/safeFetch';
import type { UserCtx } from '../src/repos/base';
import { createOpportunity } from '../src/repos/opportunities';
import { useApi } from './api';
import type { TestClient } from './isolation';

// The AI router is mocked; the default behaves like "no key": raw text becomes the description.
vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

const boot = useApi();

beforeEach(() => {
  vi.mocked(runStructured).mockReset();
  vi.mocked(runStructured).mockRejectedValue(new AiUnavailableError('no_key'));
});

const PUBLIC_IP = ['93.184.216.34'];

/** A safeFetch over a URL -> body map; unmapped URLs 404, unmapped hosts fail DNS. */
function net(routes: Record<string, string>) {
  const hosts = new Set(Object.keys(routes).map((u) => new URL(u).hostname));
  hosts.add('boards-api.greenhouse.io');
  hosts.add('api.lever.co');
  hosts.add('api.ashbyhq.com');
  const requested: string[] = [];
  const fetch = createSafeFetch({
    now: () => 0,
    sleep: async () => undefined,
    resolve: async (host) => {
      if (!hosts.has(host)) throw new Error(`no dns entry for ${host}`);
      return PUBLIC_IP;
    },
    request: async (target) => {
      requested.push(target.url.href);
      const body = new Map(Object.entries(routes)).get(target.url.href);
      return {
        status: body === undefined ? 404 : 200,
        headers: { 'content-type': 'text/html' },
        body: (async function* () {
          if (body !== undefined) yield Buffer.from(body);
        })(),
      };
    },
  });
  return { fetch, requested };
}

function ctxOf(c: TestClient): UserCtx {
  return { userId: c.userId, isAdmin: false };
}

async function outreachOpportunity(
  app: FastifyInstance,
  c: TestClient,
  companyName: string,
  title: string,
): Promise<string> {
  const opp = await createOpportunity(app.db, ctxOf(c), {
    companyName,
    title,
    sourceKind: 'communication',
  });
  return opp.id;
}

async function notesOf(
  app: FastifyInstance,
  oppId: string,
): Promise<{ title: string; bodyMd: string | null }[]> {
  return await app.db
    .select({ title: activities.title, bodyMd: activities.bodyMd })
    .from(activities)
    .where(and(eq(activities.opportunityId, oppId), eq(activities.kind, 'note')))
    .all();
}

async function oppRow(app: FastifyInstance, id: string) {
  return (await app.db.select().from(opportunities).where(eq(opportunities.id, id)).get())!;
}

const HOME = `<html><body>Initech Labs builds billing software.
  <a href="/careers">Careers</a></body></html>`;
const CAREERS = `<html><body><h1>Open positions</h1>
  <a href="/job/staff-platform-engineer/">Staff Platform Engineer</a>
  <a href="/job/office-coordinator/">Office Coordinator</a></body></html>`;
const POSTING = `<html><body><h1>Staff Platform Engineer</h1>
  <p>Remote (US). Build the billing platform. Salary $230,000.</p></body></html>`;

// Regression fixture for issue #238: a careers page shaped like github.careers, whose <head>
// embeds an ATS i18n bundle in a <script>. The bundle's values are themselves complete HTML
// documents (email templates), so the raw page contains several "</head>" substrings before the
// one that actually closes the page's own <head> -- the shape that broke the Gmail adapter's
// htmlToText, which searches the whole document for the first literal "</head>" rather than
// tracking nesting.
const ATS_I18N_BUNDLE = JSON.stringify({
  RESUME_ERROR: 'There was an error uploading your resume.',
  EASYAPPLY_EMAIL:
    '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><p>Hi, Thanks for starting your application to {{companyName}}</p></body></html>',
  REFERRAL_FAQ_EMAIL: '<html><head></head><body>Referral FAQ text, not the job.</body></html>',
});
const ATS_POSTING = `<!DOCTYPE html><html><head><meta charset="utf-8" />
<script>window.i18n = ${ATS_I18N_BUNDLE};</script>
</head><body><h1>Staff Platform Engineer</h1>
<p>Remote (US). Build the billing platform. Salary $230,000.</p></body></html>`;

describe('helpers', () => {
  it('senderDomain keeps a company domain, drops platforms, reads the LAST address', () => {
    expect(senderDomain('"Dana" <recruiter@northwind.example>')).toBe('northwind.example');
    expect(senderDomain('"Dana" <inmail-hit-reply@linkedin.com>')).toBeNull();
    expect(senderDomain('"spoof@real.com" <blast@hire.lever.co>')).toBeNull();
    expect(senderDomain('"a@fake.com" <real@initech.com>')).toBe('initech.com');
    expect(senderDomain('no address at all')).toBeNull();
  });

  it('candidateDomains puts the sender first and derives from the cleaned name', () => {
    expect(candidateDomains('Initech, Inc.', 'mail.initech.dev')).toEqual([
      'mail.initech.dev',
      'initech.com',
      'initech.co',
      'initech.io',
      'initech.ai',
    ]);
    expect(candidateDomains('AB', null)).toEqual([]);
  });

  describe('pageNamesCompany (issue #269: a wrong link is worse than no link)', () => {
    it('never matches a short name embedded inside an unrelated word', () => {
      // The exact collisions #269 found live: a bare substring search over raw HTML matched
      // these, because "enjoy", "wizard" and "advantage" all contain the shorter string.
      expect(pageNamesCompany('<body>Enjoy our product!</body>', 'Joy')).toBe(false);
      expect(pageNamesCompany('<body>Meet our wizard support team.</body>', 'Wiz')).toBe(false);
      expect(pageNamesCompany('<body>We give you the advantage in security.</body>', 'Vanta')).toBe(
        false,
      );
    });

    it('matches a short name that appears as its own word', () => {
      expect(pageNamesCompany('<body>Vanta automates security compliance.</body>', 'Vanta')).toBe(
        true,
      );
      expect(pageNamesCompany('<body><h1>Joy</h1> makes scheduling fun.</body>', 'Joy')).toBe(true);
    });

    it('never reads markup, class names or URLs as the company name appearing', () => {
      // The #238 shape: the only occurrence of "vanta" is inside a script's JSON, not the
      // page's own visible content.
      const html =
        '<html><head><script>window.data = {"internalKey":"vanta-build-id-8213"}</script></head>' +
        '<body class="theme-vanta-ui"><a href="/vanta-careers">Careers</a>' +
        '<p>We help companies pass audits faster.</p></body></html>';
      expect(pageNamesCompany(html, 'Vanta')).toBe(false);
    });

    it('a declared title or site-name matching exactly counts even for a short or numeric name', () => {
      // "F5" and "C1" (both two characters) can never clear the word-boundary floor on body
      // text alone, so without this path they would never verify at all (#269's other failure).
      expect(pageNamesCompany('<html><head><title>F5</title></head></html>', 'F5')).toBe(true);
      expect(
        pageNamesCompany('<html><head><title>F5, Inc. | Official Site</title></head></html>', 'F5'),
      ).toBe(true);
      expect(
        pageNamesCompany(
          '<html><head><meta property="og:site_name" content="C1"></head></html>',
          'C1',
        ),
      ).toBe(true);
      // An unrelated declared field of the same short length is not a match.
      expect(pageNamesCompany('<html><head><title>F6</title></head></html>', 'F5')).toBe(false);
    });

    it('a short/numeric name never verifies from body text alone, declared or not', () => {
      expect(
        pageNamesCompany('<body>Upgrade now: the F5 tier unlocks more storage.</body>', 'F5'),
      ).toBe(false);
    });

    it('an exact declared match is not fooled by a longer word containing the name', () => {
      // "advantage" is not a whole "|"-segment equal to "vanta", so it does not count even
      // though it contains the substring.
      expect(
        pageNamesCompany('<html><head><title>The Advantage Company</title></head></html>', 'Vanta'),
      ).toBe(false);
    });

    it('a multi-word name matches as a phrase, tolerant of punctuation between words', () => {
      expect(
        pageNamesCompany('<body>Acme Robotics builds the future.</body>', 'Acme Robotics'),
      ).toBe(true);
      expect(pageNamesCompany('<body>Acme-Robotics: careers</body>', 'Acme Robotics, Inc.')).toBe(
        true,
      );
      // Same words, wrong order: not a match.
      expect(pageNamesCompany('<body>Robotics by Acme</body>', 'Acme Robotics')).toBe(false);
    });

    it('a non-Latin name with no ASCII letters falls back to a literal substring check', () => {
      expect(pageNamesCompany('<body>甲骨文 provides cloud software.</body>', '甲骨文')).toBe(true);
      expect(pageNamesCompany('<body>A totally unrelated page.</body>', '甲骨文')).toBe(false);
      expect(pageNamesCompany('<html><head><title>甲骨文</title></head></html>', '甲骨文')).toBe(
        true,
      );
    });
  });

  it('dollarAmounts reads commas, k-suffixes and bounds', () => {
    expect(dollarAmounts('Compensation: $150,000 annually')).toEqual([150_000]);
    expect(dollarAmounts('from 150k to 180k')).toEqual([150_000, 180_000]);
    expect(dollarAmounts('5 roles, 401k match, est. 1999')).toEqual([401_000]);
  });

  it('anchors resolve relative urls and bestTitleMatch also reads url slugs', () => {
    const anchors = anchorsOf(CAREERS, 'https://initech.com/careers');
    expect(anchors[0]).toEqual({
      url: 'https://initech.com/job/staff-platform-engineer/',
      text: 'Staff Platform Engineer',
    });
    const best = bestTitleMatch(
      [{ url: 'https://initech.com/job/staff-platform-engineer/', text: 'Apply now' }],
      'Staff Platform Engineer',
    );
    expect(best?.url).toBe('https://initech.com/job/staff-platform-engineer/');
    expect(bestTitleMatch(anchors, 'VP of Sales')).toBeNull();
    expect(careersLink(anchorsOf(HOME, 'https://initech.com/'))).toBe(
      'https://initech.com/careers',
    );
  });
});

describe('enrichOpportunity', () => {
  it('finds the careers page from the company name, matches the posting and fills the record', async () => {
    const { app, a } = await boot();
    const id = await outreachOpportunity(app, a, 'Initech Labs', 'Staff Platform Engineer');
    const { fetch } = net({
      'https://initechlabs.com/': HOME,
      'https://initechlabs.com/careers': CAREERS,
      'https://initechlabs.com/job/staff-platform-engineer/': POSTING,
    });
    const outcome = await enrichOpportunity(app.db, ctxOf(a), fetch, id);
    expect(outcome).toEqual({
      outcome: 'enriched',
      postingUrl: 'https://initechlabs.com/job/staff-platform-engineer/',
    });
    const opp = await oppRow(app, id);
    expect(opp.postingUrl).toBe('https://initechlabs.com/job/staff-platform-engineer/');
    expect(opp.descriptionMd).toContain('Build the billing platform');
    // The discovered careers page lands on the company and queues the regular ATS detection.
    const company = (await app.db
      .select()
      .from(companies)
      .where(eq(companies.id, opp.companyId))
      .get())!;
    expect(company.careersUrl).toBe('https://initechlabs.com/careers');
    const detect = await app.db.select().from(jobs).where(eq(jobs.kind, ATS_DETECT_KIND)).all();
    expect(detect).toHaveLength(1);
    expect((await notesOf(app, id))[0]?.title).toBe('Posting details filled from the careers page');
  });

  it('a careers page whose <head> script embeds JSON with several </head> strings still yields the real description (issue #238)', async () => {
    const { app, a } = await boot();
    const id = await outreachOpportunity(app, a, 'Initech Labs', 'Staff Platform Engineer');
    const { fetch } = net({
      'https://initechlabs.com/': HOME,
      'https://initechlabs.com/careers': CAREERS,
      'https://initechlabs.com/job/staff-platform-engineer/': ATS_POSTING,
    });
    const outcome = await enrichOpportunity(app.db, ctxOf(a), fetch, id);
    expect(outcome).toEqual({
      outcome: 'enriched',
      postingUrl: 'https://initechlabs.com/job/staff-platform-engineer/',
    });
    const opp = await oppRow(app, id);
    expect(opp.descriptionMd).toContain('Build the billing platform');
    expect(opp.descriptionMd).not.toContain('RESUME_ERROR');
    expect(opp.descriptionMd).not.toContain('Thanks for starting your application');
    expect(opp.descriptionMd).not.toContain('Referral FAQ');
    expect(opp.descriptionMd?.length).toBeLessThan(500);
  });

  it('an AI extraction that runs but returns no usable description leaves the note, not raw text (issue #238)', async () => {
    const { app, a } = await boot();
    const id = await outreachOpportunity(app, a, 'Initech Labs', 'Staff Platform Engineer');
    vi.mocked(runStructured).mockResolvedValue({
      companyName: 'Initech Labs',
      title: 'Staff Platform Engineer',
      location: null,
      remote: null,
      compNote: null,
      descriptionMd: '',
      postingUrl: null,
    });
    const { fetch } = net({
      'https://initechlabs.com/': HOME,
      'https://initechlabs.com/careers': CAREERS,
      'https://initechlabs.com/job/staff-platform-engineer/': POSTING,
    });
    const outcome = await enrichOpportunity(app.db, ctxOf(a), fetch, id);
    expect(outcome).toEqual({
      outcome: 'no_match',
      careersUrl: 'https://initechlabs.com/careers',
    });
    const opp = await oppRow(app, id);
    expect(opp.descriptionMd).toBeNull();
    expect((await notesOf(app, id))[0]?.title).toBe('Posting found but not readable');
    expect((await notesOf(app, id))[0]?.bodyMd).toContain('could not be parsed');
  });

  it('a non-HTML response body is never stored verbatim as the description (issue #238)', async () => {
    const { app, a } = await boot();
    const id = await outreachOpportunity(app, a, 'Initech Labs', 'Staff Platform Engineer');
    const { fetch } = net({
      'https://initechlabs.com/': HOME,
      'https://initechlabs.com/careers': CAREERS,
      'https://initechlabs.com/job/staff-platform-engineer/': JSON.stringify({
        error: 'not_found',
        RESUME_ERROR: 'There was an error uploading your resume.',
      }),
    });
    const outcome = await enrichOpportunity(app.db, ctxOf(a), fetch, id);
    expect(outcome).toEqual({
      outcome: 'no_match',
      careersUrl: 'https://initechlabs.com/careers',
    });
    const opp = await oppRow(app, id);
    expect(opp.descriptionMd).toBeNull();
    expect((await notesOf(app, id))[0]?.title).toBe('Posting found but not readable');
  });

  it('rejects a candidate domain whose homepage never names the company', async () => {
    const { app, a } = await boot();
    const id = await outreachOpportunity(app, a, 'Initech Labs', 'Staff Platform Engineer');
    const { fetch } = net({
      'https://initechlabs.com/': '<html><body>Parked domain for sale</body></html>',
    });
    const outcome = await enrichOpportunity(app.db, ctxOf(a), fetch, id);
    expect(outcome).toEqual({ outcome: 'no_careers_page' });
    expect((await oppRow(app, id)).descriptionMd).toBeNull();
    expect((await notesOf(app, id))[0]?.title).toBe('Posting details not found automatically');
    expect((await notesOf(app, id))[0]?.bodyMd).toContain('Capture posting');
  });

  it('walks a homepage careers link when no common path answers', async () => {
    const { app, a } = await boot();
    const id = await outreachOpportunity(app, a, 'Initech Labs', 'Staff Platform Engineer');
    const home = `<html><body>Initech Labs. <a href="/team/openings">Join the team</a></body></html>`;
    const { fetch } = net({
      'https://initechlabs.com/': home,
      'https://initechlabs.com/team/openings': CAREERS,
      'https://initechlabs.com/job/staff-platform-engineer/': POSTING,
    });
    const outcome = await enrichOpportunity(app.db, ctxOf(a), fetch, id);
    expect(outcome).toMatchObject({ outcome: 'enriched' });
  });

  it('reads sender-domain outreach and an ATS board linked from the careers page', async () => {
    const { app, a } = await boot();
    const id = await outreachOpportunity(app, a, 'Initech Labs', 'Staff Platform Engineer');
    await app.db
      .insert(communications)
      .values({
        id: newId(),
        userId: a.userId,
        channel: 'gmail',
        externalId: 'ext-enrich-1',
        from: '"Recruiter" <talent@initechhq.dev>',
        to: ['me@example.com'],
        sentAt: 1,
        opportunityId: id,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    const board = JSON.stringify({
      jobs: [
        {
          title: 'Staff Platform Engineer',
          absolute_url: 'https://boards.greenhouse.io/initech/jobs/123',
        },
      ],
    });
    const { fetch } = net({
      'https://initechhq.dev/': '<html><body>Initech Labs hiring</body></html>',
      'https://initechhq.dev/careers':
        '<html><body>Open positions: <a href="https://boards.greenhouse.io/initech">All jobs</a></body></html>',
      'https://boards-api.greenhouse.io/v1/boards/initech/jobs': board,
      'https://boards.greenhouse.io/initech/jobs/123': POSTING,
    });
    const outcome = await enrichOpportunity(app.db, ctxOf(a), fetch, id);
    expect(outcome).toEqual({
      outcome: 'enriched',
      postingUrl: 'https://boards.greenhouse.io/initech/jobs/123',
    });
  });

  it('a Workday job link on the careers page is read from the CXS detail, not its JS shell', async () => {
    const { app, a } = await boot();
    const id = await outreachOpportunity(
      app,
      a,
      'Initech Labs',
      'Principal Product Manager - AURL - Web Protection (CDSS)',
    );
    const link =
      'https://globexnetworks.wd5.myworkdayjobs.com/globexexternalcareers/job/Santa-Clara-CA/Principal-Product-Manager---AURL---Web-Protection--CDSS-_JR-000001';
    const detail =
      'https://globexnetworks.wd5.myworkdayjobs.com/wday/cxs/globexnetworks/globexexternalcareers/job/Santa-Clara-CA/Principal-Product-Manager---AURL---Web-Protection--CDSS-_JR-000001';
    const { fetch, requested } = net({
      'https://initechlabs.com/': HOME,
      'https://initechlabs.com/careers': `<html><body>Open positions: <a href="${link}/apply">Principal Product Manager - AURL - Web Protection (CDSS)</a></body></html>`,
      // The rendered Workday page is a JavaScript shell: only site chrome.
      [`${link}/apply`]: '<html><body><div id="root"></div>Skip to main content</body></html>',
      [detail]: JSON.stringify({
        jobPostingInfo: {
          title: 'Principal Product Manager - AURL - Web Protection (CDSS)',
          jobDescription: '<p>Own the <b>web protection</b> roadmap.</p>',
          jobReqId: 'JR-000001',
        },
      }),
    });
    const outcome = await enrichOpportunity(app.db, ctxOf(a), fetch, id);
    expect(outcome).toEqual({ outcome: 'enriched', postingUrl: `${link}/apply` });
    expect((await oppRow(app, id)).descriptionMd).toContain('Own the web protection roadmap.');
    expect(requested).toContain(detail);
    expect(requested).not.toContain(`${link}/apply`);
  });

  it('a protocol-relative Workday link from a board API degrades to the note, not a job failure', async () => {
    const { app, a } = await boot();
    const id = await outreachOpportunity(app, a, 'Initech Labs', 'Staff Platform Engineer');
    const board = JSON.stringify({
      jobs: [
        {
          title: 'Staff Platform Engineer',
          absolute_url:
            '//globexnetworks.wd5.myworkdayjobs.com/globexexternalcareers/job/Remote/Staff-Platform-Engineer_JR-1',
        },
      ],
    });
    const { fetch } = net({
      'https://initechlabs.com/': HOME,
      'https://initechlabs.com/careers':
        '<html><body>Open positions: <a href="https://boards.greenhouse.io/initech">All jobs</a></body></html>',
      'https://boards-api.greenhouse.io/v1/boards/initech/jobs': board,
    });
    const outcome = await enrichOpportunity(app.db, ctxOf(a), fetch, id);
    expect(outcome).toMatchObject({ outcome: 'no_match' });
    expect((await oppRow(app, id)).descriptionMd).toBeNull();
    expect((await notesOf(app, id))[0]?.title).toBe('Posting found but not readable');
  });

  it('a careers page without the posting still persists (issue #260): no_match concedes the role may be unlisted, not that the page is wrong', async () => {
    const { app, a } = await boot();
    const id = await outreachOpportunity(app, a, 'Initech Labs', 'Principal Product Manager');
    const { fetch } = net({
      'https://initechlabs.com/': HOME,
      'https://initechlabs.com/careers': CAREERS,
    });
    const outcome = await enrichOpportunity(app.db, ctxOf(a), fetch, id);
    expect(outcome).toEqual({
      outcome: 'no_match',
      careersUrl: 'https://initechlabs.com/careers',
    });
    const opp = await oppRow(app, id);
    expect(opp.descriptionMd).toBeNull();
    expect((await notesOf(app, id))[0]?.bodyMd).toContain('Capture posting');
    // Issue #260: persisting the guess no longer waits on a posting match. detectAts() is the
    // real gate -- it makes a live round-trip to the actual ATS vendor and only ever records a
    // hit when real postings come back, so a wrong guess just lands on ats_kind 'none', the
    // same outcome a genuinely board-less company already gets. 86 of 132 enrich runs found a
    // careers page and only 7 were ever kept before this; this is why.
    const company = (await app.db
      .select()
      .from(companies)
      .where(eq(companies.id, opp.companyId))
      .get())!;
    expect(company.careersUrl).toBe('https://initechlabs.com/careers');
    expect(
      await app.db.select().from(jobs).where(eq(jobs.kind, ATS_DETECT_KIND)).all(),
    ).toHaveLength(1);
  });

  it('extracted pay below the compensation floor flags the source message for review', async () => {
    const { app, a } = await boot();
    const id = await outreachOpportunity(app, a, 'Initech Labs', 'Staff Platform Engineer');
    const commId = newId();
    await app.db
      .insert(communications)
      .values({
        id: commId,
        userId: a.userId,
        channel: 'gmail',
        externalId: 'ext-enrich-2',
        from: '"R" <r@example.org>',
        to: [],
        sentAt: 1,
        opportunityId: id,
        needsReview: false,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    await app.db
      .insert(roleTargets)
      .values({
        id: newId(),
        userId: a.userId,
        name: 'Staff+',
        titleFamily: 'Engineer',
        compMin: 210_000,
        currency: 'USD',
        active: true,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    vi.mocked(runStructured).mockResolvedValue({
      companyName: 'Initech Labs',
      title: 'Staff Platform Engineer',
      location: 'Springfield, VT',
      remote: 'onsite',
      compNote: '$150,000 annually',
      descriptionMd: 'Full posting text.',
      postingUrl: null,
    });
    const { fetch } = net({
      'https://initechlabs.com/': HOME,
      'https://initechlabs.com/careers': CAREERS,
      'https://initechlabs.com/job/staff-platform-engineer/': POSTING,
    });
    const outcome = await enrichOpportunity(app.db, ctxOf(a), fetch, id);
    expect(outcome).toMatchObject({ outcome: 'enriched' });
    const opp = await oppRow(app, id);
    expect(opp.compNote).toBe('$150,000 annually');
    expect(opp.remote).toBe(false);
    expect((await notesOf(app, id)).map((n) => n.title)).toContain(
      'Stated pay is below your compensation floor',
    );
    const comm = (await app.db
      .select()
      .from(communications)
      .where(eq(communications.id, commId))
      .get())!;
    expect(comm.needsReview).toBe(true);
  });

  it('skips an opportunity that already has a description, touching nothing', async () => {
    const { app, a } = await boot();
    const id = await outreachOpportunity(app, a, 'Initech Labs', 'Staff Platform Engineer');
    await app.db
      .update(opportunities)
      .set({ descriptionMd: 'already here' })
      .where(eq(opportunities.id, id))
      .run();
    const { fetch, requested } = net({});
    const outcome = await enrichOpportunity(app.db, ctxOf(a), fetch, id);
    expect(outcome).toEqual({ outcome: 'skipped', reason: 'already_detailed' });
    expect(requested).toEqual([]);
    expect(await notesOf(app, id)).toEqual([]);
  });
});

describe('queueing', () => {
  it('is registered and dedupes per opportunity', async () => {
    const { app, a } = await boot();
    const id = await outreachOpportunity(app, a, 'Initech Labs', 'Staff Platform Engineer');
    const { enqueueEnrich } = await import('../src/jobs/opportunityEnrich');
    await enqueueEnrich(app.db, a.userId, id);
    await enqueueEnrich(app.db, a.userId, id);
    const rows = await app.db
      .select()
      .from(jobs)
      .where(eq(jobs.kind, OPPORTUNITY_ENRICH_KIND))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({ opportunityId: id });
  });
});
