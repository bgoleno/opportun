import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from './config';
import { closeDatabase, connectDatabase, pingDatabase, type Db } from './db/client';
import { configureGateWatchdog } from './db/gate';
import { SCHEMA_DIALECT } from './db/schema';
import { securityPlugin } from './plugins/security';
import { sessionPlugin } from './plugins/session';
import {
  createGoogleConn,
  GOOGLE_CALLBACK_PATH,
  realGoogleApi,
  type GoogleApi,
  type GoogleConn,
} from './lib/google';
import { setAiOverride, type AiOverride } from './lib/ai';
import { bindVaultKey } from './lib/secretBox';
import { OAUTH_PROVIDERS, oauthCallbackPath } from './lib/oauthProviders';
import type { DocumentStore } from './adapters/documentStore';
import { createGoogleDocsStore } from './adapters/googleDocs';
import { createLocalFileStore } from './adapters/localFile';
import { createReactiveResumeStore, readRrConfig } from './adapters/reactiveResume';
import { createGmailProvider } from './adapters/gmail';
import { safeFetch } from './lib/safeFetch';
import { createStorage, type Storage } from './lib/storage';
import { checkSqliteFilesystem, type FilesystemHazard } from './lib/sqliteFilesystem';
import './adapters/sources/index';
import './jobs/index';
import type { JobServices } from './jobs/registry';
import { ATS_REVERIFY_CRON, ATS_REVERIFY_KIND } from './jobs/atsDetect';
import { ATTACHMENT_SWEEP_CRON, ATTACHMENT_SWEEP_JOB_KIND } from './jobs/attachmentSweep';
import { BACKUP_CRON, BACKUP_JOB_KIND } from './jobs/backup';
import { DEMO_RESET_CRON, DEMO_RESET_JOB_KIND } from './jobs/demoReset';
import { JOB_PRUNE_CRON, JOB_PRUNE_JOB_KIND } from './jobs/jobPrune';
import {
  DB_INTEGRITY_CHECK_CRON,
  DB_INTEGRITY_CHECK_CRON_POSTGRES,
  DB_INTEGRITY_CHECK_KIND,
  readLiveCheck,
  type LiveCheckResult,
} from './jobs/dbIntegrityCheck';
import { COMPANY_SUGGEST_CRON, COMPANY_SUGGEST_KIND } from './jobs/companySuggest';
import { connectorMailRoutes } from './routes/connectorMail';
import { GMAIL_SYNC_ALL_CRON, GMAIL_SYNC_ALL_KIND } from './jobs/gmailSync';
import { REFINE_CRON, REFINE_JOB_KIND } from './jobs/refineClassifyPrompt';
import { DISCOVERY_REFINE_CRON, DISCOVERY_REFINE_KIND } from './jobs/refineDiscoveryPrompt';
import { enqueueRepairAlertLeadsOnce } from './jobs/repairAlertLeads';
import { enqueueRepairDedupeKeysOnce } from './jobs/repairDedupeKeys';
import { enqueueRepairCompanyMatchKeysOnce } from './jobs/companyMatchKeyRepair';
import { enqueueCompanyDomainBackfillOnce } from './jobs/companyDomainResolve';
import { OPPORTUNITY_DEDUPE_AI_CRON, OPPORTUNITY_DEDUPE_AI_KIND } from './jobs/opportunityDedupeAi';
import { RETRY_WORKDAY_CAPTURE_CRON, RETRY_WORKDAY_CAPTURE_KIND } from './jobs/retryWorkdayCapture';
import { queueLagMs, runDueJobs, seedSchedule, startRunner, type Runner } from './jobs/runner';
import { activityRoutes } from './routes/activities';
import { aiRoutes } from './routes/ai';
import { attachmentRoutes } from './routes/attachments';
import { backupRoutes } from './routes/backups';
import { authRoutes } from './routes/auth';
import { captureRoutes } from './routes/capture';
import { connectorCaptureRoutes } from './routes/connectorCapture';
import { communicationRoutes } from './routes/communications';
import { companyRoutes } from './routes/companies';
import { companySuggestionRoutes } from './routes/companySuggestions';
import { contactRoutes } from './routes/contacts';
import { dashboardRoutes } from './routes/dashboard';
import { deviceTokenRoutes } from './routes/deviceTokens';
import { discoveryRoutes } from './routes/discovery';
import { googleAuthRoutes } from './routes/googleAuth';
import { integrationsMailRoutes } from './routes/integrationsMail';
import { importExportRoutes } from './routes/importExport';
import { jobRoutes } from './routes/jobs';
import { oauthLoginRoutes } from './routes/oauthLogin';
import { opportunityRoutes } from './routes/opportunities';
import { opportunityPostingRoutes } from './routes/opportunityPosting';
import { profileRoutes } from './routes/profile';
import { referralRoutes } from './routes/referrals';
import { reactiveResumeRoutes } from './routes/reactiveResume';
import { resumeRoutes } from './routes/resumes';
import { tailoringRoutes } from './routes/tailoring';
import { secretRoutes } from './routes/secrets';
import { mailFilterRoutes } from './routes/mailFilters';
import { settingsRoutes } from './routes/settings';
import { artifactRoutes } from './routes/artifacts';
import { hasSpaBuild, spaRoutes } from './routes/spa';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
    db: Db;
    /** Confined DATA_DIR access (NFR-SEC11); the only route to the filesystem. */
    storage: Storage;
    /** The network boundary to Google (a fake in tests). */
    google: GoogleApi;
    /** Authorized Google clients for the signed-in user. */
    googleConn: GoogleConn;
    /** Resume documents in Google Docs (store google_doc). */
    documentStore: DocumentStore;
    /** Resume documents in the user's Reactive Resume (store reactive_resume, FR-R7). */
    reactiveResumeStore: DocumentStore;
    /** Resume documents stored on this server (store local_file, #284). No external
     *  dependency, so unlike the other two stores there is nothing to fake in tests. */
    localFileStore: DocumentStore;
    /** Outbound fetch to Reactive Resume instances (a recorded fake in tests). */
    reactiveResumeFetch: typeof safeFetch;
    /** The job queue bound to this app's services. */
    jobs: AppJobs;
    /** Outbound fetch for the Google OAuth client probe (a fake in tests). */
    googleFetch: typeof safeFetch;
    /** OAuth sign-in: the provider token/userinfo fetch (a fake in tests). */
    oauth: OAuthWiring;
    /** The database directory's own filesystem, checked once at boot (issue #197); null on
     *  Postgres, or when the filesystem is not one WAL's locking is known to be unsafe on. */
    sqliteFsHazard: FilesystemHazard | null;
  }
}

