import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { parseDbDialect } from './db/dialectName';
import { NO_PEPPERS, pepperSet, type PepperSet } from './lib/pepperSet';
import { readOperatorFile } from './lib/storage';

/** TLS to Postgres: off, encrypted without certificate checks, or fully verified. */
export const DB_SSL_MODES = ['disable', 'require', 'verify-full'] as const;
export type DbSsl = (typeof DB_SSL_MODES)[number];

/**
 * Postgres settings. The URL carries the database password, so it lives in a private field:
 * JSON.stringify, util.inspect and the pino logger only ever see `url: '[redacted]'`.
 */
export class PostgresConfig {
  readonly dialect = 'postgres' as const;
  readonly poolMax: number;
  readonly ssl: DbSsl;
  readonly #url: string;

  constructor(url: string, poolMax: number, ssl: DbSsl) {
    this.#url = url;
    this.poolMax = poolMax;
    this.ssl = ssl;
  }

  /** The connection URL for the driver; never log it. */
  get url(): string {
    return this.#url;
  }

  toJSON(): Record<string, unknown> {
    return { dialect: this.dialect, url: '[redacted]', poolMax: this.poolMax, ssl: this.ssl };
  }

  [inspect.custom](): Record<string, unknown> {
    return this.toJSON();
  }

  toString(): string {
    return `postgres (url [redacted], poolMax ${this.poolMax}, ssl ${this.ssl})`;
  }
}

/** DB_DIALECT and, for Postgres, how to reach it (ADR-4). */
export type DbConfig = { dialect: 'sqlite' } | PostgresConfig;

export interface Config {
  port: number;
  /** Interface to listen on. Loopback by default; network exposure is opt-in. */
  host: string;
  dataDir: string;
  /**
   * Where opportun.db lives (SQLITE_DIR; DATA_DIR if unset). Separate from dataDir so the
   * live database can sit on its own named Docker volume while attachments, backups,
   * exports and master.key stay on the host bind mount (issue #179, incident #165).
   */
  sqliteDir: string;
  baseUrl: string;
  masterKey: Buffer;
  /**
   * Password peppers (NFR-SEC3, issue #5). OPPORTUN_PEPPER is the current secret and
   * OPPORTUN_PEPPER_VERSION its version (1 by default); OPPORTUN_PEPPER_V<N> supplies an
   * older secret so its hashes keep verifying through a rotation. Absent means no pepper.
   */
  peppers?: PepperSet;
  logLevel: string;
  smtpUrl?: string;
  /** Built SPA (apps/web/dist). Served with an index.html fallback when it exists. */
  webDir?: string;
  /**
   * Unpacked browser extensions, one directory per target (packages/extension/dist). Served
   * as downloads by routes/artifacts.ts; absent or unbuilt simply means no download is offered.
   */
  artifactsDir?: string;
  /** The database engine (DB_DIALECT; SQLite unless set). DATA_DIR is required either way. */
  db: DbConfig;
  /** OPPORTUN_DEMO=1 (issue #280): this deployment declares itself the invitation-only demo
   *  instance. Gates the nightly reset job's schedule registration only; it is not what makes
   *  the reset safe on a real database (the pinned demo user ids and seedDemo's own marker
   *  check are), so this flag being set by mistake does not arm anything destructive. */
  demo: boolean;
  /**
   * OPPORTUN_AI_ALLOW_LOOPBACK_HTTP=1 (issue #334): whether an openai_compatible model policy's
   * baseUrl may use plain http to localhost/127.0.0.1/[::1] at all on this deployment. Off by
   * default. The allowance exists for an operator pointing this server at their own local model
   * runtime (Ollama, LM Studio); "which local runtimes may be reached" is an operator decision
   * for their own deployment, not something a per-user policy should unlock by itself, since a
   * careless co-user on a shared install would otherwise get to probe this server's own
   * loopback just because nothing stopped them from trying. A single-user self-hosted operator
   * who wants the feature sets this themselves; a multi-user install (e.g. the demo) gets
   * strict https-only with no action required. See lib/aiProviderFetch.ts and
   * packages/ai/src/providers.ts's assertSafeBaseUrl for where this is enforced.
   */
  aiAllowLoopbackHttp: boolean;
  /**
   * Reverse proxies whose X-Forwarded-* headers are trusted (OPPORTUN_TRUSTED_PROXIES, issue
   * #333): IPs, CIDR ranges, or the preset names loopback/linklocal/uniquelocal, passed to
   * Fastify's trustProxy. Empty (the default) trusts NO proxy, so req.ip and req.protocol come
   * from the socket. That is correct for a bare-metal LAN install: trusting a private-range peer
   * (the previous ['loopback','linklocal','uniquelocal'] default) let any LAN client spoof
   * X-Forwarded-For past the per-IP rate limits. A deployment behind a proxy (Caddy in deploy/)
   * sets this to that proxy's address or subnet, which is also what restores the
   * X-Forwarded-Proto Secure-cookie derivation (ADR-14, issue #23) on that path. See app.ts's
   * trustProxy wiring for a hop-0-only caveat on req.host/req.protocol that this list alone
   * doesn't convey.
   */
  trustedProxies: string[];
}

