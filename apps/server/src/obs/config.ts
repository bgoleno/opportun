// The observability switches (design.md 14.1; https://github.com/bgoleno/opportun/issues/353).
//
// Collect: instance-wide, admin-only, OFF unless an admin turns it on (the owner's spec on #353:
// "By default this feature should be disabled"). It is stored as one instance setting, and a
// missing row reads as off, so an instance that never touched it collects nothing.
//
// Export (FR-T2) lives in obs/export/; this file holds the one rule that ties the two switches:
// export can be on only while collection is. Turning Collect off turns Export off, stored as well
// as in this process, so turning Collect on again does not resume sending by itself; and boot
// applies Export after Collect (obs/index.ts refuses an exporter while collection is off).
import { eq } from 'drizzle-orm';
import type { Db, Exec } from '../db/client';
import { settings } from '../db/schema';
import { audit } from '../lib/audit';
import { applyExport, stopExport, type ExportDeployment } from './export/manager';
import { disableExport, readExport } from './export/settings';
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
  if (!on && (await readExport(db)).enabled) {
    await disableExport(db);
    await audit(db, 'telemetry.export.updated', {
      ...actor,
      detail: { enabled: false, cause: 'collect_off' },
    });
  }
  await setCollecting(on);
  if (!on) await stopExport();
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

/**
 * Binds observability to the app's database and applies the switches in effect (app.ts, at
 * boot): Collect first, then Export, which can be on only while Collect is.
 */
export async function startObsFromSettings(
  db: Db,
  log: ObsLogger,
  deployment: Pick<ExportDeployment, 'demo'> & Partial<ExportDeployment>,
): Promise<void> {
  await startObs(db, { log, collect: await collectInEffect(db, deployment) });
  // Without the operator's flag, private destinations stay refused.
  await applyExport(db, {
    demo: deployment.demo,
    telemetryAllowPrivate: deployment.telemetryAllowPrivate ?? false,
  });
}
