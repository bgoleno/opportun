// The posting-link check job (https://github.com/bgoleno/opportun/issues/788): defined in jobs/,
// beside the other handlers; the check it runs, and its kind and dedupe key, stay in
// lib/greenhouseEmbed.ts, which the routes and repos that queue it import.
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { opportunities } from '../db/schema';
import { requireService, type JobHandler } from './registry';
import type { UserCtx } from '../repos/base';
import {
  checkEmbeddedGreenhouse,
  POSTING_CHECK_KIND,
  setCheckedPostingRef,
} from '../lib/greenhouseEmbed';

const PostingCheckPayload = z.object({
  opportunityId: z.string().min(1).max(64),
  link: z.string().min(1).max(4096),
});

export const postingCheckJob: JobHandler<z.infer<typeof PostingCheckPayload>> = {
  kind: POSTING_CHECK_KIND,
  payloadSchema: PostingCheckPayload,
  maxAttempts: 3,
  async run(db, payload, jctx) {
    if (jctx.userId === null) throw new Error(`${POSTING_CHECK_KIND} needs a user`);
    const ctx: UserCtx = { userId: jctx.userId, isAdmin: false };
    const opp = await db
      .select({
        id: opportunities.id,
        companyId: opportunities.companyId,
        postingUrl: opportunities.postingUrl,
        atsJobRef: opportunities.atsJobRef,
      })
      .from(opportunities)
      .where(and(eq(opportunities.userId, ctx.userId), eq(opportunities.id, payload.opportunityId)))
      .get();
    // Gone, changed since, or already given an identity: nothing left to check.
    if (opp === undefined || opp.postingUrl !== payload.link || opp.atsJobRef !== null) {
      await jctx.setResult({ outcome: 'unchanged' });
      return;
    }
    const found = await checkEmbeddedGreenhouse(
      db,
      ctx,
      opp,
      payload.link,
      { fetch: requireService(jctx, 'sourceFetch'), log: requireService(jctx, 'log') },
      Date.now(),
      null,
    );
    if (found.ref !== null) {
      const set = await setCheckedPostingRef(db, ctx, opp.id, payload.link, found.ref);
      await jctx.setResult({ outcome: set ? 'identity' : 'unchanged' });
      return;
    }
    // A board still gave no answer: the runner retries with backoff, up to maxAttempts.
    if (found.undecided) throw new Error('a known board gave no answer');
    await jctx.setResult({ outcome: 'none' });
  },
};
