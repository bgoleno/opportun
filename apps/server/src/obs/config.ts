// The observability switches (design.md 14.1; https://github.com/bgoleno/opportun/issues/353).
//
// Collect: instance-wide, admin-only, OFF unless an admin turns it on (the owner's spec on #353:
// "By default this feature should be disabled"). It is stored as one instance setting, and a
// missing row reads as off, so an instance that never touched it collects nothing.
//
// Export is FR-T2's: its switch, destination and credential join this file there. It can be
// on only while collection is (obs/index.ts refuses an exporter while collection is off).
import { eq } from 'drizzle-orm';
import type { Db, Exec } from '../db/client';
import { settings } from '../db/schema';
import { audit } from '../lib/audit';
import { type ObsLogger, setCollecting, startObs } from './index';

export const OBS_COLLECT_KEY = 'obs_collect';

/** The stored Collect switch: true only when an admin turned it on. */
export async function readCollect(db: Pick<Exec, 'select'>): Promise<boolean> {
  const row = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, OBS_COLLECT_KEY))
    .get();
  return row?.value === true;
}

/**
 * Stores the Collect switch, audits the change (who and the new state, nothing else) and applies
 * it to this process at once: no restart. The caller checks that the actor is an admin.
 */
export async function writeCollect(
  db: Db,
  on: boolean,
  actor: { userId?: string; ip?: string } = {},
): Promise<void> {
  const now = Date.now();
  await db
    .insert(settings)
    .values({ key: OBS_COLLECT_KEY, userId: null, value: on, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: on, updatedAt: now } })
    .run();
  // Audited with the acting admin (sec's O6 on PR #352). No password re-confirmation, unlike
  // export: nothing leaves the instance.
  await audit(db, 'telemetry.collect.updated', { ...actor, detail: { enabled: on } });
  await setCollecting(on);
}

/** Binds observability to the app's database and applies the stored switch (app.ts, at boot). */
export async function startObsFromSettings(db: Db, log: ObsLogger): Promise<void> {
  await startObs(db, { log, collect: await readCollect(db) });
}
