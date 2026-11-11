// The database statement's shape and its prepared records (https://github.com/bgoleno/opportun/issues/371,
// tl's points on https://github.com/bgoleno/opportun/pull/368):
// - `extract(... from col)` and `substring(... from ...)` carry a FROM that is not a table, which
//   FIRST_TABLE read as one (the wrong table, or _OTHER; never a leak, the table must be in the
//   schema to be named);
// - the prepared records are a map per system, so one text on two systems is two series.
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { obsMetricPoints } from '../src/db/schema';
import { flushNow, setCollecting } from '../src/obs';
import { observeStatement, statementShape } from '../src/obs/database';
import { MINUTE_MS } from '../src/obs/metrics';
import { useApi } from './api';

const boot = useApi();
afterEach(async () => {
  await setCollecting(false);
});

describe('statementShape: a FROM inside extract() or substring() is not a table (#371)', () => {
  it.each([
    ['select extract(epoch from "created_at") as "t" from "jobs"', 'jobs'],
    ['SELECT EXTRACT(YEAR FROM "applied_at"), "id" FROM "opportunities" WHERE 1', 'opportunities'],
    ['select substring("name" from 1 for 3) from "companies"', 'companies'],
    ['select substring("name" from 2) as s, extract(day from "x") from "companies"', 'companies'],
  ])('%s reads its table as %s', (text, table) => {
    expect(statementShape(text)).toEqual({ operation: 'SELECT', table });
  });

  it('a statement whose only FROM is inside one has no table', () => {
    expect(statementShape('select extract(epoch from now()) as "n"')).toEqual({
      operation: 'SELECT',
    });
    expect(statementShape("select substring('abc' from 2)")).toEqual({ operation: 'SELECT' });
  });

  it('an ordinary statement is read as before', () => {
    expect(statementShape('select "id" from "companies" where "user_id" = ?')).toEqual({
      operation: 'SELECT',
      table: 'companies',
    });
    expect(statementShape('insert into "jobs" ("id") values (?)')).toEqual({
      operation: 'INSERT',
      table: 'jobs',
    });
  });
});

describe('the prepared records are kept per system (#371)', () => {
  it('one text on two systems is two series, each with its own db.system.name', async () => {
    const { app } = await boot();
    await setCollecting(true);
    const text = 'select "id" from "companies" where "id" = ?';
    observeStatement('sqlite', text, () => 0);
    observeStatement('postgresql', text, () => 0);
    observeStatement('sqlite', text, () => 0);
    await flushNow();
    const rows = (
      await app.db
        .select()
        .from(obsMetricPoints)
        .where(eq(obsMetricPoints.metric, 'db.client.operation.duration'))
        .all()
    )
      .filter(
        (p) => p.resolution === MINUTE_MS && p.attributes['db.collection.name'] === 'companies',
      )
      .map((p) => ({ system: p.attributes['db.system.name'], count: p.count }));
    // Other statements of the app's own (sessions, settings) may be there too: only companies'.
    expect(rows.filter((r) => r.system === 'postgresql')).toEqual([
      { system: 'postgresql', count: 1 },
    ]);
    expect(rows.find((r) => r.system === 'sqlite')?.count).toBeGreaterThanOrEqual(2);
  });
});
