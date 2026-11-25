// MCP discovery sources (Task 11, FR-D1/D2, ADR-7/12). A fake MCP server (test/fixtures/mcp,
// spawned over stdio through the real client) serves tool output; the adapter maps it through
// the configured paths, caps hostile strings, and the engine sanitizes what is stored. The child
// runs without a shell and with PATH only, and is gone (reaped) after every call, including a
// call that times out against a server that ignores SIGTERM.
import { enqueue } from '../src/lib/jobQueue';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NormalizedPosting } from '@opportun/core';
import { afterEach, describe, expect, it, onTestFinished, vi, type MockInstance } from 'vitest';
import { resetSources, type SourceContext } from '../src/adapters/discoverySource';
import { MCP_FIELD_CAPS, mcpSource, valueAt } from '../src/adapters/sources/mcp';
import { McpConfigSchema } from '../src/adapters/sources/mcpConfig';
import { DISCOVERY_RUN_KIND } from '../src/jobs/discoveryRun';
import {
  callMcpTool,
  guardedMcpFetch,
  MCP_TIMEOUT_MS,
  McpTimeoutError,
  MinimalStdioTransport,
  type HttpGuardDeps,
} from '../src/lib/mcpClient';
import { FetchBlockedError } from '../src/lib/safeFetch';
import { createSource, getSourceRow, listResults } from '../src/repos/discovery';
import { useApi } from './api';
import { PATIENCE_MS } from './patience';

const boot = useApi();
afterEach(() => {
  resetSources();
});

const SERVER = fileURLToPath(new URL('./fixtures/mcp/fakeServer.mjs', import.meta.url));

function stdioConfig(mode: string, overrides: Record<string, unknown> = {}) {
  return {
    transport: 'stdio' as const,
    command: process.execPath,
    args: [SERVER, mode],
    tool: 'search_jobs',
    queryArgs: { q: 'platform engineer' },
    mapping: {
      company: 'employer.name',
      title: 'role',
      descriptionMd: 'body',
      postingUrl: 'link',
      location: 'where',
      externalId: 'id',
    },
    itemsPath: 'results',
    ...overrides,
  };
}

function quietLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

async function collect(config: unknown, log = quietLog()): Promise<NormalizedPosting[]> {
  const sctx = {
    fetch: (() => {
      throw new Error('the MCP adapter never uses safeFetch');
    }) as unknown as SourceContext['fetch'],
    log: log as unknown as SourceContext['log'],
  };
  const out: NormalizedPosting[] = [];
  for await (const item of mcpSource.fetchPostings(sctx, config, null)) out.push(item.posting);
  return out;
}

