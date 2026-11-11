// The one logger configuration, and the gate in its destination (design.md 14.8, 14.9;
// https://github.com/bgoleno/opportun/issues/345, FR-T5, NFR-PRV6).
//
// Every log record Opportun writes, its own and any library's, passes through the destination
// below before it is written, whether or not collection is on. A pino formatter would be too early:
// it never sees the message, a child logger's bindings or what the error serializer writes. So the
// destination rebuilds each finished line instead:
//
// - the message is kept only when the catalog lists it (LOG_MESSAGES, or an event's name); any
//   other message, such as one a library builds from a request, becomes WITHHELD and is counted;
// - the keys kept are those the catalog lists for that message, each with a value of its type
//   (obs/gate.ts); a record whose message is not catalogued keeps none;
// - an error is reduced to its type and its frame lines: a frame inside the install root keeps its
//   path relative to it, a frame outside loses its path, and every other line of a stack (where a
//   message can quote data) is dropped. The error's message and extra properties never pass;
// - the time, the level and the active trace id are kept. pino's pid and hostname are never
//   written (`base: null`): a host name is often a person's (14.8).
//
// The rule is the absence of a field, not a pattern that hunts for personal data. A key that is
// not catalogued for Opportun's own message is dropped and counted in production, and throws under
// the test runner (obs/gate.ts), so a mistake at a call site fails CI.
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trace } from '@opentelemetry/api';
import { pino, type Logger } from 'pino';
import {
  type AttrKey,
  type DropReason,
  eventDef,
  EVENTS,
  LOG_MESSAGES,
  type Signal,
} from './catalog';
import { gateAttributes } from './gate';

/** What replaces a message the catalog does not list. */
export const WITHHELD = '[message withheld]';

/** A destination for log lines: stdout, or what a test captures. */
export interface LogLineSink {
  write(line: string): void;
}

/** The root every frame path is made relative to: the repository (or the image's /app). */
const INSTALL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const TRACE_ID = /^[0-9a-f]{32}$/;
const CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_FRAMES = 20;
/** One segment of a function's name in a frame: an identifier, as V8 writes one from code. */
const NAME_SEGMENT = /^[A-Za-z_$][\w$]{0,60}$/;
const LINE_COL = /^\d{1,7}$/;

/**
 * A function name in a frame, as V8 writes one from code: an identifier path (`Object.run`,
 * `Object.<anonymous>`), optionally after `async ` or `new `, optionally `[as name]`. Anything
 * else (a name with spaces, a person's) is not kept. Checked part by part, with no pattern that
 * could backtrack on a long line.
 */
function functionName(raw: string): string | undefined {
  let rest = raw;
  let suffix = '';
  const as = rest.lastIndexOf(' [as ');
  if (as >= 0 && rest.endsWith(']')) {
    const alias = rest.slice(as + 5, -1);
    if (!NAME_SEGMENT.test(alias)) return undefined;
    suffix = ` [as ${alias}]`;
    rest = rest.slice(0, as);
  }
  let prefix = '';
  for (const p of ['async ', 'new ']) {
    if (rest.startsWith(p)) {
      prefix = p;
      rest = rest.slice(p.length);
    }
  }
  const parts = rest.split('.');
  if (parts.length > 5) return undefined;
  const ok = parts.every((part, i) =>
    i > 0 && part === '<anonymous>' ? true : NAME_SEGMENT.test(part),
  );
  return ok ? `${prefix}${rest}${suffix}` : undefined;
}

/** `at fn (path:line:col)` or `at path:line:col`, split without a backtracking pattern. */
function parseFrame(
  line: string,
): { fn: string | undefined; path: string; row: string; col: string } | undefined {
  if (!line.startsWith('at ')) return undefined;
  let body = line.slice(3);
  let fn: string | undefined;
  const open = body.lastIndexOf(' (');
  if (open >= 0 && body.endsWith(')')) {
    fn = body.slice(0, open);
    body = body.slice(open + 2, -1);
  }
  const colAt = body.lastIndexOf(':');
  const rowAt = colAt > 0 ? body.lastIndexOf(':', colAt - 1) : -1;
  if (rowAt <= 0) return undefined;
  const row = body.slice(rowAt + 1, colAt);
  const col = body.slice(colAt + 1);
  if (!LINE_COL.test(row) || !LINE_COL.test(col)) return undefined;
  return { fn, path: body.slice(0, rowAt), row, col };
}

