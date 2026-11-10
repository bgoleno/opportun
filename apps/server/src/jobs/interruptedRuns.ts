// Runs a server stop cut short (https://github.com/bgoleno/opportun/issues/323). A discovery run
// writes its row in Run history when it starts and finishes it when it ends, with its stats or its
// error. A process killed in between leaves the row with no finish for good: Run history read
// "Running" long after, though the source was not stuck (its job went back to pending, and the next
// run created a row of its own). When a runner starts, a run row still unfinished was left by the
// process that died, so it is ended here, as interrupted. Only a run no job is working on: one a
// running discovery.run job of its source is going now (at startup there is none, the
// orphaned jobs having just been put back to pending; the test is what keeps this safe to call at
// any other time).
import { and, eq, isNull, notExists, sql } from 'drizzle-orm';
import { runCount, type Db } from '../db/client';
import { jsonText } from '../db/dialect';
import { discoveryRuns, jobs } from '../db/schema';
import { DISCOVERY_RUN_KIND } from './discoveryKinds';

/** The `interrupted` stat on a run a server stop cut short; Run history reads it as ended. */
export const INTERRUPTED = 'server_restart';
const INTERRUPTED_TEXT = 'Interrupted: the server stopped before this run finished.';

/** Ends every run row left unfinished by a process that died. Returns how many. */
export async function finishInterruptedRuns(db: Db): Promise<number> {
  return await runCount(
    db
      .update(discoveryRuns)
      .set({
        finishedAt: Date.now(),
        stats: { interrupted: INTERRUPTED },
        error: INTERRUPTED_TEXT,
      })
      .where(
        and(
          isNull(discoveryRuns.finishedAt),
          notExists(
            db
              .select({ one: sql`1` })
              .from(jobs)
              .where(
                and(
                  eq(jobs.kind, DISCOVERY_RUN_KIND),
                  eq(jobs.status, 'running'),
                  eq(jsonText(jobs.payload, 'sourceId'), discoveryRuns.sourceId),
                ),
              ),
          ),
        ),
      ),
  );
}