function isGone(pid: number): boolean {
  try {
    // Signal 0 only checks existence; a zombie (exited, not reaped) still exists.
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

describe('MCP config', () => {
  it('validates the stdio and http forms; http must be https', () => {
    expect(McpConfigSchema.safeParse(stdioConfig('jobs')).success).toBe(true);
    const http = { ...stdioConfig('jobs'), transport: 'http', url: 'https://mcp.example.com/mcp' };
    delete (http as Record<string, unknown>).command;
    delete (http as Record<string, unknown>).args;
    expect(McpConfigSchema.safeParse(http).success).toBe(true);
    expect(McpConfigSchema.safeParse({ ...http, url: 'http://mcp.example.com/mcp' }).success).toBe(
      false,
    );
    expect(
      McpConfigSchema.safeParse({ ...http, mapping: { company: 'a..b', title: 't' } }).success,
    ).toBe(false);
  });

  it('reads dot paths through own properties only', () => {
    const doc = { a: { b: [{ c: 'x' }] } };
    expect(valueAt(doc, 'a.b.0.c')).toBe('x');
    expect(valueAt(doc, 'a.constructor')).toBeUndefined();
    expect(valueAt(doc, '__proto__.toString')).toBeUndefined();
    expect(valueAt(doc, 'a.b.x')).toBeUndefined();
  });
});

describe('MCP source over stdio (fake server)', () => {
  it('maps the tool output to postings and skips unmappable items', async () => {
    const log = quietLog();
    const postings = await collect(stdioConfig('jobs'), log);
    expect(postings).toEqual([
      {
        company: 'Initech',
        title: 'Staff Platform Engineer',
        descriptionMd: '<p>Own the platform.</p>',
        postingUrl: 'https://jobs.example.com/initech/1',
        location: 'Austin, TX',
        externalId: 'mcp-1',
      },
      {
        company: 'Globex',
        title: 'SRE',
        descriptionMd: null,
        postingUrl: null,
        location: 'Remote',
        externalId: 'mcp-2',
      },
    ]);
    expect(log.info).toHaveBeenCalledWith(
      // Counts only: the tool's name is the user's configuration, not logged (#345).
      expect.objectContaining({ 'opportun.count.skipped': 1 }),
      'MCP items skipped',
    );
  });

  it('passes queryArgs to the tool and runs the child with PATH only', async () => {
    const echo = await callMcpTool(
      { transport: 'stdio', command: process.execPath, args: [SERVER, 'jobs'] },
      'search_jobs',
      { q: 'platform engineer' },
    );
    const text = (echo.content[0] as { text: string }).text;
    expect(JSON.parse(text).query).toEqual({ q: 'platform engineer' });

    // A literal env object, not a mutation of the real process.env (issue #298): vitest's
    // threads pool shares process.env with every test file scheduled onto the same worker, so
    // this passes the "ambient" environment minimalEnv restricts from as a parameter instead.
    const env = await callMcpTool(
      { transport: 'stdio', command: process.execPath, args: [SERVER, 'env'] },
      'search_jobs',
      {},
      { env: { ...process.env, OPPORTUN_MCP_TEST_SECRET: 'must-not-leak' } },
    );
    const names = JSON.parse((env.content[0] as { text: string }).text).env as string[];
    expect(names).not.toContain('OPPORTUN_MCP_TEST_SECRET');
    // macOS CoreFoundation sets __CF_USER_TEXT_ENCODING in every new process itself.
    expect(names.filter((n) => n !== '__CF_USER_TEXT_ENCODING')).toEqual(['PATH']);
  });

  it('never interprets the command through a shell', async () => {
    const err = await callMcpTool(
      { transport: 'stdio', command: 'no-such-binary; echo pwned', args: ['$(id)'] },
      'search_jobs',
      {},
    ).catch((e: unknown) => e);
    expect((err as NodeJS.ErrnoException).code).toBe('ENOENT');
  });

  it('caps hostile output at the mapping level; the engine then sanitizes it', async () => {
    const [raw] = await collect(stdioConfig('hostile'));
    expect(raw!.company.length).toBe(MCP_FIELD_CAPS.company);
    expect(raw!.title.length).toBe(MCP_FIELD_CAPS.title);
    expect(raw!.descriptionMd!.length).toBe(MCP_FIELD_CAPS.descriptionMd);

    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: true };
    const src = await createSource(app.db, ctx, { kind: 'mcp', config: stdioConfig('hostile') });
    await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: src.id }, { userId: a.userId });
    await app.jobs.drain();
    const [stored] = (await listResults(app.db, ctx, { limit: 50, offset: 0 })).items;
    expect(stored).toBeDefined();
    const p = stored!.posting;
    expect(p.company.length).toBeLessThanOrEqual(300);
    expect(p.title.length).toBeLessThanOrEqual(300);
    expect(p.descriptionMd!.length).toBeLessThanOrEqual(50_000);
    for (const value of [p.company, p.title, p.descriptionMd]) {
      expect(value).not.toMatch(/<script|<img|onerror=/i);
    }
    expect(p.postingUrl ?? null).toBeNull();
    expect((await getSourceRow(app.db, ctx, src.id)).status).toBe('ok');
  });

  it('times out a hanging server and leaves no child behind (killed and reaped)', async () => {
    expect(MCP_TIMEOUT_MS).toBe(30_000);
    let pid: number | undefined;
    onTestFinished(() => {
      if (pid !== undefined && !isGone(pid)) process.kill(pid, 'SIGKILL');
    });
    const err = await callMcpTool(
      { transport: 'stdio', command: process.execPath, args: [SERVER, 'hang'] },
      'search_jobs',
      {},
      { timeoutMs: 800, onSpawn: (p) => (pid = p) },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpTimeoutError);
    expect(pid).toBeGreaterThan(0);
    // The server ignores SIGTERM and its input's end: the client escalated to SIGKILL and waited for
    // the exit.
    expect(isGone(pid!)).toBe(true);
    // Vitest's 30 s is what ends this if the 800 ms are not applied: the default is 30 s itself (#948).
  });

  it('a completed call also leaves no child behind', async () => {
    let pid: number | undefined;
    await callMcpTool(
      { transport: 'stdio', command: process.execPath, args: [SERVER, 'jobs'] },
      'search_jobs',
      {},
      { onSpawn: (p) => (pid = p) },
    );
    expect(isGone(pid!)).toBe(true);
  });

  // A child of the server's own is in the group this client started, and goes with it (#1024).
  describe('a child the server started', () => {
    /** Not a spy: what ends what a test started, and what a spy passes on to. */
    const real = process.kill.bind(process);
    afterEach(() => vi.restoreAllMocks());
    /** A family of fakeServer.mjs: its arguments, and the child's pid once it runs. Ended by pid. */
    function family(server: string, kind: string) {
      const dir = mkdtempSync(join(tmpdir(), 'opportun-mcp-'));
      const file = join(dir, 'child.pid');
      const child = () => Number(readFileSync(file, 'utf8'));
      let leader: number | undefined;
      onTestFinished(() => {
        for (const pid of [leader, existsSync(file) ? child() : undefined]) {
          if (pid !== undefined && !isGone(pid)) real(pid, 'SIGKILL');
        }
        rmSync(dir, { recursive: true, force: true });
      });
      const args = [SERVER, 'family', server, kind, file];
      const call = (timeoutMs = PATIENCE_MS) =>
        callMcpTool(
          { transport: 'stdio', command: process.execPath, args },
          'search_jobs',
          {},
          { timeoutMs, onSpawn: (p) => (leader = p) },
        ).catch((e: unknown) => e);
      return { args, call, child, leader: () => leader! };
    }
    /** What was sent to the group `pid` leads, in order; a 0 is a look. */
    function sentTo(kill: MockInstance<typeof process.kill>, pid: number) {
      return kill.mock.calls.filter(([to]) => to === -pid).map(([, sig]) => sig);
    }
    const signals = (sent: unknown[]) => sent.filter((s) => s !== 0);
    const gone = (pid: number) =>
      vi.waitFor(() => expect(isGone(pid)).toBe(true), { timeout: PATIENCE_MS });

    it.each(['answers', 'leaves'])(
      'that ignores SIGTERM is killed after the grace, its server gone (%s)',
      async (server) => {
        const kill = vi.spyOn(process, 'kill');
        const f = family(server, 'stubborn');
        await f.call();
        const sent = sentTo(kill, f.leader());
        expect(signals(sent)).toEqual(['SIGTERM', 'SIGKILL']);
        expect(isGone(f.leader())).toBe(true);
        await gone(f.child());
        // Looked at again in the turn of the kill.
        expect(sent.at(-2)).toBe(0);
      },
    );

    it.each(['answers', 'leaves'])(
      'that ends when asked is waited for, not killed, and no longer than it takes (%s)',
      async (server) => {
        const kill = vi.spyOn(process, 'kill');
        const f = family(server, 'slow');
        const call = f.call();
        await vi.waitFor(() => expect(signals(sentTo(kill, f.leader()))).toEqual(['SIGTERM']), {
          timeout: PATIENCE_MS,
          interval: 5,
        });
        // Started as the group is asked: timers fire in the order they are due, so a call that waits
        // for the whole grace (2 s) ends after this one, however busy the host.
        const grace = new Promise((r) => setTimeout(() => r('the grace first'), 1_800));
        expect(await Promise.race([call.then(() => 'the call first'), grace])).toBe(
          'the call first',
        );
        expect(signals(sentTo(kill, f.leader()))).toEqual(['SIGTERM']);
        await gone(f.child());
      },
    );

    it('of a server that ended by itself is ended with nobody closing', async () => {
      const f = family('leaves', 'stubborn');
      const t = new MinimalStdioTransport(process.execPath, f.args);
      await t.start();
      await vi.waitFor(() => f.child(), { timeout: PATIENCE_MS });
      await gone(f.child());
    });

    it('of a server that is killed goes with it, with no signal after', async () => {
      const kill = vi.spyOn(process, 'kill');
      const f = family('hang', 'stubborn');
      await f.call(800);
      // Two close at once (the SDK's client, at its own failed connect), so each may come twice.
      const sent = sentTo(kill, f.leader());
      expect([...new Set(sent)]).toEqual(['SIGTERM', 'SIGKILL']);
      expect(sent.at(-1)).toBe('SIGKILL');
      await gone(f.child());
    });

    it('is left alone once its group has been seen empty: no look and no signal after', async () => {
      const kill = vi.spyOn(process, 'kill');
      const t = new MinimalStdioTransport(process.execPath, [SERVER, 'jobs']);
      await t.start();
      await t.close();
      await t.close();
      expect(sentTo(kill, t.pid!)).toEqual(['SIGTERM', 0]);
    });

    it.each(['ESRCH', 'EPERM'])('a look answered %s is an empty group: no signal', async (code) => {
      const f = family('answers', 'stubborn');
      let looks = 0;
      const kill = vi.spyOn(process, 'kill').mockImplementation((to, sig) => {
        // The first look only: what comes after it must not be asked.
        if (to < 0 && sig === 0 && ++looks === 1) throw Object.assign(new Error(code), { code });
        return real(to, sig);
      });
      const t = new MinimalStdioTransport(process.execPath, f.args);
      await t.start();
      await vi.waitFor(() => f.child(), { timeout: PATIENCE_MS });
      await t.close();
      await t.close();
      expect(sentTo(kill, t.pid!)).toEqual(['SIGTERM', 0]);
      expect(kill.mock.calls.filter(([to]) => to === t.pid)).toEqual([]);
      expect(isGone(f.child()), 'the child is not this client’s to end any more').toBe(false);
    });

    it('a group that cannot be asked to end is an empty group: no look and no signal after', async () => {
      const f = family('leaves', 'stubborn');
      const kill = vi.spyOn(process, 'kill').mockImplementation((to, sig) => {
        if (to < 0 && sig === 'SIGTERM') throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
        return real(to, sig);
      });
      const t = new MinimalStdioTransport(process.execPath, f.args);
      const ended = new Promise<void>((r) => (t.onclose = r));
      await t.start();
      await ended;
      await t.close();
      await t.close();
      expect(sentTo(kill, t.pid!)).toEqual([0, 'SIGTERM']);
      expect(isGone(f.child())).toBe(false);
    });

    it('that goes during the grace by itself is not killed', async () => {
      const f = family('answers', 'stubborn');
      const kill = vi.spyOn(process, 'kill');
      const t = new MinimalStdioTransport(process.execPath, f.args);
      await t.start();
      await vi.waitFor(() => f.child(), { timeout: PATIENCE_MS });
      const closing = t.close();
      await vi.waitFor(() => expect(sentTo(kill, t.pid!)).toContain(0), { timeout: PATIENCE_MS });
      real(f.child(), 'SIGKILL');
      await closing;
      expect(signals(sentTo(kill, t.pid!))).toEqual(['SIGTERM']);
    });
  });

  it('an unknown tool fails the run with the source showing the error', async () => {
    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: true };
    const src = await createSource(app.db, ctx, {
      kind: 'mcp',
      config: stdioConfig('jobs', { tool: 'nope' }),
    });
    await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: src.id }, { userId: a.userId });
    await app.jobs.drain();
    const row = await getSourceRow(app.db, ctx, src.id);
    expect(row.status).toBe('error');
    expect(row.statusDetail).toMatch(/MCP tool nope failed/);
  });
});

