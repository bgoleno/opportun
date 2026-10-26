// AI provider key validation: is the key accepted, and can it reach every model the user's
// effective policies (defaults overlaid with their overrides) name for that provider?
// These probes are not tasks: they bypass the task budget and write no task_runs. The key is
// only ever sent to its own provider and never appears in a result, an error or a log line.
import {
  assertSafeBaseUrl,
  DEFAULT_POLICIES,
  PROVIDERS,
  pingModel,
  sanitizeDetail,
  TASK_KEYS,
  type ModelPolicy,
  type ProviderFetchOptions,
  type ProviderId,
} from '@opportun/ai';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { secrets, settings } from '../db/schema';
import type { UserCtx } from '../repos/base';
import { buildAiDeps, readSetting, writeSetting } from './ai';
import { notFound } from './errors';
import { getSecretValue } from './secretBox';

export interface ModelCheck {
  model: string;
  ok: boolean;
  error: string | null;
}

export interface KeyValidation {
  ok: boolean;
  provider: string;
  models: ModelCheck[];
  /**
   * When the key itself expires. Always null today: no supported provider exposes a key's
   * expiry to the key itself (it is visible only in the provider console), so this is
   * plumbing for when one does.
   */
  expiresAt: number | null;
  checkedAt: number;
  error: string | null;
}

export const ModelCheckSchema = z.object({
  model: z.string(),
  ok: z.boolean(),
  error: z.string().nullable(),
});

export const KeyValidationSchema = z.object({
  ok: z.boolean(),
  provider: z.string(),
  models: z.array(ModelCheckSchema),
  expiresAt: z.number().int().nullable(),
  checkedAt: z.number().int(),
  error: z.string().nullable(),
}) satisfies z.ZodType<KeyValidation>;

const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';
const LIST_TIMEOUT_MS = 15_000;
const MAX_LIST_BYTES = 5 * 1024 * 1024;
const UNVERIFIABLE = 'unverifiable: endpoint has no model list';
const NOT_LISTED = 'model not available to this key';

const isProvider = (id: string): id is ProviderId => (PROVIDERS as readonly string[]).includes(id);

export const keyValidationKey = (secretId: string, userId: string): string =>
  `key_validation:${secretId}:${userId}`;

// ---------------------------------------------------------------------------
// Policies

