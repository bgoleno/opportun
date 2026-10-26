// The opportun-connector commands: init, sync, watch. main() takes every side effect through
// ConnectorIo and returns the exit code; src/index.ts wires it to the real process.
import { parseArgs } from 'node:util';
import {
  checkToken,
  configFiles,
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_LOOKBACK_DAYS,
  loadConfig,
  MAX_INTERVAL_MINUTES,
  MAX_LOOKBACK_DAYS,
  normalizeServerUrl,
  readConfig,
  saveConfig,
  saveState,
  type ConnectorConfig,
} from './config';
import { pushBatch } from './push';
import { syncOnce, TOKEN_REJECTED, type SyncSummary } from './sync';
import {
  ConnectorError,
  EXIT,
  maskTokens,
  redact,
  VERSION,
  type ConnectorIo,
  type ExitCode,
} from './types';

export const USAGE = `Usage: opportun-connector <command> [options]

Reads Apple Mail on this Mac and pushes it to your Opportun server (read-only).

Commands:
  init     Set the server, device token and mailboxes, then check the token
  sync     Push new mail once
  watch    Sync every few minutes until interrupted (Ctrl-C)

Options for init (anything left out is asked for):
  --server <url>      Opportun server address, https://...
  --token <token>     Device token with the mail:push scope (odt_...). Prefer the
                      prompt: a flag can end up in shell history.
  --mailbox <name>    Mailbox to read; repeat for several. "Inbox" (all inboxes),
                      a mailbox name, or "Account/Mailbox". Default: Inbox
  --days <n>          How far back the first sync reaches (default ${DEFAULT_LOOKBACK_DAYS})
  --interval <min>    Minutes between syncs for watch (default ${DEFAULT_INTERVAL_MINUTES})

Options for watch:
  --interval <min>    Override the configured interval

  -h, --help          Show this help
  -v, --version       Show the version`;

/** +/-10% so connectors on a schedule do not all arrive at once. */
const JITTER = 0.1;

function usageError(message: string): ConnectorError {
  return new ConnectorError(`${message}\n\n${USAGE}`, EXIT.USAGE);
}

function wholeNumber(value: string, what: string, max: number): number {
  const n = /^\d{1,6}$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new ConnectorError(`${what} must be a whole number from 1 to ${max}.`, EXIT.USAGE);
  }
  return n;
}

/** True when `next` reads mail `prev` never could: a new mailbox or a longer lookback. */
function widens(prev: ConnectorConfig, next: ConnectorConfig): boolean {
  const known = new Set(prev.mailboxes.map((m) => m.toLowerCase()));
  return (
    next.lookbackDays > prev.lookbackDays || next.mailboxes.some((m) => !known.has(m.toLowerCase()))
  );
}

const mailboxList = (s: string): string[] =>
  s
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m !== '');

async function init(io: ConnectorIo, args: string[]): Promise<ExitCode> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      server: { type: 'string' },
      token: { type: 'string' },
      mailbox: { type: 'string', multiple: true },
      days: { type: 'string' },
      interval: { type: 'string' },
    },
  });
  // A corrupt or missing config just means there are no defaults to offer.
  const existing = await readConfig(io).catch(() => null);
  const interactive =
    values.server === undefined &&
    values.token === undefined &&
    values.mailbox === undefined &&
    values.days === undefined;
  const ask = async (question: string, fallback: string, opts: { secret?: boolean } = {}) => {
    const shown = fallback === '' ? '' : ` [${opts.secret === true ? 'keep current' : fallback}]`;
    const answer = (await io.prompt(`${question}${shown}: `, opts)).trim();
    return answer === '' ? fallback : answer;
  };

  const serverInput =
    values.server ?? (await ask('Server URL (https://...)', existing?.serverUrl ?? ''));
  if (serverInput.trim() === '')
    throw new ConnectorError('A server address is required.', EXIT.USAGE);
  const serverUrl = normalizeServerUrl(serverInput);

  const tokenInput =
    values.token ??
    (await ask('Device token (Settings > Integrations > Devices)', existing?.token ?? '', {
      secret: true,
    }));
  const token = checkToken(tokenInput);

  const mailboxes =
    values.mailbox !== undefined
      ? values.mailbox.flatMap(mailboxList)
      : mailboxList(
          await ask(
            'Mailboxes to read, comma-separated',
            existing?.mailboxes.join(', ') ?? 'Inbox',
          ),
        );
  if (mailboxes.length === 0) throw new ConnectorError('Name at least one mailbox.', EXIT.USAGE);

  const daysInput =
    values.days ??
    (interactive
      ? await ask(
          'Lookback window for the first sync, in days',
          String(existing?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS),
        )
      : String(existing?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS));
  const lookbackDays = wholeNumber(daysInput, 'The lookback window', MAX_LOOKBACK_DAYS);
  const intervalMinutes =
    values.interval === undefined
      ? (existing?.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES)
      : wholeNumber(values.interval, 'The interval', MAX_INTERVAL_MINUTES);

  const config: ConnectorConfig = { serverUrl, token, mailboxes, lookbackDays, intervalMinutes };
  await saveConfig(io, config);
  io.stdout(`Saved ${configFiles(io.configDir).config} (readable only by you).`);
  if (existing !== null && widens(existing, config)) {
    // The cursor only covers what was read before: older mail in a new mailbox, or in the
    // longer window, would never be reached from it.
    await saveState(io, { cursor: null });
    io.stdout(
      'You added a mailbox or lengthened the lookback window, so the sync position was ' +
        'reset: the next sync re-reads the whole lookback window (the server skips ' +
        'messages it already has).',
    );
  }

  // An empty batch exercises auth and scope without sending any mail.
  const res = await pushBatch(io, config, []);
  switch (res.kind) {
    case 'ok':
      io.stdout(`Token accepted by ${serverUrl}.`);
      io.stdout('Run `opportun-connector sync` to push mail now, or `watch` to keep syncing.');
      return EXIT.OK;
    case 'unauthorized':
      throw new ConnectorError(TOKEN_REJECTED, EXIT.AUTH);
    case 'forbidden':
      throw new ConnectorError(
        'The token was accepted but lacks the mail:push scope; create one for the Apple Mail ' +
          'connector in Settings > Integrations > Devices and run init again.',
        EXIT.AUTH,
      );
    case 'rate_limited':
      throw new ConnectorError(
        'The server is rate limiting this token; the config is saved, try `sync` later.',
        EXIT.SERVER,
      );
    case 'server_error':
      throw new ConnectorError(
        `The server answered with an error (${res.status}); the config is saved, try again later.`,
        EXIT.SERVER,
      );
    case 'network_error':
      throw new ConnectorError(
        `Could not reach ${serverUrl}: ${res.message}. The config is saved; check the address.`,
        EXIT.SERVER,
      );
    default:
      throw new ConnectorError(
        `Unexpected answer from ${serverUrl} (HTTP ${'status' in res ? res.status : 413}). ` +
          'Is this an Opportun server, and is it up to date?',
        EXIT.FAILURE,
      );
  }
}

