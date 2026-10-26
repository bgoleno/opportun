// Reactive Resume document store (FR-R7). The adapter runs against the recorded fake in
// fakeReactiveResume.ts (the contract, with every assumption listed there), wired underneath
// the real safeFetch so host confinement is exercised, not mocked.
import { describe, expect, it } from 'vitest';
import {
  createReactiveResumeStore,
  flattenRrResume,
  parseRrBaseUrl,
  parseRrRef,
  readRrConfig,
  RR_TARGET_VERSIONS,
  validateReactiveResume,
  type RrConfig,
} from '../src/adapters/reactiveResume';
import { HttpError } from '../src/lib/errors';
import type { UserCtx } from '../src/repos/base';
import { captureLogs, testApp } from './helpers';
import { useApi } from './api';
import { connectGoogle, fakeGoogle, type FakeGoogle } from './fakeGoogle';
import { registerTwoUsers, type TestClient } from './isolation';
import { BASE_DOC_ID, BASE_TEXT, createOpportunity, registerBase } from './resumeFixtures';
import {
  fakeReactiveResume,
  RR_BASE_ID,
  RR_FIXTURE,
  RR_HOST,
  RR_ORIGIN,
  RR_VERSION,
  type FakeRr,
} from './fakeReactiveResume';
import { queryAll, withFailingWrite } from './db';

const KEY_A = 'rr-key-alice-0123456789';
const KEY_B = 'rr-key-bob-9876543210';
const ctx: UserCtx = { userId: 'u1', isAdmin: false };
const CFG: RrConfig = { baseUrl: RR_ORIGIN, apiKey: KEY_A };

const FIXTURE_TEXT = [
  'Jane Doe',
  'Senior Engineer',
  'jane@example.com',
  '+1 555 0100',
  'Austin, TX',
  'Summary',
  'Backend engineer focused on payments & billing.',
  'Experience',
  'Initech',
  'Senior Engineer',
  'Austin, TX',
  'Built the billing platform in Go',
  'Cut costs by 40% with caching',
  'Skills',
  'Languages',
  'Go',
  'Python',
].join('\n');

function setup(config: RrConfig = CFG) {
  const rr = fakeReactiveResume();
  rr.keys.set(KEY_A, 'alice');
  rr.seed('alice', { id: RR_BASE_ID });
  const store = createReactiveResumeStore({ fetch: rr.fetch, config: async () => config });
  return { rr, store };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpError) return err.code;
    throw err;
  }
  throw new Error('expected an HttpError');
}

function bodyText(rr: FakeRr, id: string): string {
  return flattenRrResume(rr.resumes.get(id)!.resume.data).text;
}