/** Distinct models (and, for openai_compatible, endpoints) the user's policies name. */
async function referencedPolicies(
  db: Db,
  ctx: UserCtx,
  provider: ProviderId,
): Promise<ModelPolicy[]> {
  // providerFetch is unused here (this only reads policies); validateAiKey builds its own.
  const deps = await buildAiDeps(db, ctx);
  const seen = new Set<string>();
  const out: ModelPolicy[] = [];
  for (const task of TASK_KEYS) {
    const policy = await deps.policyFor(task);
    if (policy.provider !== provider) continue;
    const id = `${policy.baseUrl ?? ''}\n${policy.model}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(policy);
  }
  return out;
}

/** A cheap default model to probe an Anthropic key with when no policy names one. */
function probeModel(provider: ProviderId): string | undefined {
  // eslint-disable-next-line security/detect-object-injection -- t is a TaskKey literal
  const models = TASK_KEYS.map((t) => DEFAULT_POLICIES[t])
    .filter((p) => p.provider === provider)
    .map((p) => p.model);
  return models.find((m) => m.includes('haiku')) ?? models[0];
}

// ---------------------------------------------------------------------------
// Model lists (openai, openai_compatible)

type ListResult =
  | { kind: 'ok'; ids: Set<string> }
  | { kind: 'auth'; error: string }
  | { kind: 'unlisted' }
  | { kind: 'error'; error: string };

const ModelList = z.object({ data: z.array(z.object({ id: z.string() })) });

async function listModels(
  url: string,
  apiKey: string,
  providerFetch: typeof fetch,
): Promise<ListResult> {
  let res: Response;
  try {
    res = await providerFetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      // The key must never follow a redirect to another host.
      redirect: 'error',
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
  } catch (err) {
    const raw = err instanceof Error ? err.message : 'request failed';
    return { kind: 'error', error: sanitizeDetail(raw, apiKey) || 'request failed' };
  }
  let text: string;
  try {
    text = await res.text();
  } catch {
    text = '';
  }
  if (res.status === 401 || res.status === 403) {
    return {
      kind: 'auth',
      error: sanitizeDetail(`HTTP ${res.status}: ${text}`, apiKey) || `HTTP ${res.status}`,
    };
  }
  if (res.status === 404 || res.status === 405) return { kind: 'unlisted' };
  if (!res.ok) {
    return {
      kind: 'error',
      error: sanitizeDetail(`HTTP ${res.status}: ${text}`, apiKey) || `HTTP ${res.status}`,
    };
  }
  if (text.length > MAX_LIST_BYTES) return { kind: 'unlisted' };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: 'unlisted' };
  }
  const parsed = ModelList.safeParse(json);
  if (!parsed.success) return { kind: 'unlisted' };
  return { kind: 'ok', ids: new Set(parsed.data.data.map((m) => m.id)) };
}

function membership(models: string[], list: ListResult): ModelCheck[] {
  return models.map((model) => {
    switch (list.kind) {
      case 'ok':
        return list.ids.has(model)
          ? { model, ok: true, error: null }
          : { model, ok: false, error: NOT_LISTED };
      case 'unlisted':
        return { model, ok: false, error: UNVERIFIABLE };
      case 'auth':
        return { model, ok: false, error: 'key rejected' };
      case 'error':
        return { model, ok: false, error: 'not checked: provider unreachable' };
    }
  });
}

async function validateOpenAi(
  apiKey: string,
  policies: ModelPolicy[],
  providerFetch: ProviderFetchOptions,
): Promise<Pick<KeyValidation, 'ok' | 'models' | 'error'>> {
  const list = await listModels(OPENAI_MODELS_URL, apiKey, providerFetch.fetch);
  const models = membership(
    policies.map((p) => p.model),
    list,
  );
  if (list.kind === 'auth' || list.kind === 'error')
    return { ok: false, models, error: list.error };
  if (list.kind === 'unlisted') return { ok: false, models, error: 'model list unavailable' };
  return { ok: true, models, error: null };
}

async function validateCompatible(
  apiKey: string,
  policies: ModelPolicy[],
  providerFetch: ProviderFetchOptions,
): Promise<Pick<KeyValidation, 'ok' | 'models' | 'error'>> {
  const byEndpoint = new Map<string, string[]>();
  for (const p of policies) {
    const base = p.baseUrl ?? '';
    byEndpoint.set(base, [...(byEndpoint.get(base) ?? []), p.model]);
  }
  if (byEndpoint.size === 0) {
    return {
      ok: false,
      models: [],
      error: 'unverifiable: no model policy uses an OpenAI-compatible endpoint yet',
    };
  }
  const models: ModelCheck[] = [];
  let error: string | null = null;
  for (const [base, names] of byEndpoint) {
    let url: string;
    try {
      url = `${assertSafeBaseUrl(base, providerFetch)}/models`;
    } catch (err) {
      const msg = sanitizeDetail(err instanceof Error ? err.message : 'invalid baseUrl', apiKey);
      for (const model of names) models.push({ model, ok: false, error: msg });
      error ??= msg;
      continue;
    }
    const list = await listModels(url, apiKey, providerFetch.fetch);
    models.push(...membership(names, list));
    // A list that is not there (or not in the standard shape) says nothing against the key.
    if (list.kind === 'auth' || list.kind === 'error') error ??= list.error;
  }
  return { ok: error === null, models, error };
}

// ---------------------------------------------------------------------------
// Anthropic: no free endpoint, so one 1-token message per distinct model

// An organization-scoped key authenticates but every model call fails with Anthropic's
// documented "not scoped to a workspace" error. Label that class so the UI names it.
const WORKSPACE_SCOPE_PHRASE = 'not scoped to a workspace';

function workspaceScoped(error: string): string {
  return error.toLowerCase().includes(WORKSPACE_SCOPE_PHRASE)
    ? `workspace scoping: ${error}`
    : error;
}

async function validateAnthropic(
  apiKey: string,
  policies: ModelPolicy[],
  providerFetch: ProviderFetchOptions,
): Promise<Pick<KeyValidation, 'ok' | 'models' | 'error'>> {
  const names = policies.map((p) => p.model);
  if (names.length === 0) {
    const probe = probeModel('anthropic');
    if (probe !== undefined) names.push(probe);
  }
  const models: ModelCheck[] = [];
  let authenticated = false;
  let firstError: string | null = null;
  for (const [i, model] of names.entries()) {
    const out = await pingModel('anthropic', model, apiKey, providerFetch);
    if (out.ok) {
      authenticated = true;
      models.push({ model, ok: true, error: null });
      continue;
    }
    const error = workspaceScoped(out.error);
    firstError ??= error;
    // A model-level refusal (404, 403, 429...) still means the key authenticated.
    if (out.kind === 'model') authenticated = true;
    models.push({ model, ok: false, error });
    if (out.kind === 'auth' && i === 0) {
      // The key itself was rejected: the remaining models would only repeat it.
      for (const rest of names.slice(1)) {
        models.push({ model: rest, ok: false, error: 'not checked: key rejected' });
      }
      return { ok: false, models, error };
    }
  }
  return { ok: authenticated, models, error: authenticated ? null : firstError };
}

// ---------------------------------------------------------------------------
// Entry points

/** Validates the caller's own ai_api_key secret; 404 HttpError when missing or not theirs. */
export async function validateAiKey(
  db: Db,
  ctx: UserCtx,
  secretId: string,
): Promise<KeyValidation> {
  const row = await db
    .select({ id: secrets.id, label: secrets.label })
    .from(secrets)
    .where(
      and(eq(secrets.id, secretId), eq(secrets.userId, ctx.userId), eq(secrets.kind, 'ai_api_key')),
    )
    .get();
  if (row === undefined) throw notFound();

  const provider = row.label;
  const base = { provider, expiresAt: null, checkedAt: Date.now() };
  if (!isProvider(provider)) {
    return { ...base, ok: false, models: [], error: 'key is not linked to a provider' };
  }
  const apiKey = await getSecretValue(db, ctx, row.id);
  const policies = await referencedPolicies(db, ctx, provider);
  const providerFetch = (await buildAiDeps(db, ctx)).providerFetch;
  try {
    const result =
      provider === 'anthropic'
        ? await validateAnthropic(apiKey, policies, providerFetch)
        : provider === 'openai'
          ? await validateOpenAi(apiKey, policies, providerFetch)
          : await validateCompatible(apiKey, policies, providerFetch);
    return { ...base, ...result, checkedAt: Date.now() };
  } catch (err) {
    // Never a 500 for a provider problem: report it as a failed check.
    const raw = err instanceof Error ? err.message : 'validation failed';
    return {
      ...base,
      ok: false,
      models: [],
      error: sanitizeDetail(raw, apiKey) || 'validation failed',
      checkedAt: Date.now(),
    };
  }
}

/** Validates and stores the result under key_validation:<secretId>:<userId>. */
export async function validateAndStoreAiKey(
  db: Db,
  ctx: UserCtx,
  secretId: string,
): Promise<KeyValidation> {
  const result = await validateAiKey(db, ctx, secretId);
  await writeSetting(db, ctx, keyValidationKey(secretId, ctx.userId), result);
  return result;
}

/** The last stored validation for one of the caller's keys, or null. */
export async function readKeyValidation(
  db: Db,
  ctx: UserCtx,
  secretId: string,
): Promise<KeyValidation | null> {
  const parsed = KeyValidationSchema.safeParse(
    await readSetting(db, ctx, keyValidationKey(secretId, ctx.userId)),
  );
  return parsed.success ? parsed.data : null;
}

export async function deleteKeyValidation(db: Db, ctx: UserCtx, secretId: string): Promise<void> {
  await db
    .delete(settings)
    .where(
      and(
        eq(settings.key, keyValidationKey(secretId, ctx.userId)),
        eq(settings.userId, ctx.userId),
      ),
    )
    .run();
}
