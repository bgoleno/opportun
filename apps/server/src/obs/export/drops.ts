// The drop counts an admin sees on the export card (design.md 14.10;
// https://github.com/bgoleno/opportun/issues/342): opportun.obs.dropped from the local store, the
// instance's own points at the hourly resolution over the last 24 hours, summed by signal and
// reason. Read from the store, not kept in memory, so they survive a restart and cover what the
// gate, the buffers and the export side all dropped.
import { and, eq, gte, isNull } from 'drizzle-orm';
import type { Exec } from '../../db/client';
import { obsMetricPoints } from '../../db/schema';
import { HOUR_MS } from '../metrics';

export interface DropCount {
  signal: string;
  reason: string;
  count: number;
}

const WINDOW_MS = 24 * HOUR_MS;

export async function readDropCounts(db: Pick<Exec, 'select'>, now: number): Promise<DropCount[]> {
  const rows = await db
    .select({ attributes: obsMetricPoints.attributes, sum: obsMetricPoints.sum })
    .from(obsMetricPoints)
    .where(
      and(
        eq(obsMetricPoints.metric, 'opportun.obs.dropped'),
        eq(obsMetricPoints.resolution, HOUR_MS),
        isNull(obsMetricPoints.userId),
        gte(obsMetricPoints.bucketStart, now - WINDOW_MS),
      ),
    )
    .all();
  const totals = new Map<string, DropCount>();
  for (const row of rows) {
    const signal = String(row.attributes['opportun.obs.signal'] ?? '');
    const reason = String(row.attributes['opportun.obs.reason'] ?? '');
    const key = `${signal}\n${reason}`;
    const known = totals.get(key);
    if (known === undefined) totals.set(key, { signal, reason, count: row.sum });
    else known.count += row.sum;
  }
  return [...totals.values()].sort(
    (x, y) => x.signal.localeCompare(y.signal) || x.reason.localeCompare(y.reason),
  );
}