export interface AppJobs {
  /** Runs every due job now (tests use this instead of the polling runner). */
  drain(): Promise<number>;
  services: JobServices;
}

/**
 * issue #205: on 2026-10-20 the owner's database was malformed for hours while this endpoint
 * answered an unqualified ok, because nothing connected the live-database check (#170) to the
 * one surface a monitor actually watches. 'corrupted' closes that gap -- but deliberately, not
 * via the obvious move of also answering 503 for it. Killing and restarting the process fixes
 * nothing here: the damage is on disk, a fresh process finds the exact same corrupt file, and
 * the #198 drill found the app keeps answering most requests completely normally throughout
 * (a restart denies everyone service over a problem most of them are not hitting). 503 stays
 * reserved for 'degraded': the database connection itself is unreachable, the one case a
 * restart could plausibly help. 200 with status: 'corrupted' is how this is surfaced instead,
 * on purpose: still alive, still serving, but a monitor reading the body (not just the status
 * code) now has what it needs to page a human rather than silently keep going, which is the
 * actual property this endpoint was missing.
 */
const HealthSchema = z.object({
  status: z.enum(['ok', 'degraded', 'corrupted']),
  db: z.enum(['ok', 'error']),
  queueLagMs: z.number().int().nonnegative(),
  /** The live database's most recent scheduled integrity check (jobs/dbIntegrityCheck.ts), or
   *  null when none has ever run: a fresh install, the first night, or Postgres, which has no
   *  scheduled equivalent (see that module's own comment for the deliberate reason). */
  databaseIntegrity: z
    .object({ ok: z.boolean(), checkedAt: z.number().int(), detail: z.string().nullable() })
    .nullable(),
});

