// Wires the IO-free router in @opportun/ai to this server: keys from the secrets vault,
// per-user policy overrides and budget from settings, and the task_runs ledger. One AiDeps
// is built per request for the signed-in user, so every AI call is user-scoped.
import {
  AiUnavailableError,
  ModelPolicySchema,
  resolvePolicy,
  type AiDeps,
  type ModelPolicy,
  type TaskKey,
} from '@opportun/ai';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Exec } from '../db/client';
import { secrets, settings } from '../db/schema';
import type { UserCtx } from '../repos/base';
import { recordTaskRun, spentTodayUsd } from '../repos/taskRuns';
import { createProviderFetch, type ResolveHost } from './aiProviderFetch';
import { getSecretValue } from './secretBox';

export const DEFAULT_PER_TASK_DAILY_USD = 5;

export const policyKey = (task: TaskKey, userId: string): string => `ai_policy:${task}:${userId}`;
export const budgetKey = (userId: string): string => `ai_budget:${userId}`;

const BudgetSchema = z.object({ perTaskDailyUsd: z.number().nonnegative().max(10_000) });

export async function readSetting(db: Db, ctx: UserCtx, key: string): Promise<unknown> {
  return (
    await db
      .select({ value: settings.value })
      .from(settings)
      .where(and(eq(settings.key, key), eq(settings.userId, ctx.userId)))
      .get()
  )?.value;
}

