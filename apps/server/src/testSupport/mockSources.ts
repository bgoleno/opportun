// End-to-end discovery mock (OPPORTUN_SOURCE_MOCK=1). Three pieces, none of which touches the
// network:
//   - an override for the ats_greenhouse adapter that yields fixed fixture postings for any board
//     slug (the engine still sanitizes, dedupes, stores and queues ranking as usual);
//   - a stand-in for the discovery fetch (sourceFetch) that answers ATS board probes for the
//     fixture board slugs and 404s everything else, so board detection is deterministic;
//   - a loopback-only route that runs the company.suggest task for one user now (the real job
//     runs weekly; the AI mock supplies the suggestion).
// Never enabled in production (see testSupport/index.ts).
import type { NormalizedPosting } from '@opportun/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DiscoverySource } from '../adapters/discoverySource';
import { GREENHOUSE_API_HOST as GREENHOUSE_HOST } from '@opportun/core';
import { users } from '../db/schema';
import { suggestCompanies } from '../jobs/companySuggest';
import type { safeFetch } from '../lib/safeFetch';

export const MOCK_SOURCE_PATH = '/__mock/discovery';

/** The company every fixture posting is from. */
export const FIXTURE_COMPANY = 'Vandelay Industries';

/** Fixture postings, in board order. The AI mock scores them by title (mockAi.ts). */
export const FIXTURE_POSTINGS: readonly NormalizedPosting[] = [
  {
    company: FIXTURE_COMPANY,
    title: 'Office Coordinator',
    descriptionMd: 'Keep the office running: supplies, visitors and travel.',
    postingUrl: 'https://boards.greenhouse.io/vandelay/jobs/1001',
    location: 'New York, NY',
    remote: false,
    compNote: null,
    externalId: '1001',
    postedAt: Date.UTC(2026, 9, 1),
  },
  {
    company: FIXTURE_COMPANY,
    title: 'Staff Platform Engineer',
    descriptionMd: 'Lead our Go platform on Kubernetes. Terraform and on-call leadership a plus.',
    postingUrl: 'https://boards.greenhouse.io/vandelay/jobs/1002',
    location: 'Remote (US)',
    remote: true,
    compNote: '$220k to $260k',
    externalId: '1002',
    postedAt: Date.UTC(2026, 9, 2),
  },
  {
    company: FIXTURE_COMPANY,
    title: 'Senior Backend Engineer',
    descriptionMd: 'Build import and export services in TypeScript and Postgres.',
    postingUrl: 'https://boards.greenhouse.io/vandelay/jobs/1003',
    location: 'Remote (US)',
    remote: true,
    compNote: null,
    externalId: '1003',
    postedAt: Date.UTC(2026, 9, 3),
  },
];

/** The ats_greenhouse override: the fixture postings whatever the configured slug. */
export const mockGreenhouseSource: DiscoverySource = {
  kind: 'ats_greenhouse',
  async *fetchPostings() {
    for (const posting of FIXTURE_POSTINGS) yield { posting: { ...posting }, nextCursor: null };
  },
};

/** A company whose fixture board answers its probe slowly (see FIXTURE_BOARDS). */
export const SLOW_BOARD_COMPANY = 'QA Slow Board';
/** How long the slow board takes to answer its probe: past a 3 s poll, inside the 30 s fetch limit. */
export const SLOW_BOARD_MS = 5000;

/** Greenhouse board slugs the fake discovery fetch reports as existing boards. */
export const FIXTURE_BOARDS: ReadonlyMap<string, string> = new Map([
  ['piedpiper', 'Pied Piper'],
  // slugCandidates('Vandelay Industries') probes this first, so board detection for the fixture
  // company hits and the find-posting flow reaches the fixture postings.
  ['vandelayindustries', FIXTURE_COMPANY],
  // Answers its probe after SLOW_BOARD_MS (#809): a board check on it is still pending past one
  // of the companies screen's 3 s polls, so a spec can count on seeing the poll.
  ['qaslowboard', SLOW_BOARD_COMPANY],
]);