describe('reactive resume adapter', () => {
  it('names the Reactive Resume versions it was written against', () => {
    expect(RR_TARGET_VERSIONS).toContain('6.0');
  });

  it('accepts an https origin only, and a resume id or a builder link on that origin', () => {
    expect(parseRrBaseUrl('https://rr.example.com/')).toBe('https://rr.example.com');
    expect(parseRrBaseUrl('https://rr.example.com:8443')).toBe('https://rr.example.com:8443');
    for (const bad of ['http://rr.example.com', 'https://u:p@rr.example.com', 'ftp://x', 'nope']) {
      expect(() => parseRrBaseUrl(bad)).toThrow(HttpError);
    }
    expect(parseRrRef(RR_BASE_ID, RR_ORIGIN)).toBe(RR_BASE_ID);
    expect(parseRrRef(`${RR_ORIGIN}/builder/${RR_BASE_ID}`, RR_ORIGIN)).toBe(RR_BASE_ID);
    expect(() => parseRrRef(`https://evil.example.net/builder/${RR_BASE_ID}`, RR_ORIGIN)).toThrow(
      HttpError,
    );
    expect(() => parseRrRef('../../etc/passwd', RR_ORIGIN)).toThrow(HttpError);
  });

  it('registers an existing resume with its canonical name and builder url', async () => {
    const { rr, store } = setup();
    const meta = await store.registerExisting(ctx, `${RR_ORIGIN}/builder/${RR_BASE_ID}`);
    expect(meta).toEqual({
      docRef: RR_BASE_ID,
      title: RR_FIXTURE.name,
      url: `${RR_ORIGIN}/builder/${RR_BASE_ID}`,
    });
    expect(rr.calls).toEqual([
      {
        method: 'GET',
        host: RR_HOST,
        path: `/api/openapi/resumes/${RR_BASE_ID}`,
        apiKey: KEY_A,
        body: undefined,
      },
    ]);
  });

  it('reads the resume JSON as plain text: visible fields, HTML flattened, hidden items left out', async () => {
    const { store } = setup();
    expect(await store.readText(ctx, RR_BASE_ID)).toBe(FIXTURE_TEXT);
  });

  it('copies a base resume under the tailored name', async () => {
    const { rr, store } = setup();
    const meta = await store.copyFrom(ctx, RR_BASE_ID, 'Jane-Acme-staff_sre');
    expect(meta.title).toBe('Jane-Acme-staff_sre');
    expect(meta.url).toBe(`${RR_ORIGIN}/builder/${meta.docRef}`);
    expect(rr.resumes.get(meta.docRef)?.resume.name).toBe('Jane-Acme-staff_sre');
    expect(rr.calls.at(-1)).toMatchObject({
      method: 'POST',
      path: `/api/openapi/resumes/${RR_BASE_ID}/copies`,
      body: { name: 'Jane-Acme-staff_sre' },
    });
    expect(await store.readText(ctx, meta.docRef)).toBe(FIXTURE_TEXT);
  });

  it('applies edits as JSON Patch replaces on the text fields, guarded by updatedAt', async () => {
    const { rr, store } = setup();
    await store.applyEdits(ctx, RR_BASE_ID, [
      { find: 'Built the billing platform in Go', replace: 'Built the Go billing platform' },
      { find: 'payments & billing', replace: 'payments, billing <and> tax' },
      { find: 'Python', replace: 'Rust' },
    ]);
    const patch = rr.calls.at(-1)!;
    expect(patch.method).toBe('PATCH');
    expect(patch.body).toEqual({
      expectedUpdatedAt: RR_FIXTURE.updatedAt,
      operations: [
        {
          op: 'replace',
          path: '/summary/content',
          value: '<p>Backend engineer focused on payments, billing &lt;and&gt; tax.</p>',
        },
        {
          op: 'replace',
          path: '/sections/experience/items/0/description',
          value:
            '<ul><li><p>Built the Go billing platform</p></li><li><p>Cut costs by <strong>40%</strong> with caching</p></li></ul>',
        },
        { op: 'replace', path: '/sections/skills/items/0/keywords/1', value: 'Rust' },
      ],
    });
    const text = bodyText(rr, RR_BASE_ID);
    expect(text).toContain('Built the Go billing platform');
    expect(text).toContain('payments, billing <and> tax.');
    expect(text).toContain('\nRust');
  });

  it('replaces every occurrence, like Google replaceAllText', async () => {
    const { rr, store } = setup();
    await store.applyEdits(ctx, RR_BASE_ID, [
      { find: 'Senior Engineer', replace: 'Staff Engineer' },
    ]);
    const ops = (rr.calls.at(-1)!.body as { operations: { path: string }[] }).operations;
    expect(ops.map((o) => o.path)).toEqual([
      '/basics/headline',
      '/sections/experience/items/0/position',
    ]);
  });

  it('refuses edits it cannot place, before writing anything', async () => {
    const { rr, store } = setup();
    expect(await code(store.applyEdits(ctx, RR_BASE_ID, [{ find: 'COBOL', replace: 'x' }]))).toBe(
      'edit_target_missing',
    );
    expect(
      await code(store.applyEdits(ctx, RR_BASE_ID, [{ find: 'Go\nPython', replace: 'x' }])),
    ).toBe('edit_spans_paragraphs');
    // "by 40%" crosses the <strong> tag: plain text has it, no single text node does.
    expect(
      await code(store.applyEdits(ctx, RR_BASE_ID, [{ find: 'by 40% with', replace: 'x' }])),
    ).toBe('edit_spans_formatting');
    // Text that only exists in a hidden item is not part of the resume.
    expect(
      await code(store.applyEdits(ctx, RR_BASE_ID, [{ find: 'Not printed', replace: 'x' }])),
    ).toBe('edit_target_missing');
    expect(rr.calls.filter((c) => c.method === 'PATCH')).toEqual([]);
  });

  it('refuses an edit when any occurrence crosses formatting, even if another one is plain', async () => {
    const { rr, store } = setup();
    const data = rr.resumes.get(RR_BASE_ID)!.resume.data as { basics: { headline: string } };
    // "by 40%" is now plain text in the headline AND crosses <strong> in the description.
    data.basics.headline = 'Grew revenue by 40% in a year';
    try {
      await store.applyEdits(ctx, RR_BASE_ID, [
        { find: 'Jane Doe', replace: 'J. Doe' },
        { find: 'by 40%', replace: 'by half' },
      ]);
      throw new Error('expected a 422');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).code).toBe('edit_spans_formatting');
      expect((err as HttpError).details).toEqual({ index: 1 });
    }
    expect(rr.calls.filter((c) => c.method === 'PATCH')).toEqual([]);
    // A replacement that reintroduces its own find text is not mistaken for a skipped one.
    await store.applyEdits(ctx, RR_BASE_ID, [{ find: 'Go', replace: 'Go and Go' }]);
    expect(bodyText(rr, RR_BASE_ID)).toContain('platform in Go and Go');
  });

  it('reports an edit an earlier one in the same batch already consumed, rather than a silent no-op (#146)', async () => {
    const { rr, store } = setup();
    // Both target "Senior Engineer" (present originally, so the missing check passes for
    // both), but the first edit already replaces every occurrence of it.
    const { docRef, results } = await store.applyEdits(ctx, RR_BASE_ID, [
      { find: 'Senior Engineer', replace: 'Staff Engineer' },
      { find: 'Senior Engineer', replace: 'Principal Engineer' },
    ]);
    expect(docRef).toBe(RR_BASE_ID);
    expect(results).toEqual([
      { index: 0, outcome: 'applied' },
      { index: 1, outcome: 'already_consumed' },
    ]);
    const text = bodyText(rr, RR_BASE_ID);
    // The first edit's change stands...
    expect(text).toContain('Staff Engineer');
    // ...and the second never had anything left to act on.
    expect(text).not.toContain('Principal Engineer');
  });

  it('reports the edit index that is missing', async () => {
    const { store } = setup();
    try {
      await store.applyEdits(ctx, RR_BASE_ID, [
        { find: 'Jane Doe', replace: 'J. Doe' },
        { find: 'COBOL', replace: 'x' },
      ]);
      throw new Error('expected a 409');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(409);
      expect((err as HttpError).details).toEqual({ index: 1 });
    }
  });

  it('maps a changed, locked or foreign resume to clear errors', async () => {
    const { rr, store } = setup();
    // Someone edited the resume in the builder between our read and our write.
    const original = rr.deps.request;
    let bumped = false;
    rr.deps.request = async (t, s) => {
      if (!bumped && t.post?.method === 'PATCH') {
        bumped = true;
        rr.resumes.get(RR_BASE_ID)!.resume.updatedAt = '2026-10-02T00:00:00.000Z';
      }
      return original(t, s);
    };
    expect(
      await code(store.applyEdits(ctx, RR_BASE_ID, [{ find: 'Jane Doe', replace: 'J' }])),
    ).toBe('reactive_resume_conflict');
    rr.resumes.get(RR_BASE_ID)!.resume.isLocked = true;
    expect(
      await code(store.applyEdits(ctx, RR_BASE_ID, [{ find: 'Jane Doe', replace: 'J' }])),
    ).toBe('reactive_resume_locked');
    rr.keys.set(KEY_B, 'bob');
    const bobs = rr.seed('bob');
    expect(await code(store.readText(ctx, bobs))).toBe('reactive_resume_unavailable');
  });

  it('turns a 401 into a clear reconnect error that never carries the key', async () => {
    const { store } = setup({ baseUrl: RR_ORIGIN, apiKey: 'revoked-key-000000' });
    try {
      await store.readText(ctx, RR_BASE_ID);
      throw new Error('expected a 409');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(409);
      expect((err as HttpError).code).toBe('reactive_resume_unauthorized');
      expect((err as HttpError).message).toMatch(/API key/);
      expect(JSON.stringify(err)).not.toContain('revoked-key-000000');
      expect((err as Error).message).not.toContain('revoked-key-000000');
    }
  });

  it('is unusable until configured, and makes no call', async () => {
    const rr = fakeReactiveResume();
    const store = createReactiveResumeStore({ fetch: rr.fetch, config: async () => undefined });
    expect(await code(store.readText(ctx, RR_BASE_ID))).toBe('reactive_resume_not_connected');
    expect(await code(store.registerExisting(ctx, RR_BASE_ID))).toBe(
      'reactive_resume_not_connected',
    );
    expect(rr.calls).toEqual([]);
  });

  it('never follows a redirect, so the key never leaves the configured origin', async () => {
    for (const location of [
      'https://attacker.example.net/grab',
      `https://evil.${RR_HOST}/grab`,
      `https://${RR_HOST}:9999/grab`,
    ]) {
      const { rr, store } = setup();
      rr.redirects.set(`/api/openapi/resumes/${RR_BASE_ID}`, location);
      try {
        await store.readText(ctx, RR_BASE_ID);
        throw new Error('expected a 502');
      } catch (err) {
        expect(err, location).toBeInstanceOf(HttpError);
        expect((err as HttpError).statusCode).toBe(502);
        expect((err as HttpError).code).toBe('reactive_resume_unreachable');
        expect((err as HttpError).details).toEqual({ reason: 'redirect_blocked' });
      }
      expect(rr.calls, location).toHaveLength(1);
    }
  });

  it('validates a key against health and the resume list', async () => {
    const { rr } = setup();
    expect(await validateReactiveResume(rr.fetch, CFG)).toEqual({
      ok: true,
      version: RR_VERSION,
      error: null,
    });
    expect(rr.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/health',
      'GET /api/openapi/resumes',
    ]);
    // Health is credential-free (A1): a mistyped host learns nothing before it proves it is RR.
    expect(rr.calls.map((c) => c.apiKey)).toEqual([undefined, KEY_A]);
    expect(
      await validateReactiveResume(rr.fetch, { baseUrl: RR_ORIGIN, apiKey: 'wrong-key-00000' }),
    ).toEqual({ ok: false, version: RR_VERSION, error: 'unauthorized' });
    rr.unhealthy = true;
    expect((await validateReactiveResume(rr.fetch, CFG)).error).toBe('unhealthy');
    const other = await validateReactiveResume(rr.fetch, {
      baseUrl: 'https://not-rr.example.org',
      apiKey: KEY_A,
    });
    expect(other.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// API: settings, store selection, resume routes over both stores

let rr: FakeRr;
let google: FakeGoogle;
function fakes() {
  rr = fakeReactiveResume();
  rr.keys.set(KEY_A, 'alice');
  rr.keys.set(KEY_B, 'bob');
  rr.seed('alice', { id: RR_BASE_ID });
  google = fakeGoogle({ [BASE_DOC_ID]: { title: 'Jane Base Resume', text: BASE_TEXT } });
  return { google, rrFetch: rr.fetch };
}
const boot = useApi(() => ({ build: fakes() }));

async function connectRr(c: TestClient, apiKey = KEY_A, baseUrl = RR_ORIGIN) {
  const res = await c.request({
    method: 'PUT',
    url: '/api/v1/integrations/reactive-resume',
    payload: { baseUrl, apiKey },
  });
  if (res.statusCode !== 200) throw new Error(`connect rr: ${res.statusCode} ${res.body}`);
  return res;
}

async function registerRr(c: TestClient, docRef = RR_BASE_ID, store?: string) {
  return c.request({
    method: 'POST',
    url: '/api/v1/resumes',
    payload: store === undefined ? { docRef } : { store, docRef },
  });
}

describe('reactive resume integration API', () => {
  it('stores the key in the vault and never returns or logs it', async () => {
    const { a } = await boot();
    const before = await a.request({ method: 'GET', url: '/api/v1/integrations/reactive-resume' });
    expect(before.json()).toEqual({
      baseUrl: null,
      keySet: false,
      connected: false,
      targetVersions: expect.any(Array),
    });
    const put = await connectRr(a);
    expect(put.json()).toMatchObject({ baseUrl: RR_ORIGIN, keySet: true, connected: true });
    const after = await a.request({ method: 'GET', url: '/api/v1/integrations/reactive-resume' });
    const secrets = await a.request({ method: 'GET', url: '/api/v1/secrets' });
    expect(secrets.json().items).toEqual([
      expect.objectContaining({ kind: 'oauth_token', label: 'reactive_resume' }),
    ]);
    const validate = await a.request({
      method: 'POST',
      url: '/api/v1/integrations/reactive-resume/validate',
    });
    expect(validate.json()).toEqual({ ok: true, version: RR_VERSION, error: null });
    for (const body of [put.body, after.body, secrets.body, validate.body]) {
      expect(body).not.toContain(KEY_A);
    }
    // Rotating the key keeps exactly one vault row.
    await connectRr(a, KEY_B);
    const rotated = await a.request({ method: 'GET', url: '/api/v1/secrets' });
    expect(rotated.json().items).toHaveLength(1);
  });

  it('the key is in no log line, whatever Reactive Resume answers', async () => {
    const logs = captureLogs();
    const { app } = await testApp({ logLevel: 'debug' }, { logStream: logs, build: fakes() });
    try {
      const { a } = await registerTwoUsers(app);
      await connectRr(a);
      await registerRr(a, RR_BASE_ID, 'reactive_resume');
      await a.request({ method: 'POST', url: '/api/v1/integrations/reactive-resume/validate' });
      rr.keys.delete(KEY_A); // revoked at Reactive Resume: every call now answers 401
      const failed = await registerRr(a, RR_BASE_ID, 'reactive_resume');
      expect(failed.statusCode).toBe(409);
      expect(failed.body).not.toContain(KEY_A);
      rr.redirects.set('/api/health', 'https://attacker.example.net/');
      await a.request({ method: 'POST', url: '/api/v1/integrations/reactive-resume/validate' });
      expect(logs.lines.length).toBeGreaterThan(0);
      expect(logs.text()).not.toContain(KEY_A);
    } finally {
      await app.close();
    }
  });

  it('refuses a plain-http or credentialed base URL, and a new host without a new key', async () => {
    const { a } = await boot();
    for (const baseUrl of ['http://rr.example.com', 'https://u:p@rr.example.com']) {
      const res = await a.request({
        method: 'PUT',
        url: '/api/v1/integrations/reactive-resume',
        payload: { baseUrl, apiKey: KEY_A },
      });
      expect(res.statusCode).toBe(400);
    }
    await connectRr(a);
    // Pointing the stored key at a different host would hand it to that host.
    const moved = await a.request({
      method: 'PUT',
      url: '/api/v1/integrations/reactive-resume',
      payload: { baseUrl: 'https://other.example.org' },
    });
    expect(moved.statusCode).toBe(422);
    expect(moved.json().error.code).toBe('api_key_required');
    const same = await a.request({
      method: 'PUT',
      url: '/api/v1/integrations/reactive-resume',
      payload: { baseUrl: `${RR_ORIGIN}/` },
    });
    expect(same.statusCode).toBe(200);
  });

  it('refuses a key that cannot be sent as a header, with a clear 400', async () => {
    const { a } = await boot();
    for (const apiKey of ['rr key with spaces', 'rr-key-\r\nx-evil: 1', 'rr-key-caf\u00e9-123']) {
      const res = await a.request({
        method: 'PUT',
        url: '/api/v1/integrations/reactive-resume',
        payload: { baseUrl: RR_ORIGIN, apiKey },
      });
      expect(res.statusCode, JSON.stringify(apiKey)).toBe(400);
      expect(res.body).toMatch(/API key/);
      expect(res.body).not.toContain(apiKey);
    }
    const status = await a.request({ method: 'GET', url: '/api/v1/integrations/reactive-resume' });
    expect(status.json()).toMatchObject({ keySet: false, baseUrl: null });
  });

  it('defaults the store to google, and only switches to reactive_resume once connected', async () => {
    const { a } = await boot();
    const def = await a.request({ method: 'GET', url: '/api/v1/settings/document-store' });
    expect(def.json()).toEqual({ store: 'google' });
    const early = await a.request({
      method: 'PUT',
      url: '/api/v1/settings/document-store',
      payload: { store: 'reactive_resume' },
    });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe('reactive_resume_not_connected');
    await connectRr(a);
    const put = await a.request({
      method: 'PUT',
      url: '/api/v1/settings/document-store',
      payload: { store: 'reactive_resume' },
    });
    expect(put.json()).toEqual({ store: 'reactive_resume' });
    const bad = await a.request({
      method: 'PUT',
      url: '/api/v1/settings/document-store',
      payload: { store: 'dropbox' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('registers, reads, copies and edits a Reactive Resume resume through the resume routes', async () => {
    const { a } = await boot();
    await connectRr(a);
    const reg = await registerRr(a, `${RR_ORIGIN}/builder/${RR_BASE_ID}`, 'reactive_resume');
    expect(reg.statusCode).toBe(201);
    expect(reg.json()).toMatchObject({
      kind: 'base',
      store: 'reactive_resume',
      docRef: RR_BASE_ID,
      title: RR_FIXTURE.name,
      url: `${RR_ORIGIN}/builder/${RR_BASE_ID}`,
    });
    const baseId = reg.json().id as string;
    const text = await a.request({ method: 'GET', url: `/api/v1/resumes/${baseId}/text` });
    expect(text.json()).toEqual({ text: FIXTURE_TEXT });

    const oppId = await createOpportunity(a, 'Staff SRE');
    const tailored = await a.request({
      method: 'POST',
      url: '/api/v1/resumes',
      payload: { baseResumeId: baseId, opportunityId: oppId },
    });
    expect(tailored.statusCode).toBe(201);
    const copy = tailored.json();
    expect(copy).toMatchObject({
      kind: 'tailored',
      store: 'reactive_resume',
      parentResumeId: baseId,
    });
    expect(rr.resumes.get(copy.docRef)?.resume.name).toBe(copy.title);

    const session = await a.request({
      method: 'POST',
      url: `/api/v1/resumes/${copy.id}/tailoring`,
    });
    expect(session.statusCode).toBe(200);
    const apply = await a.request({
      method: 'POST',
      url: `/api/v1/tailoring/${session.json().id}/suggestions/apply`,
      payload: { edits: [{ find: 'Built the billing platform in Go', replace: 'Built it in Go' }] },
    });
    expect(apply.json()).toEqual({ results: [{ index: 0, outcome: 'applied' }] });
    expect(bodyText(rr, copy.docRef)).toContain('Built it in Go');
    // The base resume is untouched; Google was never called.
    expect(bodyText(rr, RR_BASE_ID)).toBe(FIXTURE_TEXT);
    expect(google.copies).toEqual([]);
    expect(google.batchUpdates).toEqual([]);
  });

  it('switching stores does not orphan google resumes: they keep reading and copying through Google', async () => {
    const { a } = await boot();
    await connectGoogle(a);
    const googleBase = await registerBase(a);
    await connectRr(a);
    await a.request({
      method: 'PUT',
      url: '/api/v1/settings/document-store',
      payload: { store: 'reactive_resume' },
    });
    // A register without an explicit store follows the setting...
    const rrBase = await registerRr(a);
    expect(rrBase.json().store).toBe('reactive_resume');
    // ...while the existing Google base still reads, copies and edits through Google.
    const text = await a.request({ method: 'GET', url: `/api/v1/resumes/${googleBase}/text` });
    expect(text.json()).toEqual({ text: BASE_TEXT });
    const oppId = await createOpportunity(a);
    const copy = await a.request({
      method: 'POST',
      url: '/api/v1/resumes',
      payload: { baseResumeId: googleBase, opportunityId: oppId },
    });
    expect(copy.json()).toMatchObject({ store: 'google_doc' });
    expect(copy.json().url).toMatch(/^https:\/\/docs\.google\.com\//);
    expect(google.copies).toHaveLength(1);
    const listed = await a.request({ method: 'GET', url: '/api/v1/resumes' });
    expect(
      listed
        .json()
        .items.map((r: { store: string }) => r.store)
        .sort(),
    ).toEqual(['google_doc', 'google_doc', 'reactive_resume']);
    // Switching back leaves the Reactive Resume resume usable too.
    await a.request({
      method: 'PUT',
      url: '/api/v1/settings/document-store',
      payload: { store: 'google' },
    });
    const rrText = await a.request({
      method: 'GET',
      url: `/api/v1/resumes/${rrBase.json().id}/text`,
    });
    expect(rrText.json()).toEqual({ text: FIXTURE_TEXT });
  });

  it('is isolated in both directions: config, setting, key and resumes', async () => {
    const { a, b } = await boot();
    rr.seed('bob', { id: '019a2b3c-4d5e-7f60-8a9b-bbbbbbbbbbbb' });
    await connectRr(a, KEY_A);
    const aBase = (await registerRr(a, RR_BASE_ID, 'reactive_resume')).json().id as string;
    await a.request({
      method: 'PUT',
      url: '/api/v1/settings/document-store',
      payload: { store: 'reactive_resume' },
    });

    // b sees nothing of a's configuration and cannot use it.
    const bStatus = await b.request({ method: 'GET', url: '/api/v1/integrations/reactive-resume' });
    expect(bStatus.json()).toMatchObject({ baseUrl: null, keySet: false, connected: false });
    const bStore = await b.request({ method: 'GET', url: '/api/v1/settings/document-store' });
    expect(bStore.json()).toEqual({ store: 'google' });
    const bNoConfig = await registerRr(b, RR_BASE_ID, 'reactive_resume');
    expect(bNoConfig.statusCode).toBe(409);
    expect(bNoConfig.json().error.code).toBe('reactive_resume_not_connected');
    expect(
      (await b.request({ method: 'GET', url: `/api/v1/resumes/${aBase}/text` })).statusCode,
    ).toBe(404);

    // b connects with b's key: a's resume id is foreign to it at Reactive Resume too.
    await connectRr(b, KEY_B);
    const bForeign = await registerRr(b, RR_BASE_ID, 'reactive_resume');
    expect(bForeign.statusCode).toBe(422);
    const bOwn = await registerRr(b, '019a2b3c-4d5e-7f60-8a9b-bbbbbbbbbbbb', 'reactive_resume');
    expect(bOwn.statusCode).toBe(201);
    expect(
      rr.calls.filter((c) => c.apiKey === KEY_A).every((c) => !c.path.includes('bbbbbbbb')),
    ).toBe(true);

    // ...and the other direction: a cannot touch b's row, and b's disconnect leaves a alone.
    const bId = bOwn.json().id as string;
    expect(
      (await a.request({ method: 'GET', url: `/api/v1/resumes/${bId}/text` })).statusCode,
    ).toBe(404);
    await b.request({ method: 'DELETE', url: '/api/v1/integrations/reactive-resume' });
    const aStill = await a.request({ method: 'GET', url: '/api/v1/integrations/reactive-resume' });
    expect(aStill.json()).toMatchObject({ connected: true });
    expect(
      (await a.request({ method: 'GET', url: `/api/v1/resumes/${aBase}/text` })).statusCode,
    ).toBe(200);
  });

  it('saves the key and the address together or not at all', async () => {
    const { app, a } = await boot();
    await connectRr(a, KEY_A);
    // The address write fails after the key write: neither may stick, or the new key would
    // sit against the old host (or the old key against a new one).
    for (const on of ['INSERT', 'UPDATE'] as const) {
      await withFailingWrite(app, 'settings', {
        on,
        when: `NEW.key LIKE 'reactive_resume_url:%'`,
        message: 'boom',
      });
    }
    const res = await a.request({
      method: 'PUT',
      url: '/api/v1/integrations/reactive-resume',
      payload: { baseUrl: 'https://other.example.org', apiKey: KEY_B },
    });
    expect(res.statusCode).toBe(500);
    expect(await readRrConfig(app.db, { userId: a.userId, isAdmin: true })).toEqual({
      baseUrl: RR_ORIGIN,
      apiKey: KEY_A,
    });
    // The vault row for KEY_B rolled back with the settings write (Task 5 hotspot 9): one key.
    const keys = await queryAll(
      app,
      "SELECT id FROM secrets WHERE user_id = ? AND label = 'reactive_resume'",
      a.userId,
    );
    expect(keys).toHaveLength(1);
  });

  it('disconnecting removes the key, resets the store to google, and keeps resume rows', async () => {
    const { a } = await boot();
    await connectRr(a);
    const id = (await registerRr(a, RR_BASE_ID, 'reactive_resume')).json().id as string;
    await a.request({
      method: 'PUT',
      url: '/api/v1/settings/document-store',
      payload: { store: 'reactive_resume' },
    });
    const del = await a.request({ method: 'DELETE', url: '/api/v1/integrations/reactive-resume' });
    expect(del.statusCode).toBe(204);
    expect((await a.request({ method: 'GET', url: '/api/v1/secrets' })).json().items).toEqual([]);
    expect(
      (await a.request({ method: 'GET', url: '/api/v1/settings/document-store' })).json(),
    ).toEqual({ store: 'google' });
    const row = await a.request({ method: 'GET', url: `/api/v1/resumes/${id}` });
    expect(row.statusCode).toBe(200);
    expect(row.json().url).toBeNull();
    const text = await a.request({ method: 'GET', url: `/api/v1/resumes/${id}/text` });
    expect(text.statusCode).toBe(409);
    expect(text.json().error.code).toBe('reactive_resume_not_connected');
  });
});
