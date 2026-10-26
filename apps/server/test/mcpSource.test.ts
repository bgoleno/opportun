// MCP discovery sources (Task 11, FR-D1/D2, ADR-7/12). A fake MCP server (test/fixtures/mcp,
// spawned over stdio through the real client) serves tool output; the adapter maps it through
// the configured paths, caps hostile strings, and the engine sanitizes what is stored. The child
// runs without a shell and with PATH only, and is gone (reaped) after every call, including a
// call that times out against a server that ignores SIGTERM.
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NormalizedPosting } from '@opportun/core';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { resetSources, type SourceContext } from '../src/adapters/discoverySource';
import { MCP_FIELD_CAPS, mcpSource, valueAt } from '../src/adapters/sources/mcp';
import { McpConfigSchema } from '../src/adapters/sources/mcpConfig';
import { DISCOVERY_RUN_KIND } from '../src/jobs/discoveryRun';
import { enqueue } from '../src/jobs/runner';
import {
  callMcpTool,
  guardedMcpFetch,
  MCP_TIMEOUT_MS,
  McpTimeoutError,
  type HttpGuardDeps,
} from '../src/lib/mcpClient';
import { FetchBlockedError } from '../src/lib/safeFetch';
import { createSource, getSourceRow, listResults } from '../src/repos/discovery';
import { useApi } from './api';

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
      expect.objectContaining({ skipped: 1, tool: 'search_jobs' }),
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
    const started = Date.now();
    const err = await callMcpTool(
      { transport: 'stdio', command: process.execPath, args: [SERVER, 'hang'] },
      'search_jobs',
      {},
      { timeoutMs: 800, onSpawn: (p) => (pid = p) },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpTimeoutError);
    expect(pid).toBeGreaterThan(0);
    // The server ignores SIGTERM: the client escalated to SIGKILL and waited for the exit.
    expect(isGone(pid!)).toBe(true);
    expect(Date.now() - started).toBeLessThan(8_000);
  }, 15_000);

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