/**
 * What stands for each run of frames outside the install root: fixed text, never built from the
 * frame (sec on #381), so it shows where a call left Opportun's code and carries nothing else.
 */
export const EXTERNAL_FRAME = 'at <external>';

/**
 * Whether a stack's first lines are the header written for this message: `<name>: <message>`, or
 * for an empty one (and for a record with no message, such as gateHeldError's) the name alone,
 * or the name and `: ` as a stack formatter other than V8's own writes it (vitest's). A stack is
 * formatted on its first read, with the message of that moment, so code that reassigns the
 * message afterwards leaves a header that no longer matches (#381).
 */
function headerMatches(header: string, message: string): boolean {
  if (message !== '') return header.endsWith(`: ${message}`);
  const name = header.endsWith(': ') ? header.slice(0, -2) : header;
  return !name.includes(': ') && !name.includes('\n');
}

/**
 * The messages a stack's header may have been written with, longest first: the message as pino
 * gives it, then each shorter prefix ending where pino joined a cause's message to it
 * (`outer: inner`, pino-std-serializers' messageWithCauses), as a stack's header holds the
 * error's own message only (tl on #389). The error's own message is always one of them.
 */
function headerMessages(message: string): string[] {
  const out = [message];
  for (let at = message.lastIndexOf(': '); at > 0; at = message.lastIndexOf(': ', at - 1)) {
    out.push(message.slice(0, at));
  }
  return out;
}

/** How many lines the stack's header has, for the first of headerMessages it matches. */
function headerLength(lines: readonly string[], message: string): number | undefined {
  for (const candidate of headerMessages(message)) {
    const length = candidate.split('\n').length;
    if (headerMatches(lines.slice(0, length).join('\n'), candidate)) return length;
  }
  return undefined;
}

/**
 * A V8 frame with no location to give: a builtin's (`at JSON.parse (<anonymous>)`, `(native)`),
 * an `async Promise.all (index 0)`, or `at <anonymous>`. Never ours, so it stands as
 * EXTERNAL_FRAME, and the frames after it are still read (tl on #389).
 */
function isLocationless(line: string): boolean {
  if (line === 'at <anonymous>') return true;
  if (!line.startsWith('at ')) return false;
  if (line.endsWith(' (<anonymous>)') || line.endsWith(' (native)')) return true;
  const at = line.lastIndexOf(' (index ');
  if (at < 0 || !line.endsWith(')')) return false;
  const digits = line.slice(at + ' (index '.length, -1);
  return digits.length > 0 && [...digits].every((c) => c >= '0' && c <= '9');
}

/**
 * The frame lines of a stack, paths made relative to the install root (14.8). A V8 stack begins
 * with the error's name and message, which can quote data and can be shaped like a frame (sec on
 * #376): those lines are skipped by count, never parsed, and only when they are the header of the
 * current message; any other stack gives no frames at all, rather than a miscount that would read
 * message lines as frames (#381). Only the frames right after the header are taken, so a cause's
 * text appended below them (`caused by: ...`) is not read either.
 *
 * A frame inside the install root keeps its function name and relative path. A frame outside it
 * keeps neither, not even its name: one message case the header check cannot see (a message cut
 * to its own first lines after the stack was read) still leaves its old lines to parse as frames,
 * and their paths are not ours. Each run of such frames is one EXTERNAL_FRAME, so a dependency's
 * or Node's frames never fill the cap.
 */
export function frameLines(stack: unknown, message?: unknown): string[] {
  if (typeof stack !== 'string') return [];
  const lines = stack.split('\n');
  const header = headerLength(lines, typeof message === 'string' ? message : '');
  if (header === undefined) return [];
  const out: string[] = [];
  for (const raw of lines.slice(header)) {
    const line = raw.trim();
    const frame = parseFrame(line);
    if (frame === undefined && isLocationless(line)) {
      if (out.at(-1) !== EXTERNAL_FRAME) out.push(EXTERNAL_FRAME);
      continue;
    }
    if (frame === undefined) break;
    if (!frame.path.startsWith(INSTALL_ROOT + sep)) {
      if (out.at(-1) !== EXTERNAL_FRAME) out.push(EXTERNAL_FRAME);
    } else {
      const name = frame.fn === undefined ? undefined : functionName(frame.fn);
      const where = `${relative(INSTALL_ROOT, frame.path).split(sep).join('/')}:${frame.row}:${frame.col}`;
      out.push(`at ${[name, `(${where})`].filter(Boolean).join(' ')}`);
    }
    if (out.length >= MAX_FRAMES) break;
  }
  return out;
}

