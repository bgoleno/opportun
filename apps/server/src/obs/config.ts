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

/**
 * Whether collection is on in this deployment: never on the demo, else the stored switch. The
 * one rule both boot and the GET use, so they cannot disagree (#360). On the demo the stored row
 * is ignored, not cleared: an operator can turn the demo flag on over a database that had
 * Collect on, the demo's PUT refuses every change and its nightly reset keeps the row (it
 * belongs to no user), so only this rule keeps collection off there. Left alone, the row means
 * what it said again if the demo flag is ever removed.
 */
export async function collectInEffect(
  db: Pick<Exec, 'select'>,
  deployment: { demo: boolean },
): Promise<boolean> {
  return collectAvailable(deployment) && (await readCollect(db));
}

/**
 * Whether collection can be turned on in this deployment at all: not on the demo, where the
 * admin account is public (#360). The dashboards say "unavailable" rather than "off" when it is
 * false, as no admin can turn it on there (https://github.com/bgoleno/opportun/issues/364).
 */
export function collectAvailable(deployment: { demo: boolean }): boolean {
  return !deployment.demo;
}

/** Binds observability to the app's database and applies the switch in effect (app.ts, at boot). */
export async function startObsFromSettings(
  db: Db,
  log: ObsLogger,
  deployment: { demo: boolean },
): Promise<void> {
  await startObs(db, { log, collect: await collectInEffect(db, deployment) });
}
