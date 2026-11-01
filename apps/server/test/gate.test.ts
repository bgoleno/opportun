// The write gate primitive (db/gate.ts). Pins why db/client.ts re-checks mustWait() in the
// same synchronous step as each statement (review fix 4): an idleFor() wake-up does not mean
// the gate is still free when the waiter's continuation runs.
import { describe, expect, it } from 'vitest';
import { WriteGate } from '../src/db/gate';

describe('WriteGate', () => {
  it('can be re-taken between an idleFor() wake-up and the waiter continuing', async () => {
    const gate = new WriteGate();
    const release = await gate.acquire(Symbol('a'));
    let mustWaitWhenWoken: boolean | undefined;
    const waiter = gate.idleFor(undefined).then(() => {
      mustWaitWhenWoken = gate.mustWait();
    });
    release(); // wakes idleFor, whose own loop sees the gate free and resolves...
    // ...and a transaction queued in that same microtask round takes the gate before the
    // waiter's continuation runs.
    queueMicrotask(() => void gate.acquire(Symbol('b')));
    await waiter;
    expect(mustWaitWhenWoken).toBe(true);
  });

  it('counts what waits for it, queued transactions and idle statements alike, and nothing else', async () => {
    // test/race.ts heldApart reads waiting() to observe a caller held back: a request may be
    // stopped at a statement before its transaction opens, or queued at BEGIN.
    const gate = new WriteGate();
    expect(gate.waiting()).toBe(0);
    const releaseA = await gate.acquire(Symbol('a'));
    expect(gate.waiting()).toBe(0); // the holder is not waiting
    const queued = gate.acquire(Symbol('b'));
    expect(gate.waiting()).toBe(1);
    const idle = gate.idleFor(undefined);
    expect(gate.waiting()).toBe(2);
    releaseA(); // hands the gate to b; the idle statement still waits
    const releaseB = await queued;
    expect(gate.waiting()).toBe(1);
    releaseB();
    await idle;
    expect(gate.waiting()).toBe(0);
  });

  it('hands the gate straight to a queued transaction, without waking idle statements', async () => {
    const gate = new WriteGate();
    const releaseA = await gate.acquire(Symbol('a'));
    const b = Symbol('b');
    const queued = gate.acquire(b);
    let woke = false;
    void gate.idleFor(undefined).then(() => (woke = true));
    releaseA();
    const releaseB = await queued;
    expect(gate.holder()).toBe(b);
    await Promise.resolve();
    expect(woke).toBe(false);
    releaseB();
    await new Promise((r) => setTimeout(r, 0));
    expect(woke).toBe(true);
  });
});