const json = (status: number, body: unknown, url: string) => ({
  status,
  headers: new Headers({ 'content-type': 'application/json' }),
  body: Buffer.from(JSON.stringify(body)),
  url,
});

/** The discovery fetch: a Greenhouse board probe for a fixture slug hits, everything else 404s. */
/**
 * Every single-job request (`/v1/boards/<token>/jobs/<id>`) the fake has answered, in order: a
 * posting-link save asks the company's known boards whether one holds a `gh_jid` job, and an e2e
 * reads this (GET MOCK_SOURCE_PATH/job-checks) to see that an unchanged link asked none
 * (apps/web/e2e/postingLink.spec.ts, issue #748).
 */
const jobChecks: string[] = [];

/** The fixture job ids, as in their posting URLs (boards.greenhouse.io/vandelay/jobs/1001). */
const FIXTURE_JOB_IDS: readonly string[] = FIXTURE_POSTINGS.map(
  (p) => /\/jobs\/(\d+)$/.exec(p.postingUrl ?? '')?.[1] ?? '',
);

export const mockSourceFetch: typeof safeFetch = async (url) => {
  const u = new URL(url);
  // A single job on a fixture board (or the fixture postings' own `vandelay` board): it holds the
  // fixture job ids, and nothing else.
  const job = /^\/v1\/boards\/([a-z0-9-]+)\/jobs\/(\d+)$/.exec(u.pathname);
  if (u.hostname === GREENHOUSE_HOST && job !== null) {
    const [, token = '', id = ''] = job;
    jobChecks.push(`${token}/${id}`);
    const known = FIXTURE_BOARDS.has(token) || token === 'vandelay';
    if (known && FIXTURE_JOB_IDS.includes(id)) {
      const posting = FIXTURE_POSTINGS[FIXTURE_JOB_IDS.indexOf(id)];
      return json(
        200,
        {
          id: Number(id),
          title: posting?.title ?? '',
          absolute_url: `https://boards.greenhouse.io/${token}/jobs/${id}`,
        },
        url,
      );
    }
    return json(404, { error: 'not found' }, url);
  }
  // Detection probes the jobs list, since a board verifies only while it serves a posting.
  const m = /^\/v1\/boards\/([a-z0-9-]+)\/jobs$/.exec(u.pathname);
  const board = m?.[1] === undefined ? undefined : FIXTURE_BOARDS.get(m[1]);
  if (u.hostname === GREENHOUSE_HOST && board !== undefined) {
    if (board === SLOW_BOARD_COMPANY) await new Promise((r) => setTimeout(r, SLOW_BOARD_MS));
    return json(
      200,
      { jobs: FIXTURE_POSTINGS.map((p, i) => ({ id: i + 1, title: p.title })) },
      url,
    );
  }
  return json(404, { error: 'not found' }, url);
};

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const SuggestBody = z.object({ email: z.string().min(1).max(320) });

/** Registers the mock-only discovery routes (outside /api, loopback callers only). */
export async function mockSourceRoutes(app: FastifyInstance): Promise<void> {
  app.post(`${MOCK_SOURCE_PATH}/suggest-companies`, async (req, reply) => {
    if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) {
      return reply.code(403).send({ error: { message: 'loopback only' } });
    }
    const { email } = SuggestBody.parse(req.body);
    const user = await app.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .get();
    if (user === undefined) return reply.code(404).send({ error: { message: 'no such user' } });
    return reply.send(await suggestCompanies(app.db, { userId: user.id, isAdmin: false }));
  });

  /** The single-job requests answered so far (see jobChecks). */
  app.get(`${MOCK_SOURCE_PATH}/job-checks`, async (req, reply) => {
    if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) {
      return reply.code(403).send({ error: { message: 'loopback only' } });
    }
    return reply.send({ checks: [...jobChecks] });
  });
}
