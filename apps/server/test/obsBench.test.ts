// The cost with collection on (design.md 14.11; https://github.com/bgoleno/opportun/issues/343):
// under 20 microseconds per boundary crossing and under 2 per database statement after the
// first sight of its text, on average. A benchmark, reported in the PR, not a gate: timings
// vary by machine, so it runs only with OBS_BENCH=1 and prints its averages.
//
//   OBS_BENCH=1 OBS_BENCH_OUT=<file> npx vitest run test/obsBench.test.ts
//
// No tracer provider is registered (FR-T4 part 2's), so a span here costs what the API's
// no-op span costs; the provider's own cost is measured with that slice.
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { obs, setCollecting } from '../src/obs';
import { observeStatement } from '../src/obs/database';
import { useApi } from './api';

const boot = useApi();
const RUN = process.env.OBS_BENCH === '1';

function perCallMicros(n: number, fn: (i: number) => void): number {
  for (let i = 0; i < 1_000; i += 1) fn(i); // warm up
  const started = performance.now();
  for (let i = 0; i < n; i += 1) fn(i);
  return ((performance.now() - started) * 1000) / n;
}

describe.runIf(RUN)('collection on: cost per call (#343, reported in the PR)', () => {
  it('measures each boundary', async () => {
    await boot();
    await setCollecting(true);
    const N = 200_000;
    const results = {
      // A database statement whose text was seen before: shape lookup, gate, aggregate.
      dbStatement: perCallMicros(N, () =>
        observeStatement('sqlite', 'select "id" from "companies" where "user_id" = ?', () => 0),
      ),
      // An HTTP request's share: open a span, record the metric with four attributes, end it.
      httpBoundary: perCallMicros(N, (i) => {
        const s = obs.startSpan('http.server', {
          'http.request.method': 'GET',
          'http.route': '/api/v1/opportunities/:id',
        });
        obs.record('http.server.request.duration', 0.01, {
          'http.request.method': 'GET',
          'http.route': '/api/v1/opportunities/:id',
          'http.response.status_code': i % 10 === 0 ? 500 : 200,
        });
        s.end();
      }),
    };
    // Vitest hides a passing test's console: OBS_BENCH_OUT names a file for the numbers.
    const out = process.env.OBS_BENCH_OUT;
    if (out !== undefined) writeFileSync(out, `${JSON.stringify(results)}\n`);
    else console.log('obs bench (microseconds per call)', JSON.stringify(results));
    expect(results.dbStatement).toBeLessThan(2);
    expect(results.httpBoundary).toBeLessThan(20);
    await setCollecting(false);
  });
});