/** The keys every record may have, whatever its message: written by pino or by this gate. */
const STRUCTURAL = new Set(['level', 'time', 'msg', 'trace_id', 'err']);

/**
 * Bindings a library puts on every record of a child logger, whatever the call site wrote:
 * Fastify's request counter on `req.log`. Never kept and never a call site's mistake, so they are
 * dropped without counting and without throwing under the test runner.
 */
const LIBRARY_BINDINGS = new Set(['reqId']);

export type LogDropCounter = (signal: Signal, reason: DropReason) => void;

/**
 * One finished pino line, rebuilt from the catalog. Returns the line to write, or undefined when
 * the input is not a JSON record (it is dropped and counted: nothing unread is ever passed on).
 */
export function gateLogLine(line: string, dropped: LogDropCounter): string | undefined {
  let record: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    record = parsed as Record<string, unknown>;
  } catch {
    dropped('logs', 'invalid_value');
    return undefined;
  }
  const out: Record<string, unknown> = {};
  if (typeof record.level === 'number') out.level = record.level;
  if (typeof record.time === 'number') out.time = record.time;

  const msg = typeof record.msg === 'string' ? record.msg : undefined;
  const eventName = typeof record.event === 'string' ? record.event : undefined;
  const isEvent = eventName !== undefined && eventName === msg && Object.hasOwn(EVENTS, eventName);
  const allowed: readonly AttrKey[] | undefined = isEvent
    ? [...eventDef(eventName as keyof typeof EVENTS).fields, 'user.id']
    : msg === undefined
      ? undefined
      : LOG_MESSAGES.get(msg);

  if (msg !== undefined) {
    if (allowed === undefined) {
      out.msg = WITHHELD;
      dropped('logs', 'message_withheld');
    } else {
      out.msg = msg;
    }
  }
  if (isEvent) out.event = eventName;

  const rest = new Map<string, unknown>();
  for (const [key, value] of Object.entries(record)) {
    if (STRUCTURAL.has(key) || key === 'event' || LIBRARY_BINDINGS.has(key)) continue;
    if (allowed === undefined) {
      // Not Opportun's own catalogued record (a library's): nothing of it is kept but its shape.
      dropped('logs', 'unknown_key');
      continue;
    }
    rest.set(key, value);
  }
  if (allowed !== undefined) {
    Object.assign(
      out,
      gateAttributes('logs', allowed, Object.fromEntries(rest), dropped, { localLog: true }),
    );
  }

  const err = record.err;
  if (typeof err === 'object' && err !== null) {
    const type = (err as { type?: unknown }).type;
    if (typeof type === 'string' && CODE.test(type)) out['error.type'] = type;
    const frames = frameLines(
      (err as { stack?: unknown }).stack,
      (err as { message?: unknown }).message,
    );
    if (frames.length > 0) out.stack = frames;
  }
  if (typeof record.trace_id === 'string' && TRACE_ID.test(record.trace_id)) {
    out.trace_id = record.trace_id;
  }
  return `${JSON.stringify(out)}\n`;
}

let countDropped: LogDropCounter = () => undefined;

/** Set by obs/index.ts: where the destination counts what it drops (opportun.obs.dropped). */
export function setLogDropCounter(counter: LogDropCounter): void {
  countDropped = counter;
}

/** The destination every log line goes through: the gate, then `out`. */
export function gatedDestination(out: LogLineSink): LogLineSink {
  return {
    write(line: string) {
      // pino writes one line per call; a chunk of several is split rather than rejected.
      for (const one of line.split('\n')) {
        if (one.trim() === '') continue;
        const gated = gateLogLine(one, countDropped);
        if (gated !== undefined) out.write(gated);
      }
    },
  };
}