describe('MCP http transport', () => {
  function deps(dns: Record<string, string[]>): HttpGuardDeps & { fetched: string[] } {
    const fetched: string[] = [];
    return {
      fetched,
      resolve: async (host) => new Map(Object.entries(dns)).get(host) ?? [],
      fetch: (async (input: string | URL) => {
        fetched.push(String(input));
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    };
  }

  it('refuses plain http before any request', async () => {
    const d = deps({ 'mcp.example.com': ['93.184.216.34'] });
    const err = await callMcpTool(
      { transport: 'http', url: 'http://mcp.example.com/mcp' },
      'search_jobs',
      {},
      { http: d },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchBlockedError);
    expect((err as FetchBlockedError).reason).toBe('scheme');
    expect(d.fetched).toEqual([]);
  });

  it('refuses private addresses and prohibited hosts; declines the GET stream', async () => {
    const d = deps({
      'internal.example.com': ['10.1.1.1'],
      'www.linkedin.com': ['93.184.216.34'],
      'mcp.example.com': ['93.184.216.34'],
    });
    const guarded = guardedMcpFetch(d);
    for (const url of ['https://internal.example.com/mcp', 'https://www.linkedin.com/mcp']) {
      await expect(guarded(url, { method: 'POST' })).rejects.toBeInstanceOf(FetchBlockedError);
    }
    expect((await guarded('https://mcp.example.com/mcp', { method: 'GET' })).status).toBe(405);
    expect(d.fetched).toEqual([]);
    expect((await guarded('https://mcp.example.com/mcp', { method: 'POST' })).status).toBe(200);
    expect(d.fetched).toEqual(['https://mcp.example.com/mcp']);
  });

  // Issue #75 keeps indeed.com off server page fetches only. An MCP connector the user points at
  // an Indeed host stays their choice under C-2, so the MCP guard must not refuse it. Nothing
  // leaves the process: the transport is the stub above.
  it('does not refuse an MCP server on an indeed.com host (C-2, issue #75)', async () => {
    const d = deps({ 'mcp.indeed.com': ['93.184.216.34'], 'indeed.com': ['93.184.216.34'] });
    const guarded = guardedMcpFetch(d);
    expect((await guarded('https://mcp.indeed.com/mcp', { method: 'POST' })).status).toBe(200);
    expect((await guarded('https://indeed.com/mcp', { method: 'POST' })).status).toBe(200);
    expect(d.fetched).toEqual(['https://mcp.indeed.com/mcp', 'https://indeed.com/mcp']);
  });

  it('a hostname with extra trailing dots is treated as the same host (PR #78 review)', async () => {
    const d = deps({
      'www.linkedin.com..': ['93.184.216.34'],
      'mcp.indeed.com..': ['93.184.216.34'],
    });
    const guarded = guardedMcpFetch(d);
    // C-1 is refused however many trailing dots the name carries.
    const err = await guarded('https://www.linkedin.com../mcp', { method: 'POST' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FetchBlockedError);
    expect((err as FetchBlockedError).reason).toBe('host_not_allowed');
    expect(d.fetched).toEqual([]);
    // Indeed stays open on this path, dotted or not (option (b), issue #75).
    expect((await guarded('https://mcp.indeed.com../mcp', { method: 'POST' })).status).toBe(200);
  });

  it('creating a source with an http:// MCP URL is a 422', async () => {
    const { a } = await boot();
    const config = { ...stdioConfig('jobs'), transport: 'http', url: 'http://mcp.example.com/' };
    delete (config as Record<string, unknown>).command;
    delete (config as Record<string, unknown>).args;
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/discovery/sources',
      payload: { kind: 'mcp', config },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe('who may configure a stdio MCP source', () => {
  it('a stdio source whose owner is not an administrator never spawns at run time', async () => {
    const { app, a, b } = await boot();
    // A pre-existing stdio source owned by a non-admin (e.g. created before a demotion). Its
    // command would leave a marker file if it were ever spawned.
    const marker = join(tmpdir(), `opportun-mcp-spawned-${b.userId}`);
    rmSync(marker, { force: true });
    onTestFinished(() => rmSync(marker, { force: true }));
    const src = await createSource(
      app.db,
      { userId: b.userId, isAdmin: true },
      {
        kind: 'mcp',
        config: stdioConfig('jobs', {
          args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`],
        }),
      },
    );
    await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: src.id }, { userId: b.userId });
    await app.jobs.drain();
    expect(existsSync(marker)).toBe(false);
    const ctxB = { userId: b.userId, isAdmin: false };
    const row = await getSourceRow(app.db, ctxB, src.id);
    expect(row.status).toBe('error');
    expect(row.statusDetail).toMatch(
      /SourceConfigError: stdio MCP sources run only for an administrator/,
    );
    expect((await listResults(app.db, ctxB, { limit: 50, offset: 0 })).total).toBe(0);

    // A source owned by the administrator still runs (the check reads is_admin live).
    const ok = await createSource(
      app.db,
      { userId: a.userId, isAdmin: true },
      {
        kind: 'mcp',
        config: stdioConfig('jobs'),
      },
    );
    await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: ok.id }, { userId: a.userId });
    await app.jobs.drain();
    expect((await getSourceRow(app.db, { userId: a.userId, isAdmin: true }, ok.id)).status).toBe(
      'ok',
    );
  });

  it('only the administrator: the command runs on the server (ADR-12)', async () => {
    const { a, b } = await boot();
    const payload = { kind: 'mcp', config: stdioConfig('jobs') };
    const asB = await b.request({ method: 'POST', url: '/api/v1/discovery/sources', payload });
    expect(asB.statusCode).toBe(403);
    expect(asB.json().error.code).toBe('mcp_stdio_admin_only');
    const asA = await a.request({ method: 'POST', url: '/api/v1/discovery/sources', payload });
    expect(asA.statusCode).toBe(201);
  });
});

describe('stdio MCP sources on the demo', () => {
  // A demo server's administrator is a shared login, so no stdio MCP source is configured or run
  // there, whoever owns it. Off the demo, the rules above apply as before.
  it('a stdio source owned by the administrator does not run on the demo', async () => {
    const { app, a } = await boot({ demo: true });
    const marker = join(tmpdir(), `opportun-mcp-demo-${a.userId}`);
    rmSync(marker, { force: true });
    onTestFinished(() => rmSync(marker, { force: true }));
    const ctx = { userId: a.userId, isAdmin: true };
    // Written as one already stored would be: the configure check is the next test's.
    const src = await createSource(app.db, ctx, {
      kind: 'mcp',
      config: stdioConfig('jobs', {
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`],
      }),
    });
    await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: src.id }, { userId: a.userId });
    await app.jobs.drain();
    expect(existsSync(marker)).toBe(false);
    const row = await getSourceRow(app.db, ctx, src.id);
    expect(row.status).toBe('error');
    expect(row.statusDetail).toMatch(/SourceConfigError: stdio MCP sources do not run on the demo/);
  });

  it('a stdio source switched back on, with no config change, still does not run on the demo', async () => {
    const { app, a } = await boot({ demo: true });
    const marker = join(tmpdir(), `opportun-mcp-demo-on-${a.userId}`);
    rmSync(marker, { force: true });
    onTestFinished(() => rmSync(marker, { force: true }));
    const ctx = { userId: a.userId, isAdmin: true };
    // Stored switched off, as one already there would be.
    const src = await createSource(app.db, ctx, {
      kind: 'mcp',
      enabled: false,
      config: stdioConfig('jobs', {
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`],
      }),
    });
    // Switched on through the API: no config in the change, so the configure check is not asked.
    const on = await a.request({
      method: 'PATCH',
      url: `/api/v1/discovery/sources/${src.id}`,
      payload: { enabled: true },
    });
    expect(on.statusCode, on.body).toBe(200);
    await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: src.id }, { userId: a.userId });
    await app.jobs.drain();
    expect(existsSync(marker)).toBe(false);
    const row = await getSourceRow(app.db, ctx, src.id);
    expect(row.status).toBe('error');
    expect(row.statusDetail).toMatch(/SourceConfigError: stdio MCP sources do not run on the demo/);
  });

  it('the administrator cannot add one, or change a source to one, on the demo', async () => {
    const { a } = await boot({ demo: true });
    const payload = { kind: 'mcp', config: stdioConfig('jobs') };
    const created = await a.request({ method: 'POST', url: '/api/v1/discovery/sources', payload });
    expect(created.statusCode, created.body).toBe(403);
    expect(created.json().error.code).toBe('mcp_stdio_unavailable_on_demo');
    // An https source, then a change of its config to stdio.
    const rest: Record<string, unknown> = { ...stdioConfig('jobs') };
    delete rest.command;
    delete rest.args;
    const http = await a.request({
      method: 'POST',
      url: '/api/v1/discovery/sources',
      payload: {
        kind: 'mcp',
        config: { ...rest, transport: 'http', url: 'https://mcp.example.com/mcp' },
      },
    });
    expect(http.statusCode, http.body).toBe(201);
    const changed = await a.request({
      method: 'PATCH',
      url: `/api/v1/discovery/sources/${http.json().id}`,
      payload: { config: stdioConfig('jobs') },
    });
    expect(changed.statusCode, changed.body).toBe(403);
    expect(changed.json().error.code).toBe('mcp_stdio_unavailable_on_demo');
  });
});
