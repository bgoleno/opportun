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
/** `at fn (path:line:col)` or `at path:line:col`. */
const FRAME = /^at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/;
/**
 * A function name in a frame, as V8 writes one from code: an identifier path, optionally after
 * `async ` or `new `, optionally `[as name]`. Anything else (a name with spaces) is not kept.
 */
const FUNCTION_NAME =
  /^(?:async |new )?[A-Za-z_$][\w$]{0,60}(?:\.(?:<anonymous>|[\w$]{1,60})){0,4}(?: \[as [\w$]{1,60}\])?$/;
const MAX_FRAMES = 20;

/** The frame lines of a stack, paths made relative to the install root or dropped (14.8). */
export function frameLines(stack: unknown): string[] {
  if (typeof stack !== 'string') return [];
  const out: string[] = [];
  for (const raw of stack.split('\n')) {
    const line = raw.trim();
    const m = FRAME.exec(line);
    if (m === null) continue;
    const [, fn, path, row, col] = m;
    const name = fn !== undefined && FUNCTION_NAME.test(fn) ? fn : undefined;
    const inside = path !== undefined && path.startsWith(INSTALL_ROOT + sep);
    const where = inside
      ? `${relative(INSTALL_ROOT, path).split(sep).join('/')}:${row}:${col}`
      : '';
    if (name === undefined && where === '') continue;
    out.push(`at ${[name, where === '' ? undefined : `(${where})`].filter(Boolean).join(' ')}`);
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

  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (STRUCTURAL.has(key) || key === 'event' || LIBRARY_BINDINGS.has(key)) continue;
    if (allowed === undefined) {
      // Not Opportun's own catalogued record (a library's): nothing of it is kept but its shape.
      dropped('logs', 'unknown_key');
      continue;
    }
    rest[key] = value;
  }
  if (allowed !== undefined) {
    Object.assign(out, gateAttributes('logs', allowed, rest, dropped, { localLog: true }));
  }

  const err = record.err;
  if (typeof err === 'object' && err !== null) {
    const type = (err as { type?: unknown }).type;
    if (typeof type === 'string' && CODE.test(type)) out['error.type'] = type;
    const frames = frameLines((err as { stack?: unknown }).stack);
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
