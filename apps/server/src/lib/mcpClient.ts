// MCP client for discovery sources (ADR-7). One call = connect, call one tool, disconnect, all
// under one deadline (30 s by default). Two transports:
//   - stdio: the user's own command, spawned without a shell (execFile semantics: the command and
//     each argument are passed as-is, nothing is interpreted), with an environment of PATH only
//     (no secrets, no master key, no tokens), in its own process group. On completion, error or
//     timeout the group is sent SIGTERM, then SIGKILL after a grace period, and the call returns
//     only after the child has exited and been reaped.
//   - http (streamable HTTP): https only; prohibited hosts (PROHIBITED_HOSTS) refused; every address
//     the host resolves to must be public; redirects are not followed; responses are size-capped.
// Tool output is untrusted data; callers map and sanitize it.
import { spawn, type ChildProcess } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult, JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { FetchBlockedError, isPrivateAddress, isProhibitedHost } from './safeFetch';

export const MCP_TIMEOUT_MS = 30_000;
/** Largest single message (and largest HTTP response body) accepted from a server. */
export const MCP_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
/** Between SIGTERM and SIGKILL when closing a stdio server. */
const KILL_GRACE_MS = 2_000;

export type McpServerConfig =
  { transport: 'stdio'; command: string; args: string[] } | { transport: 'http'; url: string };

export class McpTimeoutError extends Error {
  override name = 'McpTimeoutError';
}

// ---------------------------------------------------------------------------
// stdio

/**
 * The child's environment: PATH and nothing else, out of `ambient` (defaults to the real
 * process.env). Takes the ambient environment as a parameter, not just a default, so a test can
 * supply a literal object instead of mutating the real process.env to prove something in it does
 * not leak through (issue #298): vitest's threads pool shares process.env with every test file
 * scheduled onto the same worker, so a mutation there is a cross-file hazard even restored after.
 */
export function minimalEnv(ambient: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { PATH: ambient.PATH ?? '/usr/local/bin:/usr/bin:/bin' };
}

/**
 * A stdio transport with the process controls the SDK's own one does not offer: a PATH-only
 * environment, no shell, a process group, and a close() that resolves once the child is gone.
 */
export class MinimalStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private child: ChildProcess | undefined;
  private exited: Promise<void> | undefined;
  private readonly buffer = new ReadBuffer({ maxBufferSize: MCP_MAX_MESSAGE_BYTES });
  private closed = false;

  constructor(
    private readonly command: string,
    private readonly args: readonly string[],
    private readonly onSpawn?: (pid: number) => void,
    private readonly ambientEnv?: NodeJS.ProcessEnv,
  ) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, [...this.args], {
        shell: false,
        env: minimalEnv(this.ambientEnv),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
      this.child = child;
      this.exited = new Promise((done) => {
        // 'exit' is emitted once Node has collected the child's status: it is reaped. (Not
        // 'close', which also waits for pipes a stray descendant could hold open.)
        child.once('exit', () => done());
      });
      child.once('error', (err) => {
        if (child.pid === undefined) {
          // Never started (e.g. ENOENT): there is no process to wait for.
          this.exited = Promise.resolve();
          reject(err);
        } else {
          this.onerror?.(err);
        }
      });
      child.once('spawn', () => {
        if (child.pid !== undefined) this.onSpawn?.(child.pid);
        resolve();
      });
      child.once('exit', () => {
        if (!this.closed) {
          this.closed = true;
          this.onclose?.();
        }
      });
      child.stdout?.on('data', (chunk: Buffer) => {
        try {
          this.buffer.append(chunk);
          for (;;) {
            const message = this.buffer.readMessage();
            if (message === null) break;
            this.onmessage?.(message);
          }
        } catch (err) {
          this.onerror?.(err instanceof Error ? err : new Error(String(err)));
          void this.close();
        }
      });
      // Diagnostics are not used; drain them so the child never blocks on a full pipe.
      child.stderr?.resume();
      child.stdin?.on('error', (err) => this.onerror?.(err));
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.child?.stdin;
      if (stdin == null || stdin.destroyed) {
        reject(new Error('MCP server is not running'));
        return;
      }
      if (stdin.write(serializeMessage(message))) resolve();
      else stdin.once('drain', () => resolve());
    });
  }

  private signal(sig: NodeJS.Signals): void {
    const child = this.child;
    if (child?.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    try {
      // The whole group, so anything the server started goes too.
      if (process.platform !== 'win32') process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {
      child.kill(sig);
    }
  }

  /** Stops the server and resolves once it has exited and been reaped. */
  async close(): Promise<void> {
    const child = this.child;
    if (child !== undefined) {
      child.stdin?.end();
      this.signal('SIGTERM');
      let timer: NodeJS.Timeout | undefined;
      const graceOver = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), KILL_GRACE_MS);
      });
      const outcome = await Promise.race([this.exited?.then(() => 'exited' as const), graceOver]);
      clearTimeout(timer);
      if (outcome === 'timeout') {
        this.signal('SIGKILL');
        await this.exited;
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
    }
    this.buffer.clear();
    if (!this.closed) {
      this.closed = true;
      this.onclose?.();
    }
  }
}

