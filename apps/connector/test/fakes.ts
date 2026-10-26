// In-memory stand-ins for every I/O seam, so the suite runs on any platform without Mail,
// a network or a real home directory.
import type {
  Clock,
  ConnectorIo,
  FetchInit,
  FileSystem,
  HttpResponse,
  OsascriptResult,
} from '../src/types';

export class MemFs implements FileSystem {
  files = new Map<string, { text: string; mode: number }>();
  dirs = new Map<string, number>();
  writes: string[] = [];
  async readText(path: string): Promise<string | null> {
    return this.files.get(path)?.text ?? null;
  }
  async writeText(path: string, text: string, mode: number): Promise<void> {
    this.writes.push(path);
    this.files.set(path, { text, mode });
  }
  async mkdir(path: string, mode: number): Promise<void> {
    this.dirs.set(path, mode);
  }
}

export class FakeClock implements Clock {
  t: number;
  sleeps: number[] = [];
  constructor(start = Date.UTC(2026, 9, 17, 12, 0, 0)) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    this.sleeps.push(ms);
    this.t += ms;
    if (signal?.aborted === true) return;
  }
}

export interface Call {
  url: string;
  init: FetchInit;
  body: { messages: Array<Record<string, unknown>> };
}

export type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;

export function response(reply: Exclude<Reply, Error>): HttpResponse {
  const headers = new Map(
    Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    status: reply.status,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    text: async () => (reply.body === undefined ? '' : JSON.stringify(reply.body)),
  };
}

/** A fetch that answers from a script of replies (the last one repeats) and records calls. */
export function scriptedFetch(replies: Reply[]) {
  const calls: Call[] = [];
  let i = 0;
  const fetch = async (url: string, init: FetchInit): Promise<HttpResponse> => {
    calls.push({ url, init, body: JSON.parse(init.body) as Call['body'] });
    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    if (reply === undefined) throw new Error('no scripted reply');
    if (reply instanceof Error) throw reply;
    return response(reply);
  };
  return { fetch, calls };
}

export const ok = (stored = 0, inserted = 0): Reply => ({
  status: 200,
  body: { stored, inserted },
});

export interface RawFixture {
  id: string;
  subject?: string;
  sender?: string;
  recipients?: unknown;
  dateReceived: string;
  dateSent?: string;
  body?: string;
}

export function raw(n: number, overrides: Partial<RawFixture> = {}): RawFixture {
  return {
    id: `<msg-${n}@mail.example>`,
    subject: `Role ${n}`,
    sender: 'Recruiter <recruiter@initech.example>',
    recipients: [{ name: 'Me', address: 'me@home.example' }],
    dateReceived: new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString(),
    body: `Hello ${n}`,
    ...overrides,
  };
}

/** An osascript stand-in that prints the given raw messages as JSON lines (one page). */
/** A line the JXA script prints for a message it could not read (review F3). */
export const skippedLine = (n: number, error = 'Mail got an error: timeout') => ({
  skipped: raw(n).dateReceived,
  error,
});

export function osascriptReturning(pages: object[][], code = 0, stderr = '') {
  const calls: string[][] = [];
  let i = 0;
  const run = async (args: string[]): Promise<OsascriptResult> => {
    calls.push(args);
    const page = pages[Math.min(i, pages.length - 1)] ?? [];
    i += 1;
    return { code, stdout: page.map((m) => JSON.stringify(m)).join('\n') + '\n', stderr };
  };
  return { run, calls };
}

export function makeIo(overrides: Partial<ConnectorIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const fs = new MemFs();
  const clock = new FakeClock();
  const io: ConnectorIo = {
    fs,
    clock,
    fetch: scriptedFetch([ok()]).fetch,
    osascript: osascriptReturning([[]]).run,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    random: () => 0.5,
    configDir: '/home/me/.config/opportun-connector',
    prompt: async () => {
      throw new Error('unexpected prompt');
    },
    ...overrides,
  };
  return { io, out, err, fs, clock };
}

export const TOKEN = `odt_${'A'.repeat(43)}`;

export const CONFIG = {
  serverUrl: 'https://opportun.example',
  token: TOKEN,
  mailboxes: ['Inbox'],
  lookbackDays: 30,
  intervalMinutes: 15,
};

export async function withConfig(fs: MemFs, config: object = CONFIG, state?: object) {
  const dir = '/home/me/.config/opportun-connector';
  await fs.writeText(`${dir}/config.json`, JSON.stringify(config), 0o600);
  if (state !== undefined) await fs.writeText(`${dir}/state.json`, JSON.stringify(state), 0o600);
}
