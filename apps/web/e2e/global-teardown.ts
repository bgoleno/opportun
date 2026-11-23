// The run's sign-in budget (https://github.com/bgoleno/opportun/issues/776). Each server's test
// mocks record every request to a rate-limited auth route and every re-authentication, and replay
// the server's own buckets over them (apps/server/src/testSupport/mockAuth.ts). This fails
// the run when any bucket's peak spend passed its margin (half its limit; mockAuth.ts MARGINS
// names the one exception and why), naming the bucket, so a spec
// that signs in too often fails here, with the numbers, before the suite grows into a run that
// fails some unrelated spec with "Too many attempts".
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';
import type { FullConfig } from '@playwright/test';

/**
 * A spec that tests a limit itself spends its bucket to the end on purpose: its accounts' emails
 * start with this, and their buckets are left out of the check (their addresses still count in
 * the per-IP ceilings).
 */
export const LIMIT_TEST_EMAIL_PREFIX = 'e2e-limit-';

interface BucketSpend {
  kind: string;
  bucket: string;
  limit: number;
  windowMinutes: number;
  peak: number;
  requests: number;
  margin: number;
  over: boolean;
}

export default async function globalTeardown(config: FullConfig): Promise<void> {
  // The admin's stored session (global-setup.ts) is no use past this run's server: its directory,
  // made for this run alone, goes with it.
  // Only a directory global-setup made: in the temp folder, named as its mkdtemp names it.
  const state = process.env.E2E_ADMIN_STATE;
  const dir = state === undefined || state === '' ? undefined : dirname(state);
  if (
    dir !== undefined &&
    dirname(dir) === tmpdir() &&
    basename(dir).startsWith('opportun-e2e-admin-')
  ) {
    await rm(dir, { recursive: true, force: true });
  }
  const servers = [
    ...new Set(config.projects.map((p) => p.use.baseURL).filter((u) => u !== undefined)),
  ];
  const over: string[] = [];
  for (const base of servers) {
    let buckets: BucketSpend[];
    try {
      const res = await fetch(new URL('/__mock/auth/budget', base));
      if (!res.ok) throw new Error(`status ${res.status}`);
      ({ buckets } = (await res.json()) as { buckets: BucketSpend[] });
    } catch (err) {
      throw new Error(`could not read the sign-in budget from ${base}: ${String(err)}`, {
        cause: err,
      });
    }
    // Each kind of limit's fullest bucket, by share of its limit: the accounts' keys appear only
    // in a failure, where they say which spec to look at.
    const fullest = new Map<string, BucketSpend>();
    for (const b of buckets) {
      const seen = fullest.get(b.kind);
      if (seen === undefined || b.peak / b.limit > seen.peak / seen.limit) fullest.set(b.kind, b);
    }
    const lines = [...fullest.values()].map(
      (b) =>
        `  ${b.kind}: peak ${b.peak} of ${b.limit} per ${b.windowMinutes} min, ${Math.round((b.peak / b.limit) * 100)}% (fails over ${b.margin * 100}%)`,
    );
    console.log(`Sign-in budget on ${base}, each limit's fullest bucket:\n${lines.join('\n')}`);
    for (const b of buckets) {
      if (b.bucket.includes(`|${LIMIT_TEST_EMAIL_PREFIX}`)) continue;
      if (b.over) {
        over.push(
          `${base} ${b.kind} ${b.bucket}: peak ${b.peak} of ${b.limit} per ${b.windowMinutes} min`,
        );
      }
    }
  }
  if (over.length > 0) {
    throw new Error(
      `The run spent more of a sign-in limit than its margin allows (#776): sign in once per file, or reuse a stored session (helpers.ts adminContext), instead of signing in per test.\n${over.join('\n')}`,
    );
  }
}
