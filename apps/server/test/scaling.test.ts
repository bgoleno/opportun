// The timing helper itself (issue #36): it has to still fail a superlinear implementation,
// or it has only replaced a flaky assertion with one that never fires.
import { describe, expect, it } from 'vitest';
import { expectLinear } from './scaling';

/** Busy work proportional to n, so the cost is in the loop rather than in any library. */
function linearWork(n: number): number {
  let acc = 0;
  for (let i = 0; i < n; i += 1) acc += i % 7;
  return acc;
}

/** The same shape, but each unit of input costs more as the input grows. */
function quadraticWork(n: number): number {
  let acc = 0;
  for (let i = 0; i < n; i += 1) for (let j = 0; j < n / 400; j += 1) acc += (i + j) % 7;
  return acc;
}

describe('expectLinear', () => {
  it('passes work that grows with its input', () => {
    expectLinear({
      label: 'linear',
      factor: 4,
      ceilingMs: 5_000,
      small: () => void linearWork(4_000_000),
      large: () => void linearWork(16_000_000),
    });
  });

  // Issue #190: timeout raised from vitest's 30s default to 180s. expectLinear's own CPU-time
  // measurement is sound under contention (verified directly: a fixed computation's
  // process.cpuUsage() stayed flat, ratio 1.01 across 12 samples, under the exact heavy
  // multi-session load that was making this test fail) -- the cost here is necessarily a
  // synchronous, CPU-bound block (no `await` anywhere in expectLinear or its helpers), so
  // vitest's own timeout, which is wall-clock and cannot preempt synchronous code, can only
  // report a timeout after the fact once the block finally returns (confirmed directly: a
  // synthetic 3s synchronous test against a 1s timeout ran the full 3s before vitest reported
  // it). Under genuine full-suite contention that wall-clock duration -- not this test's own
  // CPU-time math -- is what crossed 30s (observed: 33.6s and 64.5s on two independent
  // sessions' machines the same night). ceilingMs below is a PER-CALL cost (fastestBatchMs
  // divides by reps), so a single quadraticWork(24_000) call would need to cost 60 real seconds
  // to trip it -- it was never the actual failure mode. 180s is comfortably above every
  // observed case while still catching a genuine hang.
  it(
    'fails work that grows faster than its input, which is the whole point',
    { timeout: 180_000 },
    () => {
      // Issue #72: this flaked (reported against this exact test, reproduced directly against
      // expectLinear outside vitest too). At factor 4, true quadratic growth measures a CPU
      // ratio around 13-17 against a detection threshold of 10 (factor * 2.5) — real margin,
      // but only about 1.3-1.7x, and one direct run measured a ratio under 10 outright, i.e.
      // this test failing to throw. The margin scales with factor (the ratio grows with its
      // square, the threshold only linearly), so factor 8 was measured instead: six runs gave
      // CPU ratios of 52-72 against a threshold of 20, a stable ~2.6-3.6x margin with no
      // failures, for about 4x the CPU cost of factor 4 (a few extra seconds).
      expect(() =>
        expectLinear({
          label: 'quadratic',
          factor: 8,
          ceilingMs: 60_000,
          small: () => void quadraticWork(3_000),
          large: () => void quadraticWork(24_000),
        }),
      ).toThrow(/superlinear/);
    },
  );

  it('fails a linear implementation that is simply far too slow', () => {
    expect(() =>
      expectLinear({
        label: 'slow but linear',
        factor: 4,
        ceilingMs: 1,
        small: () => void linearWork(4_000_000),
        large: () => void linearWork(16_000_000),
      }),
    ).toThrow(/disaster ceiling/);
  });
});
