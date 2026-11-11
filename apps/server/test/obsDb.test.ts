// The database boundary (design.md 14.2, 14.4, 14.6, 14.11; https://github.com/bgoleno/opportun/issues/343):
// a metric and no span, db.client.operation.duration by the statement's verb and table, at the
// execution choke points in db/client.ts. Never the SQL text. The store's own writes are not
// measured (telemetry about telemetry is suppressed).
import { newId } from '@opportun/core';
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { rawAll } from '../src/db/client';
import { companies, obsMetricPoints } from '../src/db/schema';
import { flushNow, setCollecting } from '../src/obs';
import { statementShape } from '../src/obs/database';
import { MINUTE_MS } from '../src/obs/metrics';
import { useApi } from './api';
import { testDialect } from './db';
import { useInMemoryTracing } from './otelProvider';

const boot = useApi();
const exporter = useInMemoryTracing();
type App = Awaited<ReturnType<typeof boot>>['app'];

const SYSTEM = testDialect === 'postgres' ? 'postgresql' : 'sqlite';

afterEach(async () => {
  await setCollecting(false);
});

async function dbPoints(app: App) {
  await flushNow();
  return (
    await app.db
      .select()
      .from(obsMetricPoints)
      .where(eq(obsMetricPoints.metric, 'db.client.operation.duration'))
      .all()
  ).filter((p) => p.resolution === MINUTE_MS);
}

describe('statementShape (#343)', () => {
  it("reads a statement's verb and its first table, and nothing else", () => {
    expect(statementShape('select "id" from "companies" where "user_id" = ?')).toEqual({
      operation: 'SELECT',
      table: 'companies',
    });
    expect(
      statementShape('insert into `jobs` (`id`) values (?) on conflict do update set x = 1'),
    ).toEqual({
      operation: 'INSERT',
      table: 'jobs',
    });
    expect(statementShape('UPDATE opportunities SET stage = $1')).toEqual({
      operation: 'UPDATE',
      table: 'opportunities',
    });
    expect(statementShape('  delete from "sessions" where 1')).toEqual({
      operation: 'DELETE',
      table: 'sessions',
    });
    expect(statementShape('SELECT 1')).toEqual({ operation: 'SELECT' });
    expect(statementShape('PRAGMA foreign_keys')).toEqual({ operation: 'PRAGMA' });
    // Not a schema table (a CTE's name, a typo): _OTHER. Not a known verb: _OTHER.
    expect(statementShape('WITH t AS (SELECT 1) SELECT * FROM t')).toEqual({
      operation: 'WITH',
      table: '_OTHER',
    });
    expect(statementShape('VACUUM')).toEqual({ operation: '_OTHER' });
    expect(statementShape("SELECT * FROM users WHERE email = 'jane.doe@example.com'")).toEqual({
      operation: 'SELECT',
      table: 'users',
    });
  });
});

describe('the database metric (#343)', () => {
  it('records builder statements by verb and table, as a metric with no span', async () => {
    const { app, a } = await boot();
    await setCollecting(true);
    await app.db
      .insert(companies)
      .values({ id: newId(), userId: a.userId, name: 'Acme Corp', createdAt: 1, updatedAt: 1 })
      .run();
    await app.db.select().from(companies).where(eq(companies.userId, a.userId)).all();
    const points = await dbPoints(app);
    const shapes = points.map((p) => p.attributes);
    expect(shapes).toEqual(
      expect.arrayContaining([
        {
          'db.system.name': SYSTEM,
          'db.operation.name': 'INSERT',
          'db.collection.name': 'companies',
        },
        {
          'db.system.name': SYSTEM,
          'db.operation.name': 'SELECT',
          'db.collection.name': 'companies',
        },
      ]),
    );
    const text = JSON.stringify(points);
    expect(text).not.toContain('Acme');
    expect(text).not.toMatch(/where|values|select \*/i);
    expect(exporter.getFinishedSpans().filter((s) => s.name.includes('companies'))).toEqual([]);
  });

  it('records raw SQL too', async () => {
    const { app } = await boot();
    await setCollecting(true);
    await rawAll(app.db, sql`SELECT count(*) AS n FROM opportunities`);
    const points = await dbPoints(app);
    expect(points.map((p) => p.attributes)).toEqual(
      expect.arrayContaining([
        {
          'db.system.name': SYSTEM,
          'db.operation.name': 'SELECT',
          'db.collection.name': 'opportunities',
        },
      ]),
    );
  });

  it("gives a failed statement the driver's code as error.type, never its message", async () => {
    const { app, a } = await boot();
    await setCollecting(true);
    const id = newId();
    const row = { id, userId: a.userId, name: 'Acme Corp', createdAt: 1, updatedAt: 1 };
    await app.db.insert(companies).values(row).run();
    await expect(app.db.insert(companies).values(row).run()).rejects.toThrow();
    const failed = (await dbPoints(app)).filter((p) => 'error.type' in p.attributes);
    expect(failed).toHaveLength(1);
    expect(String(failed[0]?.attributes['error.type'])).toMatch(/^(SQLITE_CONSTRAINT|23505$)/);
    expect(JSON.stringify(failed)).not.toContain(id);
  });

  it("does not measure the store's own writes", async () => {
    const { app } = await boot();
    await setCollecting(true);
    await rawAll(app.db, sql`SELECT 1`);
    await flushNow();
    await rawAll(app.db, sql`SELECT 1`);
    const points = await dbPoints(app);
    expect(points.some((p) => p.attributes['db.collection.name'] === 'obs_metric_points')).toBe(
      false,
    );
  });

  it('with collection off: nothing is recorded', async () => {
    const { app, a } = await boot();
    await app.db.select().from(companies).where(eq(companies.userId, a.userId)).all();
    await rawAll(app.db, sql`SELECT 1`);
    expect(await dbPoints(app)).toEqual([]);
  });
});
