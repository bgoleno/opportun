// Counts discovery.rank's cacheable prefix with Anthropic's token counter
// (https://github.com/bgoleno/opportun/issues/388, criterion 1).
//
//   pnpm --filter @opportun/server exec tsx scripts/countRankPrefix.ts --key-file <path>
//   pnpm --filter @opportun/server exec tsx scripts/countRankPrefix.ts --dry-run
//
// count_tokens runs no model and costs nothing, but it needs an Anthropic API key. --dry-run
// needs none and sends nothing: it prints the characters, and the schema's characters, alone.
//
// The key: read from the file named, and used only in the x-api-key header of requests to
// https://api.anthropic.com/v1/messages/count_tokens (a fixed address; redirects are refused). It
// is never printed, logged, written or put in an error message. The request the router builds is
// captured with a stand-in key and a fetch that sends nothing, so the router never sees the key.
//
// What it counts: the rank default from a fresh database migrated to head, as it is and with
// "## Output" moved before "## Posting", for four role targets (invented, no one's data). For each,
// the system text before the posting (the part the router may mark for the cache), and that part
// plus the structured-output schema, which the provider renders ahead of it. Each count is the
// body's count minus that of the same one-character message alone.
//
// Output: characters and tokens only.
import Database from 'better-sqlite3';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  cacheMinTokens,
  RankOutputSchema,
  resolvePolicy,
  runStructured,
  systemWithCacheBreak,
  type AiDeps,
} from '@opportun/ai';
import { migrateLocked } from '../src/db/client';
import type { roleTargets } from '../src/db/schema';
import { roleTargetLine } from '../src/jobs/classify';
import { outputBeforePosting, prefixCountBodies, type CountBody } from '../src/lib/rankPrefixCount';

const COUNT_URL = 'https://api.anthropic.com/v1/messages/count_tokens';

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readKey(): string {
  const i = process.argv.indexOf('--key-file');
  const path = i === -1 ? undefined : process.argv[i + 1];
  if (path === undefined)
    fail('usage: countRankPrefix --key-file <path to a file holding the key>');
  let text: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the operator's own argument
    text = readFileSync(resolve(path), 'utf8');
  } catch {
    fail('Could not read the key file.');
  }
  const key = text.trim();
  // Checked without echoing it: a header value must be one line of visible characters.
  if (!/^[\x21-\x7e]+$/.test(key)) fail('The key file must hold the key alone, on one line.');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the same path, read above
  if ((statSync(resolve(path)).mode & 0o077) !== 0) {
    process.stderr.write('Note: the key file can be read by other users (chmod 600 it).\n');
  }
  return key;
}

/** The rank default as a fresh install has it: every migration applied to an empty database. */
function rankDefault(): string {
  const sqlite = new Database(':memory:');
  try {
    migrateLocked(sqlite);
    const row = sqlite
      .prepare(
        "SELECT body FROM prompts WHERE user_id IS NULL AND task_key = 'discovery.rank' AND version = 1",
      )
      .get() as { body: string } | undefined;
    if (row === undefined) fail('The migrated database has no discovery.rank default.');
    return row.body;
  } finally {
    sqlite.close();
  }
}

type RoleTarget = typeof roleTargets.$inferSelect;

function target(
  fields: Partial<RoleTarget> & Pick<RoleTarget, 'name' | 'titleFamily'>,
): RoleTarget {
  return {
    seniorityMin: null,
    seniorityMax: null,
    keywords: [],
    industries: [],
    locations: [],
    remotePref: 'any',
    compMin: null,
    compMax: null,
    currency: null,
    ...fields,
  } as RoleTarget;
}

// Invented role targets, from a short one to a full one.
const TARGETS: RoleTarget[] = [
  target({ name: 'Backend', titleFamily: 'Software Engineer', seniorityMin: 4, seniorityMax: 5 }),
  target({
    name: 'Platform lead',
    titleFamily: 'Engineering Manager',
    seniorityMin: 5,
    seniorityMax: 6,
    keywords: ['platform', 'infrastructure', 'developer experience'],
    locations: ['Seattle, WA'],
    remotePref: 'hybrid',
    compMin: 220000,
    compMax: 280000,
    currency: 'USD',
  }),
  target({
    name: 'Product design',
    titleFamily: 'Product Designer',
    seniorityMin: 3,
    seniorityMax: 4,
    keywords: ['design systems', 'B2B SaaS', 'user research', 'prototyping'],
    industries: ['Software', 'Financial services'],
    locations: ['Remote (US)', 'New York, NY'],
    remotePref: 'remote',
    compMin: 150000,
    currency: 'USD',
  }),
];

