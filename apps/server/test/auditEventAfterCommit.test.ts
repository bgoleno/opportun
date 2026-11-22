// https://github.com/bgoleno/opportun/issues/807 (tl on #801): audit() emitted its telemetry event
// as soon as it wrote the row, before the surrounding transaction committed, so a change that was
// then rolled back still appeared in the logs and the telemetry export as if it had happened. The
// event now waits for the commit of the transaction that wrote the row (withTransaction's), and a
// rolled-back transaction, or savepoint, emits nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTransaction, type Db } from '../src/db/client';
import { audit } from '../src/lib/audit';
import { obs } from '../src/obs';
import { openTestDb } from './helpers';

let close: () => Promise<void>;
let db: Db;
let emitted: string[];

beforeEach(async () => {
  const opened = await openTestDb();
  close = opened.close;
  db = opened.handle.db;
  emitted = [];
  vi.spyOn(obs, 'event').mockImplementation((name: string) => {
    emitted.push(name);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await close();
});

// A catalog event name, so audit() emits it (a name the catalog does not list is not an event).
const EVENT = 'auth.login';

describe('an audit row emits its event only once its transaction has committed (#807)', () => {
  it('a rolled-back transaction emits nothing', async () => {
    await expect(
      withTransaction(db, async (tx) => {
        await audit(tx, EVENT, {});
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(emitted).toEqual([]);
  });

  it('a committed transaction emits once, after the commit', async () => {
    await withTransaction(db, async (tx) => {
      await audit(tx, EVENT, {});
      expect(emitted).toEqual([]);
    });
    expect(emitted).toEqual([EVENT]);
  });

  it('a savepoint rolled back inside a committed transaction emits nothing for it', async () => {
    await withTransaction(db, async (tx) => {
      await withTransaction(tx, async (sp) => {
        await audit(sp, EVENT, {});
        throw new Error('savepoint rolled back');
      }).catch(() => {});
      await audit(tx, 'auth.logout', {});
    });
    expect(emitted).toEqual(['auth.logout']);
  });

  it("a committed savepoint's event waits for the outer commit, and goes with its rollback", async () => {
    await expect(
      withTransaction(db, async (tx) => {
        await withTransaction(tx, async (sp) => {
          await audit(sp, EVENT, {});
        });
        expect(emitted).toEqual([]);
        throw new Error('outer rolled back');
      }),
    ).rejects.toThrow('outer rolled back');
    expect(emitted).toEqual([]);
    await withTransaction(db, async (tx) => {
      await withTransaction(tx, async (sp) => {
        await audit(sp, EVENT, {});
      });
    });
    expect(emitted).toEqual([EVENT]);
  });

  it('outside a transaction the row commits as it is written, and emits at once', async () => {
    await audit(db, EVENT, {});
    expect(emitted).toEqual([EVENT]);
  });
});
