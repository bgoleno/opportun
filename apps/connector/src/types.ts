// Shared types and the I/O seams. Every side effect the connector has (files, network, the
// osascript bridge, time, terminal) goes through ConnectorIo, so the whole CLI is testable
// on any platform with fakes (test/fakes.ts) and only nodeIo.ts touches the real system.

export const VERSION = '0.1.0';

/**
 * One message as the server's POST /api/v1/connector/mail/batch takes it: the
 * apps/server/src/adapters/mailProvider.ts InboundMessage shape (the contract, copied here
 * because the CLI never imports server internals).
 */
export interface InboundMessage {
  externalId: string;
  threadKey: string;
  from: string;
  to: string[];
  subject: string;
  snippet: string;
  bodyText: string;
  sentAt: number;
}

export interface FileSystem {
  /** The file's text, or null when it does not exist. */
  readText(path: string): Promise<string | null>;
  /** Replaces the file; it ends up with exactly `mode` whatever it had before. */
  writeText(path: string, text: string, mode: number): Promise<void>;
  /** Creates the directory (and parents) and sets its mode. */
  mkdir(path: string, mode: number): Promise<void>;
}

export interface FetchInit {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

export interface HttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<HttpResponse>;

export interface OsascriptResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `osascript` with these arguments. */
export type OsascriptRunner = (args: string[]) => Promise<OsascriptResult>;

export interface Clock {
  now(): number;
  /** Resolves after `ms`, or early once `signal` aborts. Never rejects. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export type Prompt = (question: string, opts?: { secret?: boolean }) => Promise<string>;

export interface ConnectorIo {
  fs: FileSystem;
  fetch: FetchLike;
  osascript: OsascriptRunner;
  clock: Clock;
  stdout(line: string): void;
  stderr(line: string): void;
  /** In [0, 1): the watch jitter. */
  random(): number;
  /** Where config.json and state.json live. */
  configDir: string;
  prompt: Prompt;
}

/** Process exit codes, documented in the README. */
export const EXIT = {
  OK: 0,
  FAILURE: 1,
  USAGE: 2,
  AUTH: 3,
  SERVER: 4,
  MAIL: 5,
} as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * A user-typed value fit to repeat in a message: it may be a misplaced token or password,
 * so a device token is masked and anything long is cut (review F8).
 */
export function redact(value: string): string {
  const t = maskTokens(value.trim());
  return t.length > 40 ? `${t.slice(0, 12)}...` : t;
}

/** Every device token in `text` masked. */
export const maskTokens = (text: string): string =>
  text.replace(/odt_[A-Za-z0-9_-]+/g, 'odt_[redacted]');

/** A failure the CLI reports as a message and an exit code (no stack trace). */
export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode,
  ) {
    super(message);
    this.name = 'ConnectorError';
  }
}
