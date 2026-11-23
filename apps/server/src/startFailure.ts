// Why the server could not start, for the one line it logs then
// (https://github.com/bgoleno/opportun/issues/887). The log gate keeps no error's message (design
// 14.9), so a failed start said only its error's class: each cause an operator can act on is named
// here, and its line is a sentence written for it in the catalog (START_FAILURES).
//
// An error's own text is read at most to tell one cause from another, and never logged: a
// driver's can hold the connection string, a user name, a host or a path.
import Database from 'better-sqlite3';
import { sep } from 'node:path';
import type { Config } from './config';
import { DatabaseRefused } from './db/client';
import { START_FAILURES, type StartFailureReason } from './obs/catalog';
import type { Logger } from 'pino';

/** A start that failed while listening, with what failed it as its `cause`. */
export class ListenFailure extends Error {
  override name = 'ListenFailure';
  constructor(
    cause: unknown,
    readonly port: number,
  ) {
    super('listen', { cause });
  }
}

function codeOf(err: unknown): string {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : '';
  return typeof code === 'string' ? code : '';
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : '');

/** SQLite's own error codes, by their primary code (SQLITE_CORRUPT_INDEX is SQLITE_CORRUPT's). */
function sqliteReason(err: unknown): StartFailureReason | undefined {
  if (!(err instanceof Database.SqliteError)) return undefined;
  switch (codeOf(err).split('_')[1]) {
    case 'NOTADB':
    case 'CORRUPT':
      return 'sqlite_damaged';
    case 'CANTOPEN':
    case 'READONLY':
    case 'PERM':
    case 'AUTH':
      return 'sqlite_unopenable';
    case 'BUSY':
    case 'LOCKED':
      return 'sqlite_busy';
    case 'FULL':
      return 'disk_full';
    default:
      return undefined;
  }
}

/** A system call on a data directory that failed: not a file the app was built with. */
function dataDirReason(err: unknown, cfg: StartConfig): StartFailureReason | undefined {
  const path = (err as { path?: unknown } | null)?.path;
  if (typeof path !== 'string') return undefined;
  const under = [cfg.dataDir, cfg.sqliteDir].some((d) => path === d || path.startsWith(d + sep));
  // A parent that cannot be made is named instead of the directory itself.
  const above = [cfg.dataDir, cfg.sqliteDir].some((d) => d.startsWith(path + sep));
  if (!under && !above) return undefined;
  const code = codeOf(err);
  if (code === 'ENOSPC') return 'disk_full';
  return ['EACCES', 'EPERM', 'EROFS', 'EEXIST', 'ENOTDIR', 'ENOENT'].includes(code)
    ? 'data_dir'
    : undefined;
}

const UNREACHABLE = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'EPIPE',
  'ETIMEDOUT',
  // A Unix socket that is not there, or not this user's to use.
  'ENOENT',
  'EACCES',
]);
/** What node-postgres and its pool say, with no code, when no connection came of it. */
const UNREACHABLE_TEXT = new Set([
  'timeout expired',
  'timeout exceeded when trying to connect',
  'Connection terminated due to connection timeout',
  'Connection terminated unexpectedly',
  'Connection terminated',
]);
const TLS_TEXT = new Set([
  'The server does not support SSL connections',
  'There was an error establishing an SSL connection',
]);
/** Node's certificate errors: OpenSSL's verification results, and Node's own. */
const TLS_CODE =
  /^(?:ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|SELF_SIGNED_|DEPTH_ZERO_|HOSTNAME_MISMATCH$|INVALID_CA$)/;

function postgresReason(err: unknown): StartFailureReason | undefined {
  const code = codeOf(err);
  const text = messageOf(err);
  if (code === 'ERR_INVALID_URL' || err instanceof URIError) return 'postgres_url';
  if (TLS_CODE.test(code) || TLS_TEXT.has(text)) return 'postgres_tls';
  if (UNREACHABLE.has(code) || UNREACHABLE_TEXT.has(text)) return 'postgres_unreachable';
  // SQLSTATE, from Postgres itself.
  if (code.length !== 5) return undefined;
  if (code.startsWith('28')) return 'postgres_sign_in';
  if (code === '3D000') return 'postgres_no_database';
  if (code === '42501') return 'postgres_permission';
  // Starting up or shutting down, and out of connections.
  if (code.startsWith('57P') || code === '53300') return 'postgres_not_ready';
  return undefined;
}

function listenReason(err: unknown): StartFailureReason | undefined {
  switch (codeOf(err)) {
    case 'EADDRINUSE':
      return 'port_in_use';
    case 'EACCES':
      return 'port_not_allowed';
    case 'EADDRNOTAVAIL':
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'listen_address';
    default:
      return undefined;
  }
}

export type StartConfig = Pick<Config, 'dataDir' | 'sqliteDir'> & {
  db: Pick<Config['db'], 'dialect'>;
};

/** Why the start failed, or undefined when it is none of the causes the catalog names. */
export function startFailureReason(
  err: unknown,
  cfg: StartConfig | undefined,
): StartFailureReason | undefined {
  if (err instanceof ListenFailure) return listenReason(err.cause);
  if (err instanceof DatabaseRefused) return err.refusal;
  if (cfg === undefined) return undefined;
  const reason = sqliteReason(err) ?? dataDirReason(err, cfg);
  return reason ?? (cfg.db.dialect === 'postgres' ? postgresReason(err) : undefined);
}

/**
 * The line a failed start leaves. The error goes with it as any other does, reduced by the gate to
 * its class and its frames.
 */
export function logStartFailure(log: Logger, err: unknown, cfg: StartConfig | undefined): void {
  const reason = startFailureReason(err, cfg);
  const port = err instanceof ListenFailure ? { 'server.port': err.port } : {};
  const cause: unknown = err instanceof ListenFailure ? err.cause : err;
  if (reason === undefined) log.error({ err: cause }, 'server failed to start');
  // eslint-disable-next-line security/detect-object-injection -- a StartFailureReason, a key of the constant itself
  else log.error({ err: cause, ...port }, START_FAILURES[reason]);
}