/** apps/web/dist relative to this source file; WEB_DIR overrides it (e.g. in an image). */
const DEFAULT_WEB_DIR = fileURLToPath(new URL('../../web/dist', import.meta.url));

/** packages/extension/dist likewise; ARTIFACTS_DIR overrides it (the image sets /app/artifacts). */
const DEFAULT_ARTIFACTS_DIR = fileURLToPath(
  new URL('../../../packages/extension/dist', import.meta.url),
);

/** A hostname such as `localhost`: letters, digits, dots and hyphens only. */
const HOSTNAME = /^[A-Za-z0-9.-]{1,253}$/;

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];
const MASTER_KEY_HEX = /^[0-9a-fA-F]{64}$/;

class ConfigError extends Error {
  override name = 'ConfigError';
}

function parseMasterKey(hex: string, source: string): Buffer {
  const trimmed = hex.trim();
  if (!MASTER_KEY_HEX.test(trimmed)) {
    throw new ConfigError(
      `${source} must be 32 bytes encoded as 64 hex characters (generate one with: openssl rand -hex 32)`,
    );
  }
  return Buffer.from(trimmed, 'hex');
}

/** The vault master key (OPPORTUN_MASTER_KEY or _FILE); also read by the copy tool. */
export function loadMasterKey(env: NodeJS.ProcessEnv): Buffer {
  const inline = env.OPPORTUN_MASTER_KEY;
  if (inline !== undefined && inline !== '') {
    return parseMasterKey(inline, 'OPPORTUN_MASTER_KEY');
  }
  const file = env.OPPORTUN_MASTER_KEY_FILE;
  if (file !== undefined && file !== '') {
    let contents: string;
    try {
      contents = readOperatorFile(resolve(file));
    } catch (err) {
      throw new ConfigError(
        `OPPORTUN_MASTER_KEY_FILE could not be read (${file}): ${(err as Error).message}`,
      );
    }
    return parseMasterKey(contents, `OPPORTUN_MASTER_KEY_FILE (${file})`);
  }
  throw new ConfigError(
    'Missing OPPORTUN_MASTER_KEY: set OPPORTUN_MASTER_KEY (64 hex characters) or OPPORTUN_MASTER_KEY_FILE (path to a file containing it)',
  );
}

function loadBaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.OPPORTUN_BASE_URL;
  if (raw === undefined || raw === '') {
    throw new ConfigError(
      'Missing OPPORTUN_BASE_URL: set it to the public URL users open, e.g. https://opportun.example.com',
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`OPPORTUN_BASE_URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError('OPPORTUN_BASE_URL must use http or https');
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function loadPort(env: NodeJS.ProcessEnv): number {
  const raw = env.PORT;
  if (raw === undefined || raw === '') return 3000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`PORT must be an integer between 0 and 65535, got: ${raw}`);
  }
  return port;
}

function loadHost(env: NodeJS.ProcessEnv): string {
  const raw = env.OPPORTUN_HOST;
  if (raw === undefined || raw === '') return '127.0.0.1';
  if (isIP(raw) === 0 && !HOSTNAME.test(raw)) {
    throw new ConfigError(
      `OPPORTUN_HOST must be an IP address (e.g. 127.0.0.1, 0.0.0.0, ::) or a hostname, got: ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

function loadLogLevel(env: NodeJS.ProcessEnv): string {
  const level = env.LOG_LEVEL === undefined || env.LOG_LEVEL === '' ? 'info' : env.LOG_LEVEL;
  if (!LOG_LEVELS.includes(level)) {
    throw new ConfigError(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got: ${level}`);
  }
  return level;
}

/** proxy-addr preset names Fastify accepts alongside IPs and CIDRs in a trustProxy list. */
const TRUST_PROXY_PRESETS: ReadonlySet<string> = new Set(['loopback', 'linklocal', 'uniquelocal']);

/** True for a trustProxy list entry: a preset name, a bare IP, or an IP/prefix CIDR. */
function isTrustedProxyEntry(entry: string): boolean {
  if (TRUST_PROXY_PRESETS.has(entry)) return true;
  const slash = entry.indexOf('/');
  if (slash === -1) return isIP(entry) !== 0;
  const family = isIP(entry.slice(0, slash));
  if (family === 0) return false;
  const prefix = entry.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

/**
 * OPPORTUN_TRUSTED_PROXIES (issue #333): a comma-separated trustProxy list, empty by default
 * (trust no proxy). Validated at boot, fail-fast, rather than letting proxy-addr reject a
 * malformed entry on the first request it is needed.
 */
function loadTrustedProxies(env: NodeJS.ProcessEnv): string[] {
  const raw = env.OPPORTUN_TRUSTED_PROXIES;
  if (raw === undefined || raw.trim() === '') return [];
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const entry of entries) {
    if (!isTrustedProxyEntry(entry)) {
      throw new ConfigError(
        `OPPORTUN_TRUSTED_PROXIES entry ${JSON.stringify(entry)} must be an IP address, a CIDR ` +
          'range, or one of loopback, linklocal, uniquelocal',
      );
    }
  }
  return entries;
}

const PEPPER_MIN = 16;

function loadPeppers(env: NodeJS.ProcessEnv): PepperSet {
  const raw = env.OPPORTUN_PEPPER;
  if (raw === undefined || raw === '') return NO_PEPPERS;
  if (raw.length < PEPPER_MIN) {
    throw new ConfigError(
      `OPPORTUN_PEPPER must be at least ${PEPPER_MIN} characters (generate one with: openssl rand -hex 32)`,
    );
  }
  const versionRaw = env.OPPORTUN_PEPPER_VERSION;
  const current = versionRaw === undefined || versionRaw === '' ? 1 : Number(versionRaw);
  if (!Number.isInteger(current) || current < 1 || current > 9999) {
    throw new ConfigError('OPPORTUN_PEPPER_VERSION must be a whole number from 1 to 9999');
  }
  const secrets: Record<number, string> = { [current]: raw };
  for (const [key, value] of Object.entries(env)) {
    const m = /^OPPORTUN_PEPPER_V(\d{1,4})$/.exec(key);
    if (m === null || value === undefined || value === '') continue;
    const v = Number(m[1]);
    if (v === current) continue;
    if (value.length < PEPPER_MIN) {
      throw new ConfigError(`${key} must be at least ${PEPPER_MIN} characters`);
    }
    secrets[v] = value;
  }
  // Rotating without keeping the previous secret strands every hash made under it, which is
  // the failure #5 exists to prevent. Refuse at boot rather than one locked-out login at a
  // time: every version below the current one must still be supplied.
  for (let v = 1; v < current; v += 1) {
    if (secrets[v] === undefined) {
      throw new ConfigError(
        `OPPORTUN_PEPPER_VERSION is ${current}, so OPPORTUN_PEPPER_V${v} must supply the pepper that version ${v} hashes were made with, or those accounts can never log in`,
      );
    }
  }
  return pepperSet(current, secrets);
}

const DEFAULT_POOL_MAX = 10;
const MAX_POOL_MAX = 1000;
/** URL parameters that would override DB_SSL inside the driver (it lets the URL win). */
const URL_TLS_PARAMS = ['ssl', 'sslcert', 'sslkey', 'sslrootcert', 'sslpassword', 'uselibpqcompat'];

/** The host list of a postgres URL plus its query, without ever echoing the URL itself. */
function splitPostgresUrl(raw: string): { hosts: string[]; query: URLSearchParams; head: string } {
  // Hand-parsed: WHATWG URL rejects the libpq unix-socket form postgres://u:p@/db?host=/run/pg.
  const scheme = ['postgres://', 'postgresql://'].find((p) => raw.startsWith(p));
  if (scheme === undefined || /[\s#]/.test(raw)) {
    throw new ConfigError(
      'DATABASE_URL must be a postgres:// or postgresql:// URL, e.g. postgres://user:password@host:5432/opportun (value not shown)',
    );
  }
  const q = raw.indexOf('?');
  // Everything before the query: scheme, authority and database path, kept verbatim.
  const head = q === -1 ? raw : raw.slice(0, q);
  const query = new URLSearchParams(q === -1 ? '' : raw.slice(q + 1));
  const afterScheme = head.slice(scheme.length);
  const slash = afterScheme.indexOf('/');
  const authority = slash === -1 ? afterScheme : afterScheme.slice(0, slash);
  const hosts = authority
    .slice(authority.lastIndexOf('@') + 1)
    .split(',')
    .map((h) => (h.startsWith('[') ? h.slice(1, h.indexOf(']')) : (h.split(':')[0] ?? '')));
  const socketHost = query.get('host');
  return {
    hosts: hosts.every((h) => h === '') && socketHost !== null ? [socketHost] : hosts,
    query,
    head,
  };
}

function isLoopbackHost(host: string): boolean {
  if (host === '' || host.startsWith('/')) return true; // unix socket
  if (host === 'localhost' || host === '::1') return true;
  return isIP(host) === 4 && host.startsWith('127.');
}

function loadDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const inline = env.DATABASE_URL;
  if (inline !== undefined && inline !== '') return inline.trim();
  const file = env.DATABASE_URL_FILE;
  if (file !== undefined && file !== '') {
    try {
      return readOperatorFile(resolve(file)).trim();
    } catch (err) {
      throw new ConfigError(
        `DATABASE_URL_FILE could not be read (${file}): ${(err as Error).message}`,
      );
    }
  }
  throw new ConfigError(
    'DB_DIALECT=postgres needs DATABASE_URL or DATABASE_URL_FILE (path to a file containing the URL)',
  );
}

function parseSsl(raw: string, source: string): DbSsl {
  if ((DB_SSL_MODES as readonly string[]).includes(raw)) return raw as DbSsl;
  throw new ConfigError(
    `${source} must be disable, require or verify-full, got: ${JSON.stringify(raw)}`,
  );
}

function loadPostgres(env: NodeJS.ProcessEnv): PostgresConfig {
  let url = loadDatabaseUrl(env);
  const { hosts, query, head } = splitPostgresUrl(url);
  for (const param of URL_TLS_PARAMS) {
    if (query.has(param)) {
      throw new ConfigError(
        `DATABASE_URL must not set ${param}: configure TLS with DB_SSL (a private CA goes in NODE_EXTRA_CA_CERTS)`,
      );
    }
  }
  const urlMode = query.get('sslmode');
  if (urlMode !== null) {
    // The driver lets the URL override its ssl option; strip it so DB_SSL alone decides.
    query.delete('sslmode');
    const rest = query.toString();
    url = rest === '' ? head : `${head}?${rest}`;
  }
  const fromUrl = urlMode === null ? undefined : parseSsl(urlMode, 'DATABASE_URL sslmode');
  const fromEnv =
    env.DB_SSL === undefined || env.DB_SSL === '' ? undefined : parseSsl(env.DB_SSL, 'DB_SSL');
  if (fromUrl !== undefined && fromEnv !== undefined && fromUrl !== fromEnv) {
    throw new ConfigError(
      `DB_SSL=${fromEnv} contradicts sslmode=${fromUrl} in DATABASE_URL; set one of them`,
    );
  }
  const ssl = fromEnv ?? fromUrl ?? (hosts.every(isLoopbackHost) ? 'disable' : 'require');
  const rawPool = env.DB_POOL_MAX;
  let poolMax = DEFAULT_POOL_MAX;
  if (rawPool !== undefined && rawPool !== '') {
    poolMax = Number(rawPool);
    if (!/^\d+$/.test(rawPool) || poolMax < 1 || poolMax > MAX_POOL_MAX) {
      throw new ConfigError(
        `DB_POOL_MAX must be an integer between 1 and ${MAX_POOL_MAX}, got: ${rawPool}`,
      );
    }
  }
  return new PostgresConfig(url, poolMax, ssl);
}

/**
 * Where opportun.db lives (SQLITE_DIR), defaulting to dataDir. Shared with the
 * reset-password CLI (its own minimal config) so both resolve the same file; opening the
 * database at two different locations across processes is how the WAL coordination
 * incident #165 investigated gets reintroduced by accident.
 */
export function loadSqliteDir(env: NodeJS.ProcessEnv, dataDir: string): string {
  return resolve(env.SQLITE_DIR === undefined || env.SQLITE_DIR === '' ? dataDir : env.SQLITE_DIR);
}

/**
 * The database settings alone (DB_DIALECT and, for Postgres, DATABASE_URL and friends): for
 * tools such as the reset-password CLI that need no master key or base URL.
 */
export function loadDbConfig(env: NodeJS.ProcessEnv = process.env): DbConfig {
  let dialect;
  try {
    dialect = parseDbDialect(env.DB_DIALECT);
  } catch (err) {
    throw new ConfigError((err as Error).message);
  }
  return dialect === 'sqlite' ? { dialect } : loadPostgres(env);
}

/** Reads and validates configuration. Throws a ConfigError naming the offending variable. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const masterKey = loadMasterKey(env);
  const baseUrl = loadBaseUrl(env);
  const dataDir = resolve(
    env.DATA_DIR === undefined || env.DATA_DIR === '' ? './data' : env.DATA_DIR,
  );
  const cfg: Config = {
    port: loadPort(env),
    host: loadHost(env),
    dataDir,
    sqliteDir: loadSqliteDir(env, dataDir),
    baseUrl,
    masterKey,
    peppers: loadPeppers(env),
    logLevel: loadLogLevel(env),
    db: loadDbConfig(env),
    demo: env.OPPORTUN_DEMO === '1',
    aiAllowLoopbackHttp: env.OPPORTUN_AI_ALLOW_LOOPBACK_HTTP === '1',
    trustedProxies: loadTrustedProxies(env),
    webDir: resolve(
      env.WEB_DIR === undefined || env.WEB_DIR === '' ? DEFAULT_WEB_DIR : env.WEB_DIR,
    ),
    artifactsDir: resolve(
      env.ARTIFACTS_DIR === undefined || env.ARTIFACTS_DIR === ''
        ? DEFAULT_ARTIFACTS_DIR
        : env.ARTIFACTS_DIR,
    ),
  };
  if (env.SMTP_URL !== undefined && env.SMTP_URL !== '') cfg.smtpUrl = env.SMTP_URL;
  return cfg;
}