const ROLE_TARGETS: { label: string; text: string }[] = [
  // The text discoveryRank uses when a source runs for no single role target.
  {
    label: 'all three targets',
    text: `No single role target is set for this source. Judge fit against all of the user's role targets:\n${TARGETS.map(roleTargetLine).join('\n')}`,
  },
  ...TARGETS.map((t) => ({ label: t.name, text: roleTargetLine(t) })),
];

/** Stands in for the posting: it follows the break, so it is never counted. */
const POSTING = 'A posting.';

/** The Messages request the router builds for this rank call, captured, never sent. */
async function capture(system: string, cacheBreak: number): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> | undefined;
  const recording = (async (_input: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    throw new Error('captured');
  }) as typeof fetch;
  const deps: AiDeps = {
    getKey: async () => 'stand-in-key-never-sent',
    policyFor: async (t) => resolvePolicy(t, undefined),
    record: async () => {},
    budget: { perTaskDailyUsd: 5 },
    spentTodayUsd: async () => 0,
    providerFetch: { fetch: recording, allowLoopbackHttp: false },
  };
  await runStructured(deps, 'discovery.rank', {
    system,
    cacheBreak,
    prompt: 'Score the posting and return the result.',
    schema: RankOutputSchema,
  }).catch(() => undefined);
  if (body === undefined) fail('The router made no request to capture.');
  return body;
}

/** The captured system prompt as one string, whether it went as one block or two. */
function systemText(body: Record<string, unknown>): string {
  const system = body['system'];
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) fail('The captured request has no system prompt.');
  return system.map((b: { text?: unknown }) => String(b.text ?? '')).join('');
}

async function count(key: string, body: CountBody): Promise<number> {
  const res = await fetch(COUNT_URL, {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => undefined)) as
    { input_tokens?: unknown; error?: { type?: unknown } } | undefined;
  if (!res.ok || typeof json?.input_tokens !== 'number') {
    // The status and the error's type only: nothing from the request.
    fail(`count_tokens failed: HTTP ${res.status} ${String(json?.error?.type ?? '')}`.trim());
  }
  return json.input_tokens;
}

const dryRun = process.argv.includes('--dry-run');
const key = dryRun ? undefined : readKey();
const base = rankDefault();
const templates = [
  { label: 'default as migrated', body: base },
  { label: 'Output before Posting', body: outputBeforePosting(base) },
];
const policy = resolvePolicy('discovery.rank', undefined);
const min = cacheMinTokens(policy.provider, policy.model);
process.stdout.write(`model ${policy.model}; cache minimum ${String(min)} tokens\n`);
process.stdout.write(
  dryRun
    ? 'template | role target | prefix chars | + schema chars\n'
    : 'template | role target | prefix chars | prefix tokens | + schema tokens\n',
);

let baseline: number | undefined;
for (const tpl of templates) {
  for (const rt of ROLE_TARGETS) {
    const { system, cacheBreak } = systemWithCacheBreak(tpl.body, {
      role_target: rt.text,
      posting_untrusted: POSTING,
    });
    const captured = await capture(system, cacheBreak);
    // The prefix counted is the one the router would send: check it against the capture.
    const prefix = system.slice(0, cacheBreak);
    if (!systemText(captured).startsWith(prefix)) fail('The captured system prompt differs.');
    const bodies = prefixCountBodies(captured, prefix);
    if (key === undefined) {
      const schema = JSON.stringify(bodies.prefixWithSchema['output_config'] ?? '').length;
      process.stdout.write(
        `${tpl.label} | ${rt.label} | ${prefix.length} | ${prefix.length + schema}\n`,
      );
      continue;
    }
    baseline ??= await count(key, bodies.baseline);
    const p = (await count(key, bodies.prefix)) - baseline;
    const ps = (await count(key, bodies.prefixWithSchema)) - baseline;
    process.stdout.write(`${tpl.label} | ${rt.label} | ${prefix.length} | ${p} | ${ps}\n`);
  }
}
