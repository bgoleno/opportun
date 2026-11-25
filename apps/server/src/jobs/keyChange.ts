// What a change of the user's AI key ends, for every task that stops at a refused one.
import type { Db } from '../db/client';
import type { UserCtx } from '../repos/base';
import { resumeClassifyAfterKeyChange } from './classifyWaiting';
import { resumeAfterKeyChange } from './discoveryRankWaiting';

/**
 * Ends mail's stop and ranking's (a key added, removed or found good). Both are tried: the change has
 * happened, so an error in one must not leave the other stopped until the next change (sec on #1058).
 * The error goes through.
 */
export async function resumeAllAfterKeyChange(db: Db, ctx: UserCtx): Promise<void> {
  try {
    await resumeClassifyAfterKeyChange(db, ctx);
  } finally {
    await resumeAfterKeyChange(db, ctx);
  }
}
