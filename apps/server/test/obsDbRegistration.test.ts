// The booted app observes its database statements (https://github.com/bgoleno/opportun/issues/803).
// db/client imports nothing from obs/: it takes its statement observer as a handover that
// obs/database fills when it loads, and obs/config, which every boot starts observability through,
// imports obs/database. This file goes through the app alone and imports neither, so a boot path
// that stopped loading obs/database fails here instead of going quiet (the slot's default is a
// plain passthrough that records nothing).
import { newId } from '@opportun/core';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { companies, obsMetricPoints } from '../src/db/schema';
import { flushNow, setCollecting } from '../src/obs';
import { useApi } from './api';
import { testDialect } from './db';
import { useInMemoryTracing } from './otelProvider';

const boot = useApi();
const exporter = useInMemoryTracing();

afterEach(async () => {
  await setCollecting(false);
});

describe('the booted app observes its database (#803)', () => {
  it('records a statement as the database metric, and still as no span', async () => {
    const { app, a } = await boot();
    await setCollecting(true);
    await app.db
      .insert(companies)
      .values({ id: newId(), userId: a.userId, name: 'Acme Corp', createdAt: 1, updatedAt: 1 })
      .run();
    await flushNow();
    const points = await app.db
      .select()
      .from(obsMetricPoints)
      .where(eq(obsMetricPoints.metric, 'db.client.operation.duration'))
      .all();
    expect(points.map((p) => p.attributes)).toContainEqual({
      'db.system.name': testDialect === 'postgres' ? 'postgresql' : 'sqlite',
      'db.operation.name': 'INSERT',
      'db.collection.name': 'companies',
    });
    // A statement is a metric only (14.2), before and after the handover.
    expect(exporter.getFinishedSpans().filter((s) => s.name.includes('companies'))).toEqual([]);
  });
});