/** A destination for log lines (tests capture output through this). */
export interface LogStream {
  write(msg: string): void;
}

/** The OAuth sign-in boundary (FR-S4): fakes in tests, the real providers otherwise. */
export interface OAuthWiring {
  fetch: typeof safeFetch;
}

export interface BuildOptions {
  logStream?: LogStream;
  /** Replaces the googleapis-backed client (tests inject a fake: no network). */
  google?: GoogleApi;
  /** Replaces the Google Docs document store. */
  documentStore?: DocumentStore;
  /** The polling job runner; false leaves it off (tests drain the queue explicitly). */
  jobRunner?: false | { intervalMs?: number };
  /** Redirects every AI call (the end-to-end mock provider; see src/testSupport). */
  ai?: AiOverride;
  /** Replaces the discovery fetch (the end-to-end source mock; see src/testSupport). */
  sourceFetch?: typeof safeFetch;
  /** Replaces the fetch behind the Google OAuth client probe (tests: no network). */
  googleFetch?: typeof safeFetch;
  /** Replaces the fetch to Reactive Resume instances (tests: the recorded fake). */
  rrFetch?: typeof safeFetch;
  /** Replaces the OAuth sign-in provider calls (tests: the fake provider). */
  oauth?: Partial<OAuthWiring>;
  /** The environment the demo reset job reads its credentials from (issue #280); defaults to
   *  process.env. Threaded through rather than read directly so a test can supply a literal
   *  object instead of mutating the real process.env (#292). */
  env?: NodeJS.ProcessEnv;
}

/** Pino redaction (NFR-SEC7): credentials never reach a log line. */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'password',
  'token',
  'apiKey',
  'ciphertext',
  '*.password',
  '*.token',
  '*.apiKey',
  '*.ciphertext',
];

/** Request urls whose query string carries credentials (the OAuth code and state). */
const QUERY_REDACTED_PATHS: ReadonlySet<string> = new Set([
  GOOGLE_CALLBACK_PATH,
  ...OAUTH_PROVIDERS.map(oauthCallbackPath),
]);

/** OPPORTUN_HOST values that answer this machine only, never another device (issue #24). */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1']);

/** The url as it may appear in a log line: credential-bearing query strings are dropped. */
export function loggedUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const q = url.indexOf('?');
  if (q === -1) return url;
  return QUERY_REDACTED_PATHS.has(url.slice(0, q)) ? `${url.slice(0, q)}?[redacted]` : url;
}

interface LoggableRequest {
  method?: string;
  url?: string;
  host?: string;
  ip?: string;
  headers?: Record<string, unknown>;
  socket?: { remotePort?: number };
}

/** Fastify's default request serializer, with the url passed through loggedUrl. */
function serializeReq(req: LoggableRequest): Record<string, unknown> {
  return {
    method: req.method,
    url: loggedUrl(req.url),
    version: req.headers?.['accept-version'],
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  };
}

/**
 * Builds the Fastify app: plugins, database (migrated), /healthz, the /api/v1 tree and,
 * when a build exists, the SPA.
 */
