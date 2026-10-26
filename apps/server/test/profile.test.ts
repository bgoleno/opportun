import { describe, expect, it } from 'vitest';
import { useApi } from './api';
import { assertIsolated, type TestClient } from './isolation';

const boot = useApi();

const ROLE_TARGET = {
  name: 'AI PM',
  titleFamily: 'Product Manager',
  seniorityMin: 3,
  seniorityMax: 5,
  industries: ['devtools'],
  keywords: ['agents', 'llm'],
  locations: ['Remote', 'Seattle, WA'],
  remotePref: 'remote',
  compMin: 200_000,
  compMax: 300_000,
  currency: 'USD',
  active: true,
};

async function createTarget(c: TestClient, extra: Record<string, unknown> = {}) {
  return c.request({
    method: 'POST',
    url: '/api/v1/role-targets',
    payload: { ...ROLE_TARGET, ...extra },
  });
}

async function createRule(c: TestClient, extra: Record<string, unknown> = {}) {
  return c.request({
    method: 'POST',
    url: '/api/v1/resume-rules',
    payload: { ruleText: 'Never list my home address.', category: 'redaction', ...extra },
  });
}

describe('profile', () => {
  it('returns an empty profile before the first PUT', async () => {
    const { a } = await boot();
    const res = await a.request({ method: 'GET', url: '/api/v1/profile' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ userId: a.userId, fullName: null, links: [] });
  });

  it('replaces the profile on PUT and returns it on GET', async () => {
    const { a } = await boot();
    const body = {
      fullName: 'Ada Lovelace',
      headline: 'Product leader',
      email: 'ada@example.com',
      phone: '+1 555 0100',
      location: 'Seattle, WA',
      workAuth: 'US citizen',
      links: [{ label: 'LinkedIn', url: 'https://www.linkedin.com/in/ada' }],
    };
    const put = await a.request({ method: 'PUT', url: '/api/v1/profile', payload: body });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ ...body, userId: a.userId });
    expect(put.json().updatedAt).toBeGreaterThan(0);

    // PUT is a full replace: omitted fields reset to null.
    const second = await a.request({
      method: 'PUT',
      url: '/api/v1/profile',
      payload: { fullName: 'Ada King' },
    });
    expect(second.json()).toMatchObject({ fullName: 'Ada King', headline: null, links: [] });

    const get = await a.request({ method: 'GET', url: '/api/v1/profile' });
    expect(get.json()).toEqual(second.json());
  });

  it('rejects an invalid email and an invalid link url with 400', async () => {
    const { a } = await boot();
    const bad = await a.request({
      method: 'PUT',
      url: '/api/v1/profile',
      payload: { email: 'not-an-email', links: [{ label: 'x', url: 'nope' }] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('validation');
    const script = await a.request({
      method: 'PUT',
      url: '/api/v1/profile',
      payload: { links: [{ label: 'x', url: 'javascript:alert(1)' }] },
    });
    expect(script.statusCode).toBe(400);
  });

  it('requires a session', async () => {
    const { app } = await boot();
    const res = await app.inject({ method: 'GET', url: '/api/v1/profile' });
    expect(res.statusCode).toBe(401);
  });

  // The profile is a per-user singleton with no id to address, so assertIsolated (which
  // reads by id) does not apply; this is the same check in both directions.
  it('isolates the profile between users in both directions', async () => {
    const { a, b } = await boot();
    for (const [owner, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const marker = `owner ${owner.userId}`;
      await owner.request({ method: 'PUT', url: '/api/v1/profile', payload: { fullName: marker } });
      const asOther = await other.request({ method: 'GET', url: '/api/v1/profile' });
      expect(asOther.json().userId).toBe(other.userId);
      expect(asOther.body).not.toContain(marker);
      const asOwner = await owner.request({ method: 'GET', url: '/api/v1/profile' });
      expect(asOwner.json().fullName).toBe(marker);
    }
  });
});

describe('role targets', () => {
  it('creates, lists, patches and deletes', async () => {
    const { a } = await boot();
    const created = await createTarget(a);
    expect(created.statusCode).toBe(201);
    const rt = created.json();
    expect(rt).toMatchObject({ ...ROLE_TARGET, userId: a.userId });
    expect(rt.id).toMatch(/^[0-9a-f-]{36}$/);

    await createTarget(a, { name: 'Staff PM', active: false });
    const list = await a.request({ method: 'GET', url: '/api/v1/role-targets?sort=name' });
    expect(list.statusCode).toBe(200);
    expect(list.json().total).toBe(2);
    expect(list.json().items.map((x: { name: string }) => x.name)).toEqual(['AI PM', 'Staff PM']);

    const patched = await a.request({
      method: 'PATCH',
      url: `/api/v1/role-targets/${rt.id}`,
      payload: { keywords: ['agents'], remotePref: 'hybrid', compMax: null },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      id: rt.id,
      name: 'AI PM',
      keywords: ['agents'],
      remotePref: 'hybrid',
      compMax: null,
    });
    expect(patched.json().updatedAt).toBeGreaterThanOrEqual(rt.updatedAt);

    const got = await a.request({ method: 'GET', url: `/api/v1/role-targets/${rt.id}` });
    expect(got.json()).toEqual(patched.json());

    const del = await a.request({ method: 'DELETE', url: `/api/v1/role-targets/${rt.id}` });
    expect(del.statusCode).toBe(204);
    const gone = await a.request({ method: 'GET', url: `/api/v1/role-targets/${rt.id}` });
    expect(gone.statusCode).toBe(404);
  });

  it('applies defaults for omitted optional fields', async () => {
    const { a } = await boot();
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/role-targets',
      payload: { name: 'Minimal', titleFamily: 'Engineer' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      industries: [],
      keywords: [],
      locations: [],
      remotePref: 'any',
      active: true,
      seniorityMin: null,
    });
  });

  it('rejects seniorityMin > seniorityMax with 400 on create', async () => {
    const { a } = await boot();
    const res = await createTarget(a, { seniorityMin: 6, seniorityMax: 4 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation');
  });

  it('rejects a patch that would invert the stored seniority range', async () => {
    const { a } = await boot();
    const rt = (await createTarget(a)).json();
    const res = await a.request({
      method: 'PATCH',
      url: `/api/v1/role-targets/${rt.id}`,
      payload: { seniorityMin: 9 },
    });
    expect(res.statusCode).toBe(400);
    const got = await a.request({ method: 'GET', url: `/api/v1/role-targets/${rt.id}` });
    expect(got.json().seniorityMin).toBe(3);
  });

  it('rejects unknown remotePref and missing name', async () => {
    const { a } = await boot();
    expect((await createTarget(a, { remotePref: 'mars' })).statusCode).toBe(400);
    expect((await createTarget(a, { name: undefined })).statusCode).toBe(400);
  });

  it('honors limit, offset and rejects limit over 200', async () => {
    const { a } = await boot();
    for (const n of ['a', 'b', 'c']) await createTarget(a, { name: n });
    const page = await a.request({
      method: 'GET',
      url: '/api/v1/role-targets?limit=1&offset=1&sort=-name',
    });
    expect(page.json()).toMatchObject({ total: 3, items: [{ name: 'b' }] });
    const tooMany = await a.request({ method: 'GET', url: '/api/v1/role-targets?limit=201' });
    expect(tooMany.statusCode).toBe(400);
    const badSort = await a.request({ method: 'GET', url: '/api/v1/role-targets?sort=userId' });
    expect(badSort.statusCode).toBe(400);
  });

  it('lists only the caller rows', async () => {
    const { a, b } = await boot();
    await createTarget(a);
    const list = await b.request({ method: 'GET', url: '/api/v1/role-targets' });
    expect(list.json()).toEqual({ items: [], total: 0 });
  });

  assertIsolated({
    name: 'role targets (GET)',
    create: async (c) => (await createTarget(c)).json().id,
    read: (c, id) => c.request({ method: 'GET', url: `/api/v1/role-targets/${id}` }),
  });
  assertIsolated({
    name: 'role targets (PATCH)',
    create: async (c) => (await createTarget(c)).json().id,
    read: (c, id) =>
      c.request({ method: 'PATCH', url: `/api/v1/role-targets/${id}`, payload: { name: 'x' } }),
  });
  assertIsolated({
    name: 'role targets (DELETE)',
    create: async (c) => (await createTarget(c)).json().id,
    read: (c, id) => c.request({ method: 'DELETE', url: `/api/v1/role-targets/${id}` }),
  });
});

describe('resume rules', () => {
  it('creates, lists in sortOrder, patches and deletes', async () => {
    const { a } = await boot();
    const first = await createRule(a, { sortOrder: 2 });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      ruleText: 'Never list my home address.',
      category: 'redaction',
      active: true,
      sortOrder: 2,
      userId: a.userId,
    });
    await createRule(a, { ruleText: 'Use active voice.', category: 'style', sortOrder: 1 });

    const list = await a.request({ method: 'GET', url: '/api/v1/resume-rules' });
    expect(list.json().total).toBe(2);
    expect(list.json().items.map((r: { sortOrder: number }) => r.sortOrder)).toEqual([1, 2]);

    const id = first.json().id;
    const patched = await a.request({
      method: 'PATCH',
      url: `/api/v1/resume-rules/${id}`,
      payload: { active: false, ruleText: 'Never list my street address.' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      id,
      active: false,
      ruleText: 'Never list my street address.',
      category: 'redaction',
    });

    expect(
      (await a.request({ method: 'DELETE', url: `/api/v1/resume-rules/${id}` })).statusCode,
    ).toBe(204);
    const after = await a.request({ method: 'GET', url: '/api/v1/resume-rules' });
    expect(after.json().total).toBe(1);
  });

  it('rejects an unknown category and empty ruleText', async () => {
    const { a } = await boot();
    expect((await createRule(a, { category: 'vibes' })).statusCode).toBe(400);
    expect((await createRule(a, { ruleText: '' })).statusCode).toBe(400);
  });

  assertIsolated({
    name: 'resume rules (GET)',
    create: async (c) => (await createRule(c)).json().id,
    read: (c, id) => c.request({ method: 'GET', url: `/api/v1/resume-rules/${id}` }),
  });
  assertIsolated({
    name: 'resume rules (PATCH)',
    create: async (c) => (await createRule(c)).json().id,
    read: (c, id) =>
      c.request({ method: 'PATCH', url: `/api/v1/resume-rules/${id}`, payload: { active: false } }),
  });
  assertIsolated({
    name: 'resume rules (DELETE)',
    create: async (c) => (await createRule(c)).json().id,
    read: (c, id) => c.request({ method: 'DELETE', url: `/api/v1/resume-rules/${id}` }),
  });
});