// ---------------------------------------------------------------------------
// http

export interface HttpGuardDeps {
  resolve(host: string): Promise<string[]>;
  fetch: typeof fetch;
}

const realHttpDeps: HttpGuardDeps = {
  resolve: async (host) =>
    (await lookup(host, { all: true, verbatim: true })).map((a) => a.address),
  fetch: (input, init) => fetch(input, init),
};

/** Checks a URL the HTTP transport is about to request; throws FetchBlockedError. */
export async function checkMcpUrl(raw: string | URL, deps: HttpGuardDeps): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchBlockedError('scheme', 'not a valid URL');
  }
  if (url.protocol !== 'https:') throw new FetchBlockedError('scheme', url.protocol);
  if (url.username !== '' || url.password !== '') {
    throw new FetchBlockedError('scheme', 'credentials in URL');
  }
  const host = url.hostname.toLowerCase();
  if (isProhibitedHost(host)) throw new FetchBlockedError('host_not_allowed', host);
  const literal = host.startsWith('[') ? host.slice(1, -1) : host;
  const addresses = isIP(literal) !== 0 ? [literal] : await deps.resolve(host);
  const bad = addresses.find((a) => isPrivateAddress(a));
  if (addresses.length === 0 || bad !== undefined) {
    throw new FetchBlockedError('private_address', `${host} -> ${bad ?? 'nothing'}`);
  }
  return url;
}

async function cappedBody(res: Response, maxBytes: number): Promise<Uint8Array> {
  if (res.body === null) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new FetchBlockedError('too_large', `over ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * The fetch the HTTP transport uses: every request URL checked, no redirects followed, bodies
 * buffered under a cap. The optional standalone GET event stream is declined (405), which the
 * transport treats as "not offered"; one tool call needs only POST responses.
 */
export function guardedMcpFetch(deps: HttpGuardDeps = realHttpDeps) {
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = await checkMcpUrl(input, deps);
    if ((init?.method ?? 'GET').toUpperCase() === 'GET') {
      return new Response(null, { status: 405 });
    }
    const res = await deps.fetch(url, { ...init, redirect: 'manual' });
    const body = await cappedBody(res, MCP_MAX_MESSAGE_BYTES);
    return new Response(res.status === 204 || res.status === 304 ? null : body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
}

// ---------------------------------------------------------------------------

export interface CallOptions {
  timeoutMs?: number;
  /** Replaces DNS and the network for the http transport (tests). */
  http?: HttpGuardDeps;
  /** Sees the stdio child's pid once it is running (tests check it is gone afterwards). */
  onSpawn?: (pid: number) => void;
  /** Replaces the ambient environment minimalEnv restricts from, for the stdio transport
   *  (tests; issue #298): lets a test prove something does not leak through without mutating
   *  the real process.env. */
  env?: NodeJS.ProcessEnv;
}

async function transportFor(server: McpServerConfig, opts: CallOptions): Promise<Transport> {
  if (server.transport === 'stdio') {
    return new MinimalStdioTransport(server.command, server.args, opts.onSpawn, opts.env);
  }
  // Refuse before anything is constructed: plain http, prohibited or private hosts.
  const url = await checkMcpUrl(server.url, opts.http ?? realHttpDeps);
  return new StreamableHTTPClientTransport(url, {
    fetch: guardedMcpFetch(opts.http ?? realHttpDeps),
  });
}

/** Connects, calls `tool` with `args`, disconnects; everything within one deadline. */
export async function callMcpTool(
  server: McpServerConfig,
  tool: string,
  args: Record<string, string>,
  opts: CallOptions = {},
): Promise<CallToolResult> {
  const timeoutMs = opts.timeoutMs ?? MCP_TIMEOUT_MS;
  const transport = await transportFor(server, opts);
  const client = new Client({ name: 'opportun', version: '1' }, { capabilities: {} });
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new McpTimeoutError(`MCP server did not answer within ${timeoutMs} ms`));
    }, timeoutMs);
  });
  const work = (async () => {
    const request = { signal: controller.signal, timeout: timeoutMs };
    await client.connect(transport, request);
    return (await client.callTool(
      { name: tool, arguments: args },
      undefined,
      request,
    )) as CallToolResult;
  })();
  // A rejection after the deadline won must not go unhandled.
  work.catch(() => undefined);
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    // Client.close closes the transport: for stdio that waits until the child is reaped.
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}
