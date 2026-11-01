// The timing helper itself (issue #36): it has to still fail a superlinear implementation,
// or it has only replaced a flaky assertion with one that never fires.
import { Worker } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';
import { CPU_CLOCK, cpuMs, expectLinear } from './scaling';

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

// Issue #41: helper threads of the test process (V8's garbage collector and compiler threads)
// spend CPU time that process.cpuUsage counts but the measured code did not spend on the main
// thread. A steady background thread would inflate both sizes alike and cancel out of the
// ratio; what breaks the ratio is helper time that lands unevenly, for example on the large
// side, whose bigger allocations keep the collector busier. These tests build that state on
// purpose with Workers in this process, so the failure does not depend on a loaded machine.

/** Main-thread CPU since process start, read directly, so a precondition does not depend on
 * which clock scaling.ts chose. */
function threadMs(): number {
  const { user, system } = process.threadCpuUsage();
  return (user + system) / 1000;
}

/** Every thread of the process, the clock scaling.ts used before issue #41. */
function processMs(): number {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
}

// Slot 0 is the command (0 idle, 1 spin, 2 exit); slot 1 + i is 1 while helper i is spinning.
// Plain JavaScript evaluated in the Worker, so it needs no TypeScript transform.
const HELPER_SOURCE = `
const { workerData, parentPort } = require('node:worker_threads');
const slots = new Int32Array(workerData.buffer);
const me = 1 + workerData.index;
parentPort.postMessage('ready');
for (;;) {
  Atomics.wait(slots, 0, 0);
  if (Atomics.load(slots, 0) === 2) break;
  Atomics.store(slots, me, 1);
  while (Atomics.load(slots, 0) === 1) {}
  Atomics.store(slots, me, 0);
}
`;

interface Helpers {
  /** Starts every helper spinning; returns at once, without waiting for them to wake. */
  spin: () => void;
  /** Sends every helper back to sleep. */
  idle: () => void;
  /** Resolves once every helper reports that it is spinning. */
  spinning: () => Promise<void>;
  stop: () => Promise<void>;
}

/** Starts `count` Workers that sleep until told to spin; resolves once each is listening. */
async function startHelpers(count: number): Promise<Helpers> {
  const slots = new Int32Array(new SharedArrayBuffer(4 * (1 + count)));
  const workers = Array.from(
    { length: count },
    (_, index) =>
      new Worker(HELPER_SOURCE, { eval: true, workerData: { buffer: slots.buffer, index } }),
  );
  const command = (value: number): void => {
    Atomics.store(slots, 0, value);
    Atomics.notify(slots, 0);
  };
  const stop = async (): Promise<void> => {
    command(2);
    await Promise.all(workers.map((w) => w.terminate()));
  };
  try {
    await Promise.all(
      workers.map(
        (w) =>
          new Promise<void>((resolve, reject) => {
            w.once('message', () => {
              resolve();
            });
            w.once('error', reject);
          }),
      ),
    );
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    spin: () => {
      command(1);
    },
    idle: () => {
      command(0);
    },
    spinning: async () => {
      const deadline = Date.now() + 10_000;
      for (let i = 1; i <= count; i += 1) {
        while (Atomics.load(slots, i) !== 1) {
          if (Date.now() > deadline)
            throw new Error(`helper ${String(i - 1)} never started spinning`);
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      }
    },
    stop,
  };
}

// Without process.threadCpuUsage (Node below 22.19) scaling.ts falls back to process.cpuUsage,
// which counts the helpers by definition, so these cannot pass there. CI resolves .nvmrc's 22
// to the latest 22.x, which has it.
const hasThreadClock = typeof process.threadCpuUsage === 'function';

describe('expectLinear with other threads of the process busy (issue #41)', () => {
  it('falls back to the process-wide clock where the runtime has no thread clock', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'threadCpuUsage');
    // As on Node 22 before 22.19: the method is simply not there.
    Reflect.deleteProperty(process, 'threadCpuUsage');
    try {
      vi.resetModules();
      const fallback = await import('./scaling');
      expect(fallback.CPU_CLOCK).toBe('process.cpuUsage');
      const before = fallback.cpuMs();
      linearWork(4_000_000);
      expect(fallback.cpuMs()).toBeGreaterThan(before);
    } finally {
      if (descriptor) Object.defineProperty(process, 'threadCpuUsage', descriptor);
      vi.resetModules();
    }
  });

  it.skipIf(!hasThreadClock)('times only the thread that runs the work', async () => {
    const helpers = await startHelpers(1);
    try {
      helpers.spin();
      await helpers.spinning();
      const idle = new Int32Array(new SharedArrayBuffer(4));
      const processBefore = processMs();
      const clockBefore = cpuMs();
      // The main thread blocks for 500 ms, spending no CPU of its own. The helper needs only a
      // tenth of a core over that time to clear the precondition below, so a busy CI runner
      // still builds the state.
      Atomics.wait(idle, 0, 0, 500);
      const clockSpent = cpuMs() - clockBefore;
      const processSpent = processMs() - processBefore;
      helpers.idle();
      // The construct worked: the helper really burned CPU while the main thread slept.
      expect(processSpent, 'process-wide CPU while the helper spun').toBeGreaterThan(50);
      expect(clockSpent, `${CPU_CLOCK} while the main thread slept`).toBeLessThan(20);
    } finally {
      await helpers.stop();
    }
  });

  it.skipIf(!hasThreadClock)(
    'passes linear work while other threads are busy only during the large side',
    async () => {
      // Three helpers make the old clock read the large side at about four times its cost, a
      // ratio near 16 against the limit of 10, on any machine with four free cores.
      const helpers = await startHelpers(3);
      try {
        const processBefore = processMs();
        const threadBefore = threadMs();
        expectLinear({
          label: 'linear, helpers busy on the large side',
          factor: 4,
          ceilingMs: 5_000,
          small: () => void linearWork(4_000_000),
          large: () => {
            helpers.spin();
            try {
              linearWork(16_000_000);
            } finally {
              helpers.idle();
            }
          },
        });
        const otherThreads = processMs() - processBefore - (threadMs() - threadBefore);
        // The construct worked: the pass is not because the helpers never ran.
        expect(otherThreads, 'CPU spent by other threads during the measurement').toBeGreaterThan(
          50,
        );
      } finally {
        await helpers.stop();
      }
    },
  );
});

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

  it('names the reps, both times, the ratio and the clock when it fails', () => {
    let message = '';
    try {
      expectLinear({
        label: 'slow but linear',
        factor: 4,
        ceilingMs: 1,
        small: () => void linearWork(4_000_000),
        large: () => void linearWork(16_000_000),
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(
      /^slow but linear: \d+\.\d{2} ms at 1x, \d+\.\d{2} ms at 4x over \d+ reps \(CPU ratio \d+\.\d, clock /,
    );
    expect(message).toContain(`clock ${CPU_CLOCK})`);
  });
});
