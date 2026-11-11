// The overhead budget with collection off (design.md 14.11, issue #343 criterion 4): one boolean
// check per boundary, no recording span, no write, SDK not loaded. Shown three ways: with a
// recording provider registered, driving every FR-T3 boundary makes no span and no row; a loop
// of disabled boundary calls stays under a wide bound; and no server source imports an
// OpenTelemetry SDK package (only tests do, as devDependencies).
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { rawAll } from '../src/db/client';
import { obsMetricPoints, obsSpans, obsTraces } from '../src/db/schema';
import { registerJob } from '../src/jobs/registry';
import { enqueue, runDueJobs } from '../src/jobs/runner';
import { flushNow, isCollecting, obs } from '../src/obs';
import { observeStatement } from '../src/obs/database';
import { observeOutbound } from '../src/obs/outbound';
import { useApi } from './api';
import { countRows } from './db';
import { useInMemoryTracing } from './otelProvider';

const boot = useApi();
const exporter = useInMemoryTracing();

registerJob({
  kind: 'test.obs-budget',
  payloadSchema: z.object({}),
  maxAttempts: 1,
  run: async () => undefined,
});

describe('collection off: the budget of 14.11 (#343)', () => {
  it('with a recording provider registered, every boundary makes no span and no row', async () => {
    const { app, a } = await boot();
    expect(isCollecting()).toBe(false);
    await a.request({ method: 'GET', url: '/api/v1/opportunities' });
    await app.inject({ method: 'GET', url: '/healthz' });
    await enqueue(app.db, 'test.obs-budget', {});
    await runDueJobs(app.db);
    await rawAll(app.db, sql`SELECT 1`);
    await observeOutbound(
      { target: 'public_site', method: 'GET', url: 'https://example.com' },
      async () => ({
        status: 200,
      }),
    );
    const s = obs.startSpan('http.server', { 'http.request.method': 'GET', 'http.route': '/x' });
    s.end();
    await flushNow();
    expect(exporter.getFinishedSpans()).toEqual([]);
    for (const t of [obsMetricPoints, obsTraces, obsSpans]) expect(await countRows(app, t)).toBe(0);
  });

  it('a disabled boundary call costs one check: 100,000 of each stay under a wide bound', async () => {
    await boot();
    const N = 100_000;
    const send = async () => ({ status: 200 });
    const call = { target: 'public_site' as const, method: 'GET', url: 'https://example.com' };
    const started = performance.now();
    for (let i = 0; i < N; i += 1) {
      observeStatement('sqlite', 'SELECT 1', () => i);
      obs.record('db.client.operation.duration', 0.001, { 'db.system.name': 'sqlite' });
      obs.startSpan('http.server', {}).end();
    }
    for (let i = 0; i < N; i += 1) await observeOutbound(call, send);
    const elapsed = performance.now() - started;
    // About a microsecond a call is the budget. 4 seconds for these 400,000 calls (the awaited
    // ones included) is a wide margin that still fails if a disabled call starts timing,
    // gating, aggregating or opening a span.
    expect(elapsed).toBeLessThan(4_000);
  });

  it('no server source imports an OpenTelemetry SDK package: the SDK is not loaded', async () => {
    const root = join(__dirname, '..', 'src');
    const files: string[] = [];
    const walk = async (dir: string) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    await walk(root);
    // FR-T4 part 2's obs/tracing.ts is the one file that imports the SDK (design 14.3: the
    // provider). It is loaded when collection is first turned on, by a dynamic import(), so
    // the SDK stays unloaded until then: no file may import tracing.ts statically.
    const TRACING = '/obs/tracing.ts';
    const sdkImports: string[] = [];
    const staticTracingImports: string[] = [];
    for (const f of files) {
      const rel = f.slice(root.length);
      const text = await readFile(f, 'utf8');
      // `import type` is erased by TypeScript and loads nothing (fs2's span store uses the SDK's
      // types), so only value imports count.
      const values = text.replace(/import type [^;]*;/g, '');
      if (rel !== TRACING && /from '@opentelemetry\/(?!api')[^']+'/.test(values)) {
        sdkImports.push(rel);
      }
      if (/from '(?:\.{1,2}\/)+(?:obs\/)?tracing'/.test(text)) staticTracingImports.push(rel);
    }
    expect(sdkImports).toEqual([]);
    expect(staticTracingImports).toEqual([]);
  });
});
