// Timing assertions that survive a loaded machine (issue #36).
//
// The bounds these replace measured the machine as much as the code: they failed at 385-478 ms
// against a 250 ms ceiling whenever the suite ran in parallel, and passed alone every time. A
// failure that passes on rerun teaches everyone to rerun instead of read, and that habit has
// already cost this project real time, when a genuine Fastify teardown race was dismissed as
// flake through two reruns.
//
// Two changes make these assertions stable.
//
// FIRST, THEY MEASURE CPU TIME, NOT WALL CLOCK. Wall clock counts the time the scheduler spent
// running something else, and it punishes a long operation more than a short one, because the
// long one is more likely to be interrupted. That asymmetry is fatal to a ratio. Measured on
// this machine with every core saturated, the same comparison gave wall-clock ratios of 1.8,
// 11.0 and 18.8 across three runs, and CPU ratios of 2.8, 4.6 and 4.9.
//
// SECOND, THEY ASSERT SHAPE, NOT A BOUND. Both sizes are measured moments apart, so whatever
// is left of the load affects both.

/** Process CPU time used so far, in milliseconds. */
function cpuMs(): number {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
}

/**
 * Per-iteration CPU cost, measured over enough repetitions to be measurable.
 *
 * A single run of a fast operation is unmeasurable: at 0.3 ms the clock resolution is larger
 * than the thing being timed, which made an honestly linear function look 9.6x superlinear.
 */
function perIterationMs(work: () => void, minMs: number): { ms: number; reps: number } {
  let reps = 1;
  for (;;) {
    const started = cpuMs();
    for (let i = 0; i < reps; i += 1) work();
    const total = cpuMs() - started;
    if (total >= minMs || reps >= 4096) return { ms: total / reps, reps };
    reps *= 2;
  }
}

/** The lowest per-iteration CPU cost over `runs` batches of `reps`. */
function fastestBatchMs(runs: number, reps: number, work: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let r = 0; r < runs; r += 1) {
    const started = cpuMs();
    for (let i = 0; i < reps; i += 1) work();
    best = Math.min(best, (cpuMs() - started) / reps);
  }
  return best;
}

export interface LinearCheck {
  /** The smaller workload. */
  small: () => void;
  /** The same work on `factor` times the input. */
  large: () => void;
  /** How much bigger the large input is. */
  factor: number;
  /**
   * A ceiling on the large case's CPU milliseconds, as a backstop against everything becoming
   * pathologically slower at once, which a ratio cannot see. Set it near ten times the observed
   * cost: it is here to catch a disaster, not a regression.
   */
  ceilingMs: number;
  /** Batches per size; the lowest counts. */
  runs?: number;
  label?: string;
}

/**
 * Asserts the work does not grow dramatically faster than its input.
 *
 * The threshold is `factor * 2.5`, measured rather than chosen: `pgSnippet` costs about 2.5x
 * per doubling (roughly n^1.3, steady from 128 KB to 4 MB), so a 4x input honestly costs about
 * 6.5x. A tighter bound would fail correct code. Quadratic growth at a factor of 4 is 16x, well
 * clear of the 10x allowed here, so the regression worth catching is still caught.
 */
export function expectLinear({
  small,
  large,
  factor,
  ceilingMs,
  runs = 5,
  label = 'work',
}: LinearCheck): void {
  small(); // warm the JIT on both paths before either is timed
  large();
  // Repetitions come from the small side, the one at risk of being too fast to measure.
  const { reps } = perIterationMs(small, 20);
  const smallMs = fastestBatchMs(runs, reps, small);
  const largeMs = fastestBatchMs(runs, reps, large);
  const ratio = largeMs / Math.max(smallMs, 0.001);
  const detail = `${label}: ${smallMs.toFixed(2)} ms at 1x, ${largeMs.toFixed(2)} ms at ${String(factor)}x over ${String(reps)} reps (CPU ratio ${ratio.toFixed(1)})`;
  if (ratio > factor * 2.5) {
    throw new Error(`${detail}; expected about ${String(factor)}x, so this is superlinear`);
  }
  if (largeMs > ceilingMs) {
    throw new Error(`${detail}; over the ${String(ceilingMs)} ms disaster ceiling`);
  }
}

/** Lowest wall-clock ms over `runs` calls: the minimum, not the mean, for the same reason as
 * `fastestBatchMs` above, a run slowed by something else on the machine can only push this
 * up, never down, so the fastest observed call is the one closest to the work's own cost. */
async function fastestAsyncMs(runs: number, work: () => Promise<unknown>): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let r = 0; r < runs; r += 1) {
    const started = performance.now();
    await work();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

export interface AsyncLinearCheck {
  /** The smaller workload. */
  small: () => Promise<unknown>;
  /** The same work, against `factor` times the data `small` ran against. */
  large: () => Promise<unknown>;
  factor: number;
  ceilingMs: number;
  runs?: number;
  label?: string;
}

/**
 * `expectLinear`'s counterpart for work a CPU timer cannot see (issue #186): a database round
 * trip, where the cost is mostly time spent waiting on I/O, not time spent running this
 * process's own instructions. Wall clock is the only honest measure of that, so this takes the
 * same "fastest of N wins" defense against machine noise, over real elapsed time instead of
 * CPU time.
 *
 * Unlike `expectLinear`, `small` and `large` are not the same input run at two sizes: they are
 * two different pre-seeded scales (the caller already baked the size difference into whatever
 * `small`/`large` query against), because the work here is "this one query against a database
 * already at size N," not a value that can be regenerated bigger on demand like a string. If
 * `small`/`large` also mutate data (an insert, not just a read), repeating either one `runs`
 * times does drift its own baseline by `runs` rows; keep `runs` small for those, since the
 * drift is what it is regardless and the factor/ceiling checks below have slack built in for
 * exactly this kind of real-world noise.
 */
export async function expectLinearAsync({
  small,
  large,
  factor,
  ceilingMs,
  runs = 3,
  label = 'work',
}: AsyncLinearCheck): Promise<void> {
  await small(); // warm the connection/cache on both paths before either is timed
  await large();
  const smallMs = await fastestAsyncMs(runs, small);
  const largeMs = await fastestAsyncMs(runs, large);
  const ratio = largeMs / Math.max(smallMs, 0.001);
  const detail = `${label}: ${smallMs.toFixed(2)} ms at 1x, ${largeMs.toFixed(2)} ms at ${String(factor)}x over ${String(runs)} runs (wall-clock ratio ${ratio.toFixed(1)})`;
  if (ratio > factor * 2.5) {
    throw new Error(`${detail}; expected about ${String(factor)}x, so this is superlinear`);
  }
  if (largeMs > ceilingMs) {
    throw new Error(`${detail}; over the ${String(ceilingMs)} ms disaster ceiling`);
  }
}
