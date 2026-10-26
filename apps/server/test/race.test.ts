// The racing-test barrier itself (test/race.ts): callers are held until all arrive, and a
// missing caller fails instead of hanging.
import { describe, expect, it } from 'vitest';
import { racePoint } from '../src/lib/racePoints';
import { holdAt } from './race';

describe('race barrier', () => {
  it('releases the callers only once all of them have arrived', async () => {
    const barrier = holdAt('test.point', 2);
    const order: string[] = [];
    const a = (async () => {
      await racePoint('test.point');
      order.push('a past');
    })();
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([]);
    expect(barrier.arrived()).toBe(1);
    const b = (async () => {
      await racePoint('test.point');
      order.push('b past');
    })();
    await Promise.all([a, b]);
    expect(barrier.arrived()).toBe(2);
    expect(order.sort()).toEqual(['a past', 'b past']);
    // Other points and later callers pass straight through.
    await racePoint('other.point');
    await racePoint('test.point');
  });

  it('fails a caller when the others never arrive', async () => {
    holdAt('test.lonely', 2);
    await expect(racePoint('test.lonely')).rejects.toThrow(/only 1 of 2 callers/);
  }, 10_000);
});