const describe = (s: SyncSummary): string =>
  `Apple Mail sync: ${s.found} found, ${s.pushed} pushed (${s.inserted} new)` +
  (s.skipped > 0 ? `, ${s.skipped} skipped.` : '.');

async function sync(io: ConnectorIo, args: string[], signal?: AbortSignal): Promise<ExitCode> {
  parseArgs({ args, strict: true, options: {} });
  const config = await loadConfig(io);
  io.stdout(describe(await syncOnce(io, config, { signal })));
  return EXIT.OK;
}

async function watch(io: ConnectorIo, args: string[], signal?: AbortSignal): Promise<ExitCode> {
  const { values } = parseArgs({ args, strict: true, options: { interval: { type: 'string' } } });
  const override =
    values.interval === undefined
      ? undefined
      : wholeNumber(values.interval, 'The interval', MAX_INTERVAL_MINUTES);
  const stamp = () => new Date(io.clock.now()).toISOString();
  while (signal?.aborted !== true) {
    // Re-read every cycle: a re-run of `init` (say, with a new token) applies without a restart.
    const config = await loadConfig(io);
    try {
      io.stdout(`${stamp()} ${describe(await syncOnce(io, config, { signal }))}`);
    } catch (err) {
      // A bad token or config will not fix itself: stop and say so. Anything else (server
      // down, Mail busy) is retried next cycle.
      if (
        err instanceof ConnectorError &&
        (err.exitCode === EXIT.AUTH || err.exitCode === EXIT.USAGE)
      ) {
        throw err;
      }
      io.stderr(`${stamp()} ${(err as Error).message}`);
    }
    const minutes = override ?? config.intervalMinutes;
    const jitter = 1 - JITTER + 2 * JITTER * io.random();
    await io.clock.sleep(Math.round(minutes * 60_000 * jitter), signal);
  }
  return EXIT.OK;
}

export async function main(
  argv: string[],
  io: ConnectorIo,
  opts: { signal?: AbortSignal } = {},
): Promise<ExitCode> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'init':
        return await init(io, rest);
      case 'sync':
        return await sync(io, rest, opts.signal);
      case 'watch':
        return await watch(io, rest, opts.signal);
      case '-h':
      case '--help':
      case 'help':
        io.stdout(USAGE);
        return EXIT.OK;
      case '-v':
      case '--version':
        io.stdout(VERSION);
        return EXIT.OK;
      default:
        throw usageError(
          command === undefined ? 'No command given.' : `Unknown command: ${redact(command)}`,
        );
    }
  } catch (err) {
    if (err instanceof ConnectorError) {
      io.stderr(err.message);
      return err.exitCode;
    }
    // parseArgs reports unknown or malformed flags with these codes.
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS')) {
      // parseArgs quotes the offending argument, which may be a misplaced token.
      const message = (err as Error).message.replace(
        /'([^']*)'/g,
        (_m, v: string) => `'${redact(v)}'`,
      );
      io.stderr(`${maskTokens(message)}\n\n${USAGE}`);
      return EXIT.USAGE;
    }
    io.stderr(`Unexpected error: ${(err as Error).message}`);
    return EXIT.FAILURE;
  }
}