/** The active span's trace id, on every record written inside one (14.9). */
function traceMixin(): Record<string, string> {
  const ctx = trace.getActiveSpan()?.spanContext();
  return ctx !== undefined && trace.isSpanContextValid(ctx) ? { trace_id: ctx.traceId } : {};
}

/**
 * The logger options: for Fastify (app.ts) and for anything else that logs. `stream` is where the
 * gated lines go: process.stdout unless a test captures them.
 */
export function loggerOptions(opts: { level: string; stream?: LogLineSink }) {
  return {
    level: opts.level,
    base: null,
    mixin: traceMixin,
    stream: gatedDestination(opts.stream ?? process.stdout),
  };
}

/**
 * A logger for what logs outside Fastify (the process before the app exists, the database's own
 * warnings): the same options and the same gated destination as app.log.
 */
export function createLogger(opts: { level: string; stream?: LogLineSink }): Logger {
  const { stream, ...options } = loggerOptions(opts);
  return pino(options, stream);
}

/** What the access log line of one request may say (design 14.9). */
export interface RequestLine {
  method: string;
  /** The route's template as registered (`/api/v1/opportunities/:id`), never the request's path. */
  route: string | undefined;
  statusCode: number;
  /** The request's address: the log-only `client.address` (14.8), never stored or exported. */
  ip: string | undefined;
  /** The route's parameters: only an `id` that is a row id is written. */
  params: unknown;
}

/** The minimal logger logRequest writes to: app.log, or a request's child of it. */
export interface InfoLogger {
  info(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Opportun's own access log line (design 14.9), written by the HTTP plugin when a request ends:
 * the method, the route template, the status, the route's id and the request's address. Fastify's
 * own request logging, which writes the raw URL, is off. The gate (above) checks every value.
 */
export function logRequest(log: InfoLogger, line: RequestLine): void {
  const id =
    typeof line.params === 'object' && line.params !== null
      ? (line.params as { id?: unknown }).id
      : undefined;
  log.info(
    {
      'http.request.method': line.method.toUpperCase(),
      'http.route': line.route ?? '_OTHER',
      'http.response.status_code': line.statusCode,
      ...(line.ip === undefined ? {} : { 'client.address': line.ip }),
      ...(typeof id === 'string' ? { 'opportun.route.id': id } : {}),
    },
    'request completed',
  );
}

let process_logger: Logger | undefined;

/**
 * The logger for what logs with no app at hand (a library seam, a CLI, the database's default
 * reporters): created on first use, with the same options and gate as app.log.
 */
export function processLogger(): Logger {
  // stderr, as the console.warn it replaces wrote: a CLI's own output (a reset password, a copy's
  // report) keeps stdout to itself.
  return (process_logger ??= createLogger({
    level: process.env.LOG_LEVEL ?? 'info',
    stream: process.stderr,
  }));
}

/**
 * The process's own last words, through the gate (sec on #376): Node would print an uncaught
 * error's stack, message and properties to stderr, and every warning's text. With these handlers
 * an uncaught exception or unhandled rejection is one gated line (its type and frames) and then
 * the exit Node would make, and a warning is its type and code only. Installed by the server
 * process (index.ts), not by tests or CLIs.
 */
export function installProcessHandlers(): void {
  // A line written just before exiting must reach stderr first: on a pipe that write can be
  // asynchronous, so the crash path exits from the write's callback (or after a second at most).
  const exitAfter = (): LogLineSink => ({
    write(line: string) {
      process.stderr.write(line, () => process.exit(1));
    },
  });
  const crash = (msg: string, err: unknown): void => {
    setTimeout(() => process.exit(1), 1_000).unref();
    createLogger({ level: 'fatal', stream: exitAfter() }).fatal({ err }, msg);
  };
  process.on('uncaughtException', (err) => crash('uncaught exception', err));
  process.on('unhandledRejection', (reason) =>
    crash(
      'unhandled rejection',
      reason instanceof Error ? reason : { type: typeof reason === 'object' ? 'Object' : 'Value' },
    ),
  );
  // Node's own listener prints the warning's text: replaced by one that names it only.
  process.removeAllListeners('warning');
  process.on('warning', (warning) => {
    processLogger().warn(
      {
        'opportun.warning.type': warning.name,
        'opportun.warning.code': (warning as { code?: unknown }).code,
      },
      'process warning',
    );
  });
}
