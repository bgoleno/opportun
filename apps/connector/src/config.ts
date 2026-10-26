// The connector's config (server, device token, mailboxes) and its sync cursor. The config
// holds a bearer token, so it is written 0600 in a 0700 directory; the cursor lives in a
// separate state file next to it so a sync never rewrites the file with the secret.
import { join } from 'node:path';
import { ConnectorError, EXIT, redact, type ConnectorIo } from './types';

export interface ConnectorConfig {
  /** Origin (plus any reverse-proxy path) of the Opportun server, no trailing slash. */
  serverUrl: string;
  /** A device token with the mail:push scope (Settings > Integrations > Devices). */
  token: string;
  /** Mail mailboxes to read: "Inbox", a mailbox name, or "Account/Mailbox". */
  mailboxes: string[];
  /** How far back the first sync reaches. */
  lookbackDays: number;
  /** The watch period. */
  intervalMinutes: number;
}

export interface SyncState {
  /** dateReceived (ms) of the newest message the server has accepted; null before the first. */
  cursor: number | null;
  /**
   * A message Mail failed to read, held for another try: the cursor stays before `at` until
   * it is read or `attempts` reaches the limit (sync.ts MAX_READ_ATTEMPTS).
   */
  retry?: { at: number; attempts: number };
}

export const DEFAULT_LOOKBACK_DAYS = 180;
/** The Gmail lookback ceiling (3 years), kept for parity. */
export const MAX_LOOKBACK_DAYS = 1095;
export const DEFAULT_INTERVAL_MINUTES = 15;
export const MAX_INTERVAL_MINUTES = 24 * 60;
export const TOKEN_SHAPE = /^odt_[A-Za-z0-9_-]{43}$/;

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export function defaultConfigDir(env: { HOME?: string; XDG_CONFIG_HOME?: string }): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg !== undefined && xdg !== '') return join(xdg, 'opportun-connector');
  const home = env.HOME?.trim();
  if (home === undefined || home === '') {
    throw new ConnectorError('Cannot find the config directory: HOME is not set.', EXIT.USAGE);
  }
  return join(home, '.config', 'opportun-connector');
}

export function configFiles(dir: string) {
  return { dir, config: join(dir, 'config.json'), state: join(dir, 'state.json') };
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The server address without a trailing slash. https is required (the token travels in a
 * header) except to a loopback address, for a server on this Mac.
 */
export function normalizeServerUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new ConnectorError(`Not a server address: ${redact(input)}`, EXIT.USAGE);
  }
  const loopbackHttp = url.protocol === 'http:' && LOOPBACK.has(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHttp) {
    throw new ConnectorError(
      'The server address must use https:// (http:// is allowed only for localhost).',
      EXIT.USAGE,
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new ConnectorError('The server address must not contain credentials.', EXIT.USAGE);
  }
  if (url.search !== '' || url.hash !== '') {
    throw new ConnectorError('The server address must not have a query or fragment.', EXIT.USAGE);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function checkToken(token: string): string {
  const t = token.trim();
  if (!TOKEN_SHAPE.test(t)) {
    throw new ConnectorError(
      'That is not a device token: they start with odt_ and are 47 characters long. ' +
        'Create one in Opportun under Settings > Integrations > Devices.',
      EXIT.USAGE,
    );
  }
  return t;
}

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

function invalid(what: string): never {
  throw new ConnectorError(
    `The connector config is invalid (${what}). Run \`opportun-connector init\` again.`,
    EXIT.USAGE,
  );
}

export function parseConfig(text: string): ConnectorConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    invalid('not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null) invalid('not an object');
  const o = raw as Record<string, unknown>;
  if (typeof o.serverUrl !== 'string') invalid('serverUrl');
  if (typeof o.token !== 'string' || !TOKEN_SHAPE.test(o.token)) invalid('device token');
  const mailboxes = o.mailboxes;
  if (
    !Array.isArray(mailboxes) ||
    mailboxes.length === 0 ||
    !mailboxes.every((m) => typeof m === 'string' && m.trim() !== '')
  ) {
    invalid('mailboxes: list at least one mailbox name');
  }
  if (!isInt(o.lookbackDays, 1, MAX_LOOKBACK_DAYS)) {
    invalid(`lookbackDays: a whole number of days from 1 to ${MAX_LOOKBACK_DAYS}`);
  }
  const interval = o.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
  if (!isInt(interval, 1, MAX_INTERVAL_MINUTES)) {
    invalid(`intervalMinutes: a whole number of minutes from 1 to ${MAX_INTERVAL_MINUTES}`);
  }
  return {
    serverUrl: normalizeServerUrl(o.serverUrl),
    token: o.token,
    mailboxes: (mailboxes as string[]).map((m) => m.trim()),
    lookbackDays: o.lookbackDays,
    intervalMinutes: interval,
  };
}

/** The config, or null when `init` has not run. */
export async function readConfig(io: ConnectorIo): Promise<ConnectorConfig | null> {
  const text = await io.fs.readText(configFiles(io.configDir).config);
  return text === null ? null : parseConfig(text);
}

export async function loadConfig(io: ConnectorIo): Promise<ConnectorConfig> {
  const config = await readConfig(io);
  if (config === null) {
    throw new ConnectorError(
      'Not configured yet: run `opportun-connector init` first.',
      EXIT.USAGE,
    );
  }
  return config;
}

export async function saveConfig(io: ConnectorIo, config: ConnectorConfig): Promise<void> {
  const files = configFiles(io.configDir);
  await io.fs.mkdir(files.dir, DIR_MODE);
  await io.fs.writeText(files.config, `${JSON.stringify(config, null, 2)}\n`, FILE_MODE);
}

export async function loadState(io: ConnectorIo): Promise<SyncState> {
  const text = await io.fs.readText(configFiles(io.configDir).state);
  if (text === null) return { cursor: null };
  try {
    const parsed = JSON.parse(text) as {
      cursor?: unknown;
      retry?: { at?: unknown; attempts?: unknown };
    };
    const { cursor, retry } = parsed;
    // A corrupt cursor restarts from the lookback window; the server upserts, so that is safe.
    const state: SyncState = { cursor: isInt(cursor, 0, Number.MAX_SAFE_INTEGER) ? cursor : null };
    if (
      typeof retry === 'object' &&
      retry !== null &&
      isInt(retry.at, 0, Number.MAX_SAFE_INTEGER) &&
      isInt(retry.attempts, 1, 1000)
    ) {
      state.retry = { at: retry.at, attempts: retry.attempts };
    }
    return state;
  } catch {
    return { cursor: null };
  }
}

export async function saveState(io: ConnectorIo, state: SyncState): Promise<void> {
  const files = configFiles(io.configDir);
  await io.fs.mkdir(files.dir, DIR_MODE);
  await io.fs.writeText(files.state, `${JSON.stringify(state)}\n`, FILE_MODE);
}