export async function writeSetting(
  db: Exec,
  ctx: UserCtx,
  key: string,
  value: unknown,
): Promise<void> {
  const now = Date.now();
  await db
    .insert(settings)
    .values({ key, userId: ctx.userId, value, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
    .run();
}

/** The caller's stored override for a task; null when unset or no longer valid. */
export async function readPolicyOverride(
  db: Db,
  ctx: UserCtx,
  task: TaskKey,
): Promise<ModelPolicy | null> {
  const parsed = ModelPolicySchema.safeParse(
    await readSetting(db, ctx, policyKey(task, ctx.userId)),
  );
  return parsed.success ? parsed.data : null;
}

export async function writePolicyOverride(
  db: Db,
  ctx: UserCtx,
  task: TaskKey,
  policy: ModelPolicy,
): Promise<void> {
  await writeSetting(db, ctx, policyKey(task, ctx.userId), policy);
}

export async function deletePolicyOverride(db: Db, ctx: UserCtx, task: TaskKey): Promise<void> {
  await db
    .delete(settings)
    .where(and(eq(settings.key, policyKey(task, ctx.userId)), eq(settings.userId, ctx.userId)))
    .run();
}

export async function readBudget(db: Db, ctx: UserCtx): Promise<{ perTaskDailyUsd: number }> {
  const parsed = BudgetSchema.safeParse(await readSetting(db, ctx, budgetKey(ctx.userId)));
  return {
    perTaskDailyUsd: parsed.success ? parsed.data.perTaskDailyUsd : DEFAULT_PER_TASK_DAILY_USD,
  };
}

/**
 * The caller's API key for a provider: the newest ai_api_key secret labelled with the
 * provider id. The plaintext goes only to the router, which hands it to that provider's client.
 */
async function getProviderKey(db: Db, ctx: UserCtx, provider: string): Promise<string> {
  const row = await providerKeyRow(db, ctx, provider);
  if (row === undefined) throw new AiUnavailableError('no_key');
  return getSecretValue(db, ctx, row.id);
}

/** The newest ai_api_key row for a provider (the one AI calls use). */
async function providerKeyRow(
  db: Db,
  ctx: UserCtx,
  provider: string,
): Promise<{ id: string; expiresAt: number | null } | undefined> {
  return await db
    .select({ id: secrets.id, expiresAt: secrets.expiresAt })
    .from(secrets)
    .where(
      and(
        eq(secrets.userId, ctx.userId),
        eq(secrets.kind, 'ai_api_key'),
        eq(secrets.label, provider),
      ),
    )
    .orderBy(desc(secrets.createdAt), desc(secrets.id))
    .get();
}

/**
 * For a provider_error: "the stored key expired on <date>" when the key the task used has a
 * user-entered expiry in the past, so an expired key does not fail opaquely. Else undefined.
 */
export async function expiredKeyHint(
  db: Db,
  ctx: UserCtx,
  task: TaskKey,
  err: AiUnavailableError,
  now: number = Date.now(),
): Promise<string | undefined> {
  if (err.reason !== 'provider_error') return undefined;
  const policy = await (await buildAiDeps(db, ctx)).policyFor(task);
  const expiresAt = (await providerKeyRow(db, ctx, policy.provider))?.expiresAt ?? null;
  if (expiresAt === null || expiresAt > now) return undefined;
  return `the stored key expired on ${new Date(expiresAt).toISOString().slice(0, 10)}`;
}

/**
 * Replaces where AI calls go for one app's database: the policy (provider, model, endpoint)
 * and the key. Only the end-to-end mock (src/testSupport, OPPORTUN_AI_MOCK=1) sets one; the
 * budget, prompts and the task_runs ledger still run as usual.
 */
export interface AiOverride {
  policyFor(task: TaskKey): ModelPolicy;
  getKey(provider: string): string;
}

const overrides = new WeakMap<Db, AiOverride>();

/** Binds an override to an app's database handle (see AiOverride). */
export function setAiOverride(db: Db, override: AiOverride): void {
  overrides.set(db, override);
}

/**
 * Replaces providerFetch's DNS resolution for one app's database (issue #334), independent of
 * AiOverride above: a test exercising a real openai_compatible baseUrl through the full route
 * layer still wants its own policy/key lookups to hit the real database, it just cannot depend
 * on a fixture hostname (an RFC 2606 host such as llm.example.com, this project's own
 * convention for a value that must never resolve) actually resolving. Real callers never set
 * this, so production always uses real DNS (lib/aiProviderFetch.ts's own default).
 */
const resolveOverrides = new WeakMap<Db, ResolveHost>();

export function setProviderResolveOverride(db: Db, resolve: ResolveHost): void {
  resolveOverrides.set(db, resolve);
}

/**
 * Whether the caller can run AI tasks at all: they stored an ai_api_key (any provider), or
 * the end-to-end mock redirects every call. Says nothing about budget or the key's health.
 */
export async function aiAvailable(db: Db, ctx: UserCtx): Promise<boolean> {
  if (overrides.has(db)) return true;
  return (
    (await db
      .select({ id: secrets.id })
      .from(secrets)
      .where(and(eq(secrets.userId, ctx.userId), eq(secrets.kind, 'ai_api_key')))
      .get()) !== undefined
  );
}

/**
 * `onRecorded` receives the task_runs id of every recorded run (tailoring keeps them).
 *
 * `allowLoopbackHttp` overrides the operator's OPPORTUN_AI_ALLOW_LOOPBACK_HTTP read (issue
 * #334): every real caller leaves it unset, so production always reads the real flag; a test
 * passes a literal boolean instead of mutating process.env, the same reasoning
 * demoReset.ts/seedDemo.ts already use for their own env-sourced flags (vitest's threads pool
 * shares process.env across files scheduled onto the same worker, so mutating it is a
 * cross-file hazard, not only a style preference). Config.aiAllowLoopbackHttp (config.ts) is
 * the same env var read once at boot, for routes/ai.ts's policy-submit validation, which has
 * app.config in scope and this function does not; both ultimately read the one real flag, so
 * they can never disagree in production.
 */
export async function buildAiDeps(
  db: Db,
  ctx: UserCtx,
  opts: {
    onRecorded?: (runId: string) => Promise<void> | void;
    allowLoopbackHttp?: boolean;
  } = {},
): Promise<AiDeps> {
  const override = overrides.get(db);
  // An AiOverride (the end-to-end mock, testSupport/mockAi.ts) always points its policy at
  // this same process's own loopback (never production: that module's own header comment),
  // so it needs the allowance regardless of the operator's real flag -- the mock's existence
  // at all is already a stronger signal than any env var, the same reasoning aiAvailable above
  // already uses (overrides.has(db) alone answers its own question).
  const allowLoopbackHttp =
    override !== undefined ||
    (opts.allowLoopbackHttp ?? process.env.OPPORTUN_AI_ALLOW_LOOPBACK_HTTP === '1');
  return {
    getKey: async (provider) =>
      override === undefined ? getProviderKey(db, ctx, provider) : override.getKey(provider),
    policyFor: async (task) =>
      override === undefined
        ? resolvePolicy(task, await readPolicyOverride(db, ctx, task))
        : override.policyFor(task),
    record: async (run) => {
      const id = await recordTaskRun(db, ctx, run);
      await opts.onRecorded?.(id);
    },
    budget: await readBudget(db, ctx),
    spentTodayUsd: async (task) => await spentTodayUsd(db, ctx, task),
    providerFetch: {
      fetch: createProviderFetch({ allowLoopbackHttp }, resolveOverrides.get(db)),
      allowLoopbackHttp,
    },
  };
}
