// Discovery source adapters (FR-D1) and their registry. An adapter turns one configured source
// (an ATS board, an MCP tool, alert mail) into NormalizedPosting values. Adapters return RAW
// values: the engine (jobs/discoveryRun.ts) runs sanitizePosting on every posting before it is
// stored or handed to anything else. Network access goes only through sctx.fetch (safeFetch).
//
// Two registry layers: built-ins (the shipped adapters register at module load with
// registerBuiltinSource) and overrides (registerSource: tests and the end-to-end source mock
// replace a kind). getSource prefers an override; resetSources drops every override so the
// built-ins come back.
import type { DiscoverySourceKind, NormalizedPosting } from '@opportun/core';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { safeFetch } from '../lib/safeFetch';
import { McpConfigSchema } from './sources/mcpConfig';

export type SourceKind = DiscoverySourceKind;

export interface SourceContext {
  fetch: typeof safeFetch;
  log: FastifyBaseLogger;
  /**
   * The externalIds among `ids` that this source has already stored. The discovery engine sets
   * it for a run; elsewhere (a one-off board lookup) it is absent and nothing counts as known.
   * An adapter that pays per posting for its description (Workday) skips known ones.
   */
  knownExternalIds?: (ids: readonly string[]) => Promise<ReadonlySet<string>>;
}

export interface DiscoverySource {
  kind: SourceKind;
  /**
   * Yields postings from `cursor` on (null: from the start). Each item carries the cursor to
   * resume after it, so an interrupted run can continue where it stopped.
   */
  fetchPostings(
    sctx: SourceContext,
    config: unknown,
    cursor: unknown | null,
  ): AsyncIterable<{ posting: NormalizedPosting; nextCursor: unknown | null }>;
}

/** No adapter is registered for a kind (a run of such a source fails with this). */
export class UnknownSourceError extends Error {
  override name = 'UnknownSourceError';
  constructor(readonly kind: string) {
    super(`no discovery source adapter registered for kind ${kind}`);
  }
}

/**
 * The source's configuration is wrong in a way no retry can fix (an ATS org the provider does not
 * know, an invalid config, an MCP tool that does not exist). The engine records it on the run and
 * the source and finishes the job without rethrowing, so the runner does not retry it.
 */
export class SourceConfigError extends Error {
  override name = 'SourceConfigError';
}

const builtins = new Map<SourceKind, DiscoverySource>();
const overrides = new Map<SourceKind, DiscoverySource>();

/** Registers (or replaces) the adapter for src.kind. Overrides any built-in until reset. */
export function registerSource(src: DiscoverySource): void {
  overrides.set(src.kind, src);
}

/** Registers a shipped adapter: what getSource returns when no override is set. */
export function registerBuiltinSource(src: DiscoverySource): void {
  builtins.set(src.kind, src);
}

/** Drops every override (tests call this in afterEach); built-ins stay. */
export function resetSources(): void {
  overrides.clear();
}

export function hasSource(kind: SourceKind): boolean {
  return overrides.has(kind) || builtins.has(kind);
}

export function getSource(kind: SourceKind): DiscoverySource {
  const src = overrides.get(kind) ?? builtins.get(kind);
  if (src === undefined) throw new UnknownSourceError(kind);
  return src;
}

// ---------------------------------------------------------------------------
// Per-kind configuration (validated on create and update)

/** An ATS board slug, as the board's public API names it. */
export const AtsConfig = z.object({ org: z.string().regex(/^[a-z0-9-]{1,100}$/) }).strict();

/**
 * A Workday career site's host: `<tenant>.<datacenter>.myworkdayjobs.com`. The datacenter label
 * (`wd1`, `wd5`, `wd12`) is part of the host and cannot be derived from the tenant, so a board
 * is only ever learned from a URL that carries it (FR-D10).
 */
export const WORKDAY_HOST = /^([a-z0-9][a-z0-9-]{0,62})\.wd[0-9]{1,3}\.myworkdayjobs\.com$/;
/** A Workday site id as it appears in the path (`Initech_Careers`, `globexexternalcareers`). */
export const WORKDAY_SITE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

/** A Workday board: the tenant's host (with its datacenter), the tenant and the site. */
export const WorkdayConfig = z
  .object({
    host: z.string().regex(WORKDAY_HOST),
    tenant: z.string(),
    site: z.string().regex(WORKDAY_SITE),
  })
  .strict()
  .refine((c) => WORKDAY_HOST.exec(c.host)?.[1] === c.tenant, {
    message: 'tenant must be the first label of the host',
  });
export type WorkdayConfig = z.infer<typeof WorkdayConfig>;

export const SOURCE_CONFIG_SCHEMAS: Record<SourceKind, z.ZodType<Record<string, unknown>>> = {
  ats_greenhouse: AtsConfig,
  ats_lever: AtsConfig,
  ats_ashby: AtsConfig,
  ats_workday: WorkdayConfig,
  mcp: McpConfigSchema,
  alert_email: z.object({}).strict(),
  manual: z.object({}).strict(),
  extension: z.object({}).strict(),
};

/** Kinds whose sources poll a company's applicant-tracking board. */
export const ATS_SOURCE_KINDS: readonly SourceKind[] = [
  'ats_greenhouse',
  'ats_lever',
  'ats_ashby',
  'ats_workday',
];
