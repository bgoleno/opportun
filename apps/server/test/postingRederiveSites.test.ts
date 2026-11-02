// Re-deriving a description picks the extraction by the capture's site
// (https://github.com/bgoleno/opportun/issues/93). Re-derive used to read every stored capture
// with LinkedIn's extraction, so an Indeed-captured opportunity always answered
// `no_description_found`. The LinkedIn behaviour itself is specified by postingRederive.test.ts,
// which is unchanged; this file covers what the site choice adds. Every page here is synthetic,
// in the Indeed capture text contract's shape
// (https://github.com/bgoleno/opportun/issues/73#issuecomment-6568000179).
import { runStructured } from '@opportun/ai';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { recognizeIndeedPage } from '../src/lib/indeedCapture';
import { descriptionFingerprint } from '../src/lib/postingFingerprint';
import { rederivePosting } from '../src/lib/postingRederive';
import type { BoardLookup } from '../src/lib/postingSearch';
import type { safeFetch } from '../src/lib/safeFetch';
import { createActivity, listActivities } from '../src/repos/activities';
import type { UserCtx } from '../src/repos/base';
import {
  createOpportunity,
  getOpportunity,
  setPostingState,
  updateOpportunity,
} from '../src/repos/opportunities';
import { useApi } from './api';
import {
  INDEED_DESCRIPTION,
  INDEED_JOB,
  INDEED_JOB_NOT_LOADED,
  INDEED_JOB_URL,
  indeedText,
} from './fixtures/capture/indeedPages';
import type { TestClient } from './isolation';

vi.mock('@opportun/ai', async (orig) => ({
  ...(await orig<typeof import('@opportun/ai')>()),
  runStructured: vi.fn(),
}));

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });

/** A description re-derive may replace: system-written noise, as in postingRederive.test.ts. */
const NOISE = '{"json": "noise"}'.repeat(50);

/** Text LinkedIn's extraction reads a description from ("About the job" up to "About the company"). */
const LINKEDIN_SHAPED = [
  'About the job',
  'Lorem ipsum dolor sit amet, an example posting body.',
  'About the company',
  'Example Corp is a company.',
].join('\n');

const missingFetch = (async () => ({
  status: 404,
  headers: new Headers(),
  body: Buffer.from(''),
})) as unknown as typeof safeFetch;
const log = { warn: () => {}, info: () => {}, error: () => {} } as never;
/** No company board answers, so re-derive always falls back to the stored capture. */
const noBoards: BoardLookup = async () => [];

/** An opportunity with a replaceable description and one stored capture, as recordCapture writes it. */
async function seed(
  app: FastifyInstance,
  ctx: UserCtx,
  capture: { title: string; text: string; url: string },
) {
  const opp = await createOpportunity(app.db, ctx, {
    companyName: 'Example Corp',
    title: 'Senior Example Engineer',
    descriptionMd: NOISE,
    location: null,
    sourceKind: 'discovery',
  });
  await updateOpportunity(app.db, ctx, opp.id, {
    descriptionFingerprint: descriptionFingerprint(NOISE),
  });
  await createActivity(app.db, ctx, opp.id, {
    kind: 'capture',
    title: capture.title,
    bodyMd: capture.text,
    occurredAt: Date.now(),
    participants: [],
    externalUrl: capture.url,
  });
  await setPostingState(app.db, ctx, opp.id, {
    postingState: 'confirmed',
    postingStateDetail: null,
  });
  return await getOpportunity(app.db, ctx, opp.id);
}

const rederive = (app: FastifyInstance, ctx: UserCtx, id: string) =>
  rederivePosting(app.db, ctx, id, { fetch: missingFetch, log }, { board: noBoards });

const notes = async (app: FastifyInstance, ctx: UserCtx, id: string) =>
  (await listActivities(app.db, ctx, id, { limit: 50, offset: 0 })).items.filter(
    (a) => a.kind === 'note',
  );

