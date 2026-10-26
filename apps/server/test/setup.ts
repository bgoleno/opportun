// Every server test file: a transaction that awaited anything outside the database while
// holding the write gate fails the running test (no external I/O inside a transaction; see
// SlowTransaction in db/gate.ts). One that merely ran past the time budget is a warning:
// wall time alone also measures the OS descheduling a busy test process. On Postgres there
// is no gate: db/client.ts times the body instead (pgTransaction) and reports more than the
// budget spent outside the database as awaitedOutside.
import { afterEach, beforeEach } from 'vitest';
import { onSlowTransaction, type SlowTransaction } from '../src/db/gate';
import { databasesOfCurrentTest } from './pgHarness';

const slow: SlowTransaction[] = [];

beforeEach(({ onTestFailed }) => {
  slow.length = 0;
  // Postgres leg: name the databases a failing test used (kept with PG_KEEP_DATABASES=1;
  // server log lines carry the same name).
  databasesOfCurrentTest.length = 0;
  onTestFailed(() => {
    if (databasesOfCurrentTest.length > 0) {
      console.error(`postgres databases of the failed test: ${databasesOfCurrentTest.join(', ')}`);
    }
  });
  onSlowTransaction((s) => {
    if (s.awaitedOutside) slow.push(s);
    else console.warn(`slow transaction (${s.durationMs} ms), database work only:\n${s.stack}`);
  });
});

afterEach(() => {
  const found = slow.splice(0);
  if (found.length > 0) {
    throw new Error(
      found
        .map(
          (s) =>
            `transaction awaited outside the database (${s.durationMs} ms), opened at:\n${s.stack}`,
        )
        .join('\n\n'),
    );
  }
});
