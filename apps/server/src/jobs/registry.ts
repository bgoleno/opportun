// Job handlers by kind (design section 8). Handlers register once at module load; the
// runner looks them up when it claims a job.
import type { FastifyBaseLogger } from 'fastify';
import type { z } from 'zod';
import type { DocumentStore } from '../adapters/documentStore';
import type { MailProvider } from '../adapters/mailProvider';
import type { Db } from '../db/client';
import type { safeFetch } from '../lib/safeFetch';
import type { Storage } from '../lib/storage';

/** App services a handler may need; the runner passes what the app was built with. */
export interface JobServices {
  storage: Storage;
  documentStore: DocumentStore;
  /** The Reactive Resume store, alongside documentStore (#19): a handler that registers an
   * existing document resolves which one to use per user (readDocumentStorePref), the same
   * way POST /resumes does, rather than always registering through Google. */
  reactiveResumeStore: DocumentStore;
  /** Gmail (or a fake in tests); read-only. */
  mailProvider: MailProvider;
  /** The SSRF-safe fetch discovery adapters use (tests substitute a recording fake). */
  sourceFetch: typeof safeFetch;
  log: FastifyBaseLogger;
  /** The demo reset job's credentials source (issue #280); real process.env in production,
   *  a literal object in tests (#292). */
  env: NodeJS.ProcessEnv;
}

/** Per-run context, passed as the third argument to run(). */
export interface JobContext {
  jobId: string;
  /** The user the job acts for; null for instance jobs (backups). */
  userId: string | null;
  /** 1 on the first run, 2 on the first retry, and so on. */
  attempt: number;
  /** This job row's attempt budget (handler.maxAttempts at enqueue time): attempt >= maxAttempts
   * means the runner marks it dead if this run also fails, which a handler can act on. */
  maxAttempts: number;
  services: Partial<JobServices>;
  /** Stores progress or an outcome on the job row (jobs.result). */
  setResult(value: unknown): Promise<void>;
}

export interface JobHandler<P> {
  kind: string;
  payloadSchema: z.ZodType<P>;
  maxAttempts: number;
  run(db: Db, payload: P, ctx: JobContext): Promise<void>;
  /**
   * Payload fields that carry content the app does not keep, removed from the stored row when
   * the job finishes (done or dead). `comms.classify` carries the message body this way: the
   * body is not persisted anywhere else, so the job row must not become the copy that outlives
   * it. The rest of the payload stays, because the job row is the record that it ran.
   */
  transientPayloadKeys?: readonly string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- handlers carry their own payload types
const handlers = new Map<string, JobHandler<any>>();

/** Registers (or replaces) the handler for handler.kind. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see handlers
export function registerJob(handler: JobHandler<any>): void {
  handlers.set(handler.kind, handler);
}

export function unregisterJob(kind: string): void {
  handlers.delete(kind);
}

export function getJobHandler(kind: string): JobHandler<unknown> | undefined {
  return handlers.get(kind);
}

/** A service the handler cannot run without; throws (so the job retries) when missing. */
export function requireService<K extends keyof JobServices>(
  ctx: JobContext,
  name: K,
): JobServices[K] {
  // eslint-disable-next-line security/detect-object-injection -- name is a typed key
  const service = ctx.services[name];
  if (service === undefined) throw new Error(`job service unavailable: ${name}`);
  return service as JobServices[K];
}