describe('rederivePosting: Indeed captures', () => {
  it('produces the description the Indeed recognizer reads from the stored capture', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seed(app, ctx, {
      title: 'Captured from Indeed',
      text: INDEED_JOB.text,
      url: INDEED_JOB_URL,
    });
    const recognized = recognizeIndeedPage(INDEED_JOB);
    expect(recognized).toMatchObject({ kind: 'job', descriptionMd: INDEED_DESCRIPTION });

    const outcome = await rederive(app, ctx, opp.id);

    expect(outcome.kind).toBe('capture_only');
    const out = await getOpportunity(app.db, ctx, opp.id);
    expect(out.descriptionMd).toBe(INDEED_DESCRIPTION);
    expect(out.descriptionFingerprint).toBe(descriptionFingerprint(INDEED_DESCRIPTION));
    expect(runStructured).not.toHaveBeenCalled();
    expect((await notes(app, ctx, opp.id)).map((n) => n.title)).toEqual([
      'Description re-derived from capture',
    ]);
  });

  it("reads Indeed's description even when it contains LinkedIn's markers", async () => {
    // Everything after "Full job description" is the description, by the contract. LinkedIn's
    // extraction would start at "About the job" and stop at "About the company" instead.
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const description = ['Intro line before any marker.', LINKEDIN_SHAPED].join('\n');
    const opp = await seed(app, ctx, {
      title: 'Captured from Indeed',
      text: indeedText({
        title: 'Senior Example Engineer',
        company: 'Example Corp',
        description,
      }),
      url: INDEED_JOB_URL,
    });

    const outcome = await rederive(app, ctx, opp.id);

    expect(outcome.kind).toBe('capture_only');
    expect((await getOpportunity(app.db, ctx, opp.id)).descriptionMd).toBe(description);
  });

  it('reports nothing found, and changes nothing, for Indeed text with no description', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seed(app, ctx, {
      title: 'Captured from Indeed',
      text: INDEED_JOB_NOT_LOADED.text,
      url: INDEED_JOB_URL,
    });

    expect(await rederive(app, ctx, opp.id)).toEqual({ kind: 'no_description_found' });
    expect((await getOpportunity(app.db, ctx, opp.id)).descriptionMd).toBe(NOISE);
    expect(await notes(app, ctx, opp.id)).toEqual([]);
  });
});

describe('rederivePosting: the extraction is chosen by the capture site', () => {
  it('answers no_description_found for a site with no recognizer, even on LinkedIn-shaped text', async () => {
    // recordCapture titles a capture "Captured from <siteLabel(siteId)>", and siteLabel falls
    // back to the bare id for a site the registry does not know.
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seed(app, ctx, {
      title: 'Captured from wellfound',
      text: LINKEDIN_SHAPED,
      url: 'https://wellfound.com/jobs/1000000001',
    });

    expect(await rederive(app, ctx, opp.id)).toEqual({ kind: 'no_description_found' });
    const out = await getOpportunity(app.db, ctx, opp.id);
    expect(out.descriptionMd).toBe(NOISE);
    expect(out.descriptionFingerprint).toBe(descriptionFingerprint(NOISE));
    expect(await notes(app, ctx, opp.id)).toEqual([]);
  });

  it('reads a LinkedIn capture with LinkedIn extraction, as before', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seed(app, ctx, {
      title: 'Captured from LinkedIn',
      text: LINKEDIN_SHAPED,
      url: 'https://www.linkedin.com/jobs/view/1000000001',
    });

    expect((await rederive(app, ctx, opp.id)).kind).toBe('capture_only');
    expect((await getOpportunity(app.db, ctx, opp.id)).descriptionMd).toBe(
      'Lorem ipsum dolor sit amet, an example posting body.',
    );
  });

  it('does not read Indeed-shaped text as LinkedIn: a LinkedIn capture of it finds nothing', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seed(app, ctx, {
      title: 'Captured from LinkedIn',
      text: INDEED_JOB.text,
      url: 'https://www.linkedin.com/jobs/view/1000000001',
    });

    expect(await rederive(app, ctx, opp.id)).toEqual({ kind: 'no_description_found' });
    expect((await getOpportunity(app.db, ctx, opp.id)).descriptionMd).toBe(NOISE);
  });
});
