// Counts discovery.rank's cacheable prefix with Anthropic's token counter
// (https://github.com/bgoleno/opportun/issues/388, criterion 1).
//
//   pnpm --filter @opportun/server exec tsx scripts/countRankPrefix.ts --key-file <path>
//   pnpm --filter @opportun/server exec tsx scripts/countRankPrefix.ts --dry-run
//
// count_tokens runs no model and costs nothing, but it needs an Anthropic API key. --dry-run
// needs none and sends nothing: it prints the characters, and the schema's characters, alone.
//
// The key: read from the file named, which must be readable by its owner alone (mode 600 or 400;
// anything else is refused before the file is read), and used only in the x-api-key header of requests to
// https://api.anthropic.com/v1/messages/count_tokens (a fixed address; redirects are refused). It
// is never printed, logged, written or put in an error message. The request the router builds is
// captured with a stand-in key and a fetch that sends nothing, so the router never sees the key.
//
// What it counts: the rank default from a fresh database migrated to head, as it is and with
// "## Output" moved before "## Posting", for four role targets (invented, no one's data). For each,
// the system text before the posting (the part the router may mark for the cache), and that part
// plus the structured-output schema. Each count is the body's count minus that of the same
// one-character message alone, on the task's own model.
//
// Whether the schema is inside the cached prefix is not documented: Anthropic says only that the
// model receives an added system prompt explaining the output format, not where it sits against
// the breakpoint. So the script also counts the discovery.company_tags prefix both ways, beside the
// cache write qa measured live for that same prefix on #378 (6,472 tokens for 14,531 characters,
// https://github.com/bgoleno/opportun/pull/378#issuecomment-6790450354). Whichever count matches
// the live write says whether the schema is cached with the prefix.
//
// Output: characters and tokens only.
import Database from 'better-sqlite3';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  cacheMinTokens,
  CompanyTagsOutputSchema,
  RankOutputSchema,
  resolvePolicy,
  runStructured,
  systemWithCacheBreak,
  type AiDeps,
  type TaskKey,
} from '@opportun/ai';
import type { z } from 'zod';
import { migrateLocked } from '../src/db/client';
import type { roleTargets } from '../src/db/schema';
import { roleTargetLine } from '../src/jobs/classify';
import { NAICS_TABLE_TEXT } from '../src/jobs/companyTags';
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
  // Before the key is read: a key file other users can read is refused (chmod 600 or 400).
  let mode: number;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the operator's own argument
    mode = statSync(resolve(path)).mode;
  } catch {
    fail('Could not read the key file.');
  }
  if ((mode & 0o077) !== 0) {
    fail('The key file can be read by other users: chmod 600 it, then run this again.');
  }
  let text: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the same path, checked above
    text = readFileSync(resolve(path), 'utf8');
  } catch {
    fail('Could not read the key file.');
  }
  const key = text.trim();
  // Checked without echoing it: a header value must be one line of visible characters.
  if (!/^[\x21-\x7e]+$/.test(key)) fail('The key file must hold the key alone, on one line.');
  return key;
}