export async function buildApp(cfg: Config, opts: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: cfg.logLevel,
      redact: { paths: LOG_REDACT_PATHS, censor: '[redacted]' },
      serializers: { req: serializeReq },
      ...(opts.logStream === undefined ? {} : { stream: opts.logStream }),
    },
    // Trust X-Forwarded-* only from explicitly configured proxies (OPPORTUN_TRUSTED_PROXIES,
    // issue #333), empty by default. The previous ['loopback','linklocal','uniquelocal'] default
    // trusted every private-range peer, so on a bare-metal LAN install any client could spoof
    // X-Forwarded-For past the per-IP rate limits and forge audit_log.ip. Empty means req.ip and
    // req.protocol come from the socket; a proxied deployment (Caddy in deploy/) sets this to the
    // proxy's address/subnet, which also restores the X-Forwarded-Proto Secure-cookie derivation
    // (ADR-14, issue #23); the Compose deployment pins its subnet and sets this in
    // deploy/compose.yml.
    //
    // req.ip/req.ips walk the whole forwarded chain against every trustedProxies entry
    // (Fastify's proxy-addr-backed alladdrs()), but Fastify's host/protocol getters only check
    // that the DIRECT peer is trusted -- hop 0, not the full chain. That is fine here because
    // deploy/compose.yml is always single-hop (Caddy is always the direct peer; nothing else can
    // reach this container). If OPPORTUN_TRUSTED_PROXIES is ever reconfigured to represent a
    // genuinely multi-hop chain of distinct proxies, re-verify that every hop between the real
    // client and this app is itself trusted before relying on req.protocol/req.host again -- a
    // hop-0-only check would otherwise validate less than it looks like it does.
    trustProxy: cfg.trustedProxies.length === 0 ? false : cfg.trustedProxies,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(cookie);
  await app.register(securityPlugin, { hsts: cfg.baseUrl.startsWith('https:') });

  const dbHandle = await connectDatabase(cfg, {
    onIdleError: (err) => app.log.error({ err }, 'postgres idle connection error'),
  });
  if (dbHandle.dialect === 'postgres') {
    for (const warning of dbHandle.warnings) app.log.warn(warning);
  }
  const storage = createStorage(cfg.dataDir, cfg.sqliteDir);
  // Issue #197: say once, at boot, if the database directory sits on a filesystem WAL's
  // locking is not known to be dependable on. Postgres does not have this exposure.
  // liveDatabasePath (issue #179/#200), not a hand-built join: opportun.db no longer
  // necessarily lives under dataDir, and this is the one place that resolution is allowed
  // to happen, validated the same way every other path through storage.ts is.
  const sqliteFsHazard =
    dbHandle.dialect === 'sqlite'
      ? (checkSqliteFilesystem(storage.liveDatabasePath('opportun.db')) ?? null)
      : null;
  if (sqliteFsHazard !== null) app.log.warn(sqliteFsHazard.message);
  const { db } = dbHandle;
  // A transaction holding the write gate for seconds stalls every request: say who.
  configureGateWatchdog({
    report: (held) => app.log.warn(held, 'database write gate held too long'),
  });
  app.decorate('config', cfg);
  app.decorate('db', db);
  app.decorate('sqliteFsHazard', sqliteFsHazard);
  app.decorate('storage', storage);
  bindVaultKey(db, cfg.masterKey);
  if (opts.ai !== undefined) setAiOverride(db, opts.ai);
  app.decorate('google', opts.google ?? realGoogleApi);
  const googleConn = createGoogleConn({
    redirectUri: cfg.baseUrl + GOOGLE_CALLBACK_PATH,
    log: app.log,
  });
  app.decorate('googleConn', googleConn);
  app.decorate('googleFetch', opts.googleFetch ?? safeFetch);
  app.decorate(
    'documentStore',
    opts.documentStore ?? createGoogleDocsStore(db, googleConn, opts.google ?? realGoogleApi),
  );
  app.decorate('oauth', { fetch: opts.oauth?.fetch ?? safeFetch } satisfies OAuthWiring);
  const rrFetch = opts.rrFetch ?? safeFetch;
  app.decorate('reactiveResumeFetch', rrFetch);
  app.decorate(
    'reactiveResumeStore',
    createReactiveResumeStore({ fetch: rrFetch, config: (ctx) => readRrConfig(db, ctx) }),
  );
  app.decorate('localFileStore', createLocalFileStore({ storage, db }));
  // Nightly backup unless an operator already changed or disabled the schedule.
  await seedSchedule(db, BACKUP_JOB_KIND, BACKUP_CRON);
  // Before that backup, not after (issue #170): a bad result gets a date, not a guess, and
  // the backup still runs regardless so a bad night is never also a missed one. Scheduled on
  // both dialects (issue #241): this was SQLite-only while the Postgres branch of the check
  // was a static no-op, which was correct at the time, but #262 gave that branch real work
  // (a restart-detection probe) and this gate was never revisited, so it silently never ran
  // on Postgres. The two dialects get different cadences, not just the same job either way:
  // see DB_INTEGRITY_CHECK_CRON and DB_INTEGRITY_CHECK_CRON_POSTGRES in dbIntegrityCheck.ts
  // for why a full scan and a metadata diff do not deserve the same schedule.
  await seedSchedule(
    db,
    DB_INTEGRITY_CHECK_KIND,
    SCHEMA_DIALECT === 'sqlite' ? DB_INTEGRITY_CHECK_CRON : DB_INTEGRITY_CHECK_CRON_POSTGRES,
  );
  // After the backup, not before (jobs/attachmentSweep.ts ATTACHMENT_SWEEP_CRON): a file this
  // sweep deletes is still in that same night's backup, so a wrong deletion stays recoverable.
  await seedSchedule(db, ATTACHMENT_SWEEP_JOB_KIND, ATTACHMENT_SWEEP_CRON);
  // 04:00, after the backup (issue #272): every row this prunes exists in at least one
  // snapshot before it is deleted. Keep it after the backup if either schedule ever moves.
  await seedSchedule(db, JOB_PRUNE_JOB_KIND, JOB_PRUNE_CRON);
  // Only on a deployment that declares itself the demo instance (issue #280). This gate is
  // tidiness, not safety: registered unconditionally, the job would still delete zero rows on
  // a real database, since the pinned demo user ids it acts on do not exist there. The point of
  // gating it is that Settings > Jobs on a real deployment should never show a reset schedule
  // it has no reason to run, and conversely that the demo instance's own Settings > Jobs DOES
  // show it once registered (issue #270): an unregistered job and a job with nothing to do look
  // identical on that page, so this must be provably registered when cfg.demo is true, not
  // just correct when called directly.
  if (cfg.demo) await seedSchedule(db, DEMO_RESET_JOB_KIND, DEMO_RESET_CRON);
  await seedSchedule(db, GMAIL_SYNC_ALL_KIND, GMAIL_SYNC_ALL_CRON);
  await seedSchedule(db, REFINE_JOB_KIND, REFINE_CRON);
  await seedSchedule(db, DISCOVERY_REFINE_KIND, DISCOVERY_REFINE_CRON);
  await seedSchedule(db, ATS_REVERIFY_KIND, ATS_REVERIFY_CRON);
  await seedSchedule(db, COMPANY_SUGGEST_KIND, COMPANY_SUGGEST_CRON);
  // Daily: retry a Workday posting left bare by a failed detail fetch (issue #101).
  await seedSchedule(db, RETRY_WORKDAY_CAPTURE_KIND, RETRY_WORKDAY_CAPTURE_CRON);
  // Daily: resolve a near-miss duplicate pair the heuristic left pending (issue #94).
  await seedSchedule(db, OPPORTUNITY_DEDUPE_AI_KIND, OPPORTUNITY_DEDUPE_AI_CRON);
  // One-shot: repair alert leads the pre-fix LinkedIn parser shifted. Guarded by its own
  // marker, so this is a no-op on every boot after the first.
  await enqueueRepairAlertLeadsOnce(db);
  // One-shot: recompute dedupe keys the pre-fallback formula collapsed on non-Latin locations
  // (issue #13). Guarded by its own marker, same reasoning as the one above.
  await enqueueRepairDedupeKeysOnce(db);
  // One-shot: backfill company_match_key for companies written before that column existed
  // (issue #193). Guarded by its own marker, same reasoning as the one above.
  await enqueueRepairCompanyMatchKeysOnce(db);
  // One-shot: resolve a homepage for every company already sitting in an active pipeline
  // stage before this shipped (issue #239), so an opportunity reported before now does not
  // need to be moved again to pick one up. Guarded by its own marker, same reasoning as above.
  await enqueueCompanyDomainBackfillOnce(db);
  const services: JobServices = {
    storage: app.storage,
    documentStore: app.documentStore,
    reactiveResumeStore: app.reactiveResumeStore,
    mailProvider: createGmailProvider(opts.google ?? realGoogleApi, googleConn),
    sourceFetch: opts.sourceFetch ?? safeFetch,
    log: app.log,
    env: opts.env ?? process.env,
  };
  app.decorate('jobs', {
    services,
    drain: () =>
      runDueJobs(db, { services, onError: (err) => app.log.error({ err }, 'job runner') }),
  } satisfies AppJobs);
  let runner: Runner | undefined;
  app.addHook('onReady', async () => {
    if (opts.jobRunner === false) return;
    runner = startRunner(db, {
      services,
      ...(opts.jobRunner?.intervalMs === undefined
        ? {}
        : { intervalMs: opts.jobRunner.intervalMs }),
      onError: (err) => app.log.error({ err }, 'job runner'),
    });
  });
  app.addHook('onClose', async () => {
    // Let an in-flight job finish before the database goes away.
    await runner?.stop();
    await closeDatabase(dbHandle);
  });
  await app.register(sessionPlugin);

  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get(
    '/healthz',
    { schema: { response: { 200: HealthSchema, 503: HealthSchema } } },
    async (_req, reply) => {
      let dbOk = false;
      try {
        dbOk = await pingDatabase(dbHandle);
      } catch (err) {
        app.log.error({ err }, 'healthz database check failed');
      }
      let lag = 0;
      let integrity: LiveCheckResult | null = null;
      if (dbOk) {
        try {
          lag = await queueLagMs(db);
        } catch (err) {
          app.log.error({ err }, 'healthz queue lag check failed');
        }
        try {
          integrity = await readLiveCheck(app.storage);
        } catch (err) {
          app.log.error({ err }, 'healthz integrity read failed');
        }
      }
      const corrupted = dbOk && integrity !== null && !integrity.ok;
      const body = {
        status: !dbOk ? 'degraded' : corrupted ? 'corrupted' : 'ok',
        db: dbOk ? 'ok' : 'error',
        queueLagMs: lag,
        databaseIntegrity: integrity,
      } as const;
      // Still 200 when corrupted: see HealthSchema's own comment for why this is not 503.
      return reply.code(dbOk ? 200 : 503).send(body);
    },
  );

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(oauthLoginRoutes);
      await api.register(secretRoutes);
      await api.register(deviceTokenRoutes);
      await api.register(profileRoutes);
      await api.register(companyRoutes);
      await api.register(companySuggestionRoutes);
      await api.register(opportunityRoutes);
      await api.register(opportunityPostingRoutes);
      await api.register(activityRoutes);
      await api.register(dashboardRoutes);
      await api.register(attachmentRoutes);
      await api.register(mailFilterRoutes);
      await api.register(settingsRoutes);
      await api.register(aiRoutes);
      await api.register(googleAuthRoutes);
      await api.register(integrationsMailRoutes);
      await api.register(connectorMailRoutes);
      await api.register(communicationRoutes);
      await api.register(jobRoutes);
      await api.register(importExportRoutes);
      await api.register(artifactRoutes);
      await api.register(backupRoutes);
      await api.register(resumeRoutes);
      await api.register(reactiveResumeRoutes);
      await api.register(tailoringRoutes);
      await api.register(discoveryRoutes);
      await api.register(captureRoutes);
      await api.register(connectorCaptureRoutes);
      await api.register(contactRoutes);
      await api.register(referralRoutes);
    },
    { prefix: '/api/v1' },
  );

  // The SPA is optional: in development Vite serves it and proxies /api here.
  if (cfg.webDir !== undefined && hasSpaBuild(cfg.webDir)) {
    await app.register(spaRoutes, { root: cfg.webDir });
  } else {
    app.log.info({ webDir: cfg.webDir }, 'no web build found; serving the API only');
  }

  // OPPORTUN_HOST defaults to loopback (deliberately, on bare node: ADR-14 decision 6/7, no
  // reverse proxy sits in front of this process the way Caddy does on Compose). The failure
  // this produces, "works on this machine, connection refused from a phone", does not point
  // at the cause, so say it here rather than leaving it to a bound-address log line someone
  // has to already know to read (issue #24).
  if (LOOPBACK_HOSTS.has(cfg.host)) {
    app.log.info(
      { host: cfg.host, port: cfg.port },
      'listening on localhost only: this instance cannot be reached from another device until ' +
        'OPPORTUN_HOST names a reachable address (docs/install.md, "Reaching it from another device")',
    );
  }

  return app;
}
