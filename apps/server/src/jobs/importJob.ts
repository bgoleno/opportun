// The import job (https://github.com/bgoleno/opportun/issues/788): defined in jobs/, beside the
// other handlers; the import it runs, and its kind and pack schema, stay in lib/importer.ts.
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { jobs } from '../db/schema';
import type { JobHandler } from './registry';
import type { UserCtx } from '../repos/base';
import {
  IMPORT_JOB_KIND,
  purgedPayload,
  runImport,
  StoredImportPackSchema,
  type ImportPack,
  type ImportResult,
} from '../lib/importer';

export const importJob: JobHandler<{ pack: ImportPack }> = {
  kind: IMPORT_JOB_KIND,
  payloadSchema: z.object({ pack: StoredImportPackSchema }),
  maxAttempts: 3,
  async run(db, { pack }, ctx) {
    try {
      if (ctx.userId === null) throw new Error('import job has no user');
      const user: UserCtx = { userId: ctx.userId, isAdmin: false };
      const { progress, report } = await runImport(db, user, pack, {
        documentStore: ctx.services.documentStore,
        reactiveResumeStore: ctx.services.reactiveResumeStore,
        onProgress: async (p, r) =>
          await ctx.setResult({
            progress: { ...p },
            report: { ...r, errors: [...r.errors] },
          } satisfies ImportResult),
      });
      // Issue #2: this used to be two writes (the final result, then the purge, once
      // runImport had already returned), so a crash in between left the pack behind for a
      // (harmless, since imports are idempotent) retry to clean up. One write instead: the
      // report that says the import is finished and the purge that says the pack is gone now
      // commit together, so there is nothing left to observe in between.
      await db
        .update(jobs)
        .set({
          result: {
            progress: { ...progress },
            report: { ...report, errors: [...report.errors] },
          } satisfies ImportResult,
          payload: purgedPayload(pack),
          updatedAt: Date.now(),
        })
        .where(eq(jobs.id, ctx.jobId))
        .run();
    } catch (err) {
      // Issue #2: a failed attempt still needs the pack for its retry, but the attempt about
      // to exhaust the budget (the runner is about to mark this job dead) does not get one, so
      // purge here or the pack sits in the row, and in every nightly backup, forever.
      if (ctx.attempt >= ctx.maxAttempts) {
        try {
          await db
            .update(jobs)
            .set({ payload: purgedPayload(pack), updatedAt: Date.now() })
            .where(eq(jobs.id, ctx.jobId))
            .run();
        } catch {
          // The database is the likeliest reason the import itself failed; that original
          // error is more useful than this one, so it is what gets thrown below.
        }
      }
      throw err;
    }
  },
};
