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
import { GREENHOUSE_HOST } from '../adapters/sources/greenhouse';
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

/** Greenhouse board slugs the fake discovery fetch reports as existing boards. */
export const FIXTURE_BOARDS: ReadonlyMap<string, string> = new Map([
  ['piedpiper', 'Pied Piper'],
  // slugCandidates('Vandelay Industries') probes this first, so board detection for the fixture
  // company hits and the find-posting flow reaches the fixture postings.
  ['vandelayindustries', FIXTURE_COMPANY],
]);

const json = (status: number, body: unknown, url: string) => ({
  status,
  headers: new Headers({ 'content-type': 'application/json' }),
  body: Buffer.from(JSON.stringify(body)),
  url,
});

/** The discovery fetch: a Greenhouse board probe for a fixture slug hits, everything else 404s. */
export const mockSourceFetch: typeof safeFetch = async (url) => {
  const u = new URL(url);
  // Detection probes the jobs list, since a board verifies only while it serves a posting.
  const m = /^\/v1\/boards\/([a-z0-9-]+)\/jobs$/.exec(u.pathname);
  const board = m?.[1] === undefined ? undefined : FIXTURE_BOARDS.get(m[1]);
  if (u.hostname === GREENHOUSE_HOST && board !== undefined) {
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
}