/** The system defaults as a fresh install has them: every migration applied to an empty database. */
function defaults(): { rank: string; tags: string } {
  const sqlite = new Database(':memory:');
  try {
    migrateLocked(sqlite);
    const body = (task: TaskKey): string => {
      const row = sqlite
        .prepare('SELECT body FROM prompts WHERE user_id IS NULL AND task_key = ? AND version = 1')
        .get(task) as { body: string } | undefined;
      if (row === undefined) fail(`The migrated database has no ${task} default.`);
      return row.body;
    };
    return { rank: body('discovery.rank'), tags: body('discovery.company_tags') };
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

/** The Messages request the router builds for this call, captured, never sent. */
async function capture(
  task: TaskKey,
  schema: z.ZodType,
  system: string,
  cacheBreak: number,
): Promise<Record<string, unknown>> {
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
  await runStructured(deps, task, {
    system,
    cacheBreak,
    prompt: 'Return the result.',
    schema,
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

/** The one-character message alone, per model: subtracted from every count on that model. */
const baselines = new Map<string, number>();

/**
 * One call's prefix: characters, and with a key its tokens alone and with the schema. The prefix
 * counted is checked against the request the router would send.
 */
async function measure(
  task: TaskKey,
  schema: z.ZodType,
  split: { system: string; cacheBreak: number },
): Promise<{ chars: number; schemaChars: number; tokens?: number; withSchema?: number }> {
  const captured = await capture(task, schema, split.system, split.cacheBreak);
  const prefix = split.system.slice(0, split.cacheBreak);
  if (!systemText(captured).startsWith(prefix)) fail('The captured system prompt differs.');
  const bodies = prefixCountBodies(captured, prefix);
  const schemaChars = JSON.stringify(bodies.prefixWithSchema['output_config'] ?? '').length;
  if (key === undefined) return { chars: prefix.length, schemaChars };
  const model = String(captured['model']);
  let baseline = baselines.get(model);
  if (baseline === undefined) {
    baseline = await count(key, bodies.baseline);
    baselines.set(model, baseline);
  }
  return {
    chars: prefix.length,
    schemaChars,
    tokens: (await count(key, bodies.prefix)) - baseline,
    withSchema: (await count(key, bodies.prefixWithSchema)) - baseline,
  };
}

const row = (cells: (string | number | undefined)[]): void => {
  process.stdout.write(`${cells.map((c) => String(c ?? '')).join(' | ')}\n`);
};

async function main(): Promise<void> {
  const { rank, tags } = defaults();

  // The control: the tags prefix qa measured live. Like for like, or nothing.
  const LIVE_TAGS_CHARS = 14_531;
  const LIVE_TAGS_CACHE_WRITE = 6_472;
  const tagsSplit = systemWithCacheBreak(tags, {
    naics_table: NAICS_TABLE_TEXT,
    companies_untrusted: 'A company.',
  });
  if (tagsSplit.cacheBreak !== LIVE_TAGS_CHARS) {
    fail(
      `The tags prefix is ${tagsSplit.cacheBreak} characters, not the ${LIVE_TAGS_CHARS} measured live.`,
    );
  }
  const tagsPolicy = resolvePolicy('discovery.company_tags', undefined);
  const t = await measure('discovery.company_tags', CompanyTagsOutputSchema, tagsSplit);
  process.stdout.write(`Control: discovery.company_tags on ${tagsPolicy.model}\n`);
  row(['prefix chars', 'schema chars', 'prefix tokens', '+ schema tokens', 'live cache write']);
  row([t.chars, t.schemaChars, t.tokens, t.withSchema, LIVE_TAGS_CACHE_WRITE]);
  if (t.tokens !== undefined && t.withSchema !== undefined) {
    const off = Math.abs(t.tokens - LIVE_TAGS_CACHE_WRITE);
    const offWith = Math.abs(t.withSchema - LIVE_TAGS_CACHE_WRITE);
    process.stdout.write(
      `The live write is ${off} tokens from the prefix alone and ${offWith} from the prefix with the schema.\n`,
    );
  }

  const policy = resolvePolicy('discovery.rank', undefined);
  const min = cacheMinTokens(policy.provider, policy.model);
  process.stdout.write(
    `\ndiscovery.rank on ${policy.model}; cache minimum ${String(min)} tokens\n`,
  );
  row([
    'template',
    'role target',
    'prefix chars',
    'schema chars',
    'prefix tokens',
    '+ schema tokens',
  ]);
  const templates = [
    { label: 'default as migrated', body: rank },
    { label: 'Output before Posting', body: outputBeforePosting(rank) },
  ];
  for (const tpl of templates) {
    for (const rt of ROLE_TARGETS) {
      const r = await measure(
        'discovery.rank',
        RankOutputSchema,
        systemWithCacheBreak(tpl.body, { role_target: rt.text, posting_untrusted: POSTING }),
      );
      row([tpl.label, rt.label, r.chars, r.schemaChars, r.tokens, r.withSchema]);
    }
  }
}

// Anything unexpected (a network error, a timeout) prints its name only: an error's message or
// stack could carry part of a request.
await main().catch((err: unknown) => {
  fail(`Stopped: ${err instanceof Error ? err.name : 'unknown error'}.`);
});
