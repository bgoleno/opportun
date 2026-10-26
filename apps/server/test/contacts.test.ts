// Contacts API (Task 19, FR-C1): CRUD, company mapping by name on write, list filters, the
// FTS index (entity_kind 'contact'), and cross-user isolation.
import { describe, expect, it } from 'vitest';
import { useApi } from './api';
import { assertIsolated, type TestClient } from './isolation';

const boot = useApi();

interface ContactBody {
  id: string;
  name: string;
  emails: string[];
  linkedinUrl: string | null;
  currentCompanyId: string | null;
  currentCompanyName: string | null;
  history: { company: string; title: string | null; from: string | null; to: string | null }[];
  strength: number | null;
  notes: string | null;
  source: string;
  tags: string[];
}

async function createContact(c: TestClient, body: Record<string, unknown> = {}) {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/contacts',
    payload: { name: 'Jane Doe', ...body },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as ContactBody;
}

async function list(c: TestClient, query = '') {
  const res = await c.request({ method: 'GET', url: `/api/v1/contacts${query}` });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { items: ContactBody[]; total: number };
}

describe('contacts api', () => {
  it('creates, reads, patches and deletes a contact', async () => {
    const { a } = await boot();
    const created = await createContact(a, {
      emails: ['Jane@Example.com'],
      linkedinUrl: 'https://www.linkedin.com/in/jane-doe',
      company: 'Initech',
      history: [{ company: 'Globex', title: 'Engineer', from: '2019', to: '2022' }],
      strength: 3,
      notes: 'Met at the platform meetup.',
      tags: ['platform', 'former colleague'],
    });
    expect(created).toMatchObject({
      name: 'Jane Doe',
      emails: ['jane@example.com'],
      linkedinUrl: 'https://www.linkedin.com/in/jane-doe',
      currentCompanyName: 'Initech',
      history: [{ company: 'Globex', title: 'Engineer', from: '2019', to: '2022' }],
      strength: 3,
      notes: 'Met at the platform meetup.',
      source: 'manual',
      tags: ['platform', 'former colleague'],
    });
    expect(created.currentCompanyId).toEqual(expect.any(String));

    const read = await a.request({ method: 'GET', url: `/api/v1/contacts/${created.id}` });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ id: created.id, name: 'Jane Doe', referrals: [] });

    const patched = await a.request({
      method: 'PATCH',
      url: `/api/v1/contacts/${created.id}`,
      payload: { strength: null, notes: '', company: null, tags: [] },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json()).toMatchObject({
      strength: null,
      notes: null,
      currentCompanyId: null,
      currentCompanyName: null,
      tags: [],
    });

    const del = await a.request({ method: 'DELETE', url: `/api/v1/contacts/${created.id}` });
    expect(del.statusCode).toBe(204);
    const gone = await a.request({ method: 'GET', url: `/api/v1/contacts/${created.id}` });
    expect(gone.statusCode).toBe(404);
  });

  it('validates input: strength 1-3, http(s) linkedin url, emails', async () => {
    const { a } = await boot();
    for (const bad of [
      { strength: 4 },
      { strength: 0 },
      { linkedinUrl: 'javascript:alert(1)' },
      { emails: ['not-an-email'] },
      { source: 'scraped' },
    ]) {
      const res = await a.request({
        method: 'POST',
        url: '/api/v1/contacts',
        payload: { name: 'X', ...bad },
      });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  it('maps the company by name on write: find-or-create, case-insensitively', async () => {
    const { a } = await boot();
    const opp = await a.request({
      method: 'POST',
      url: '/api/v1/opportunities',
      payload: { companyName: 'Initech', title: 'Staff PM', sourceKind: 'manual' },
    });
    const companyId = (opp.json() as { companyId: string }).companyId;

    const jane = await createContact(a, { company: 'initech' });
    expect(jane.currentCompanyId).toBe(companyId);
    const sam = await createContact(a, { name: 'Sam Lee', company: 'Hooli' });
    expect(sam.currentCompanyId).not.toBe(companyId);
    expect(sam.currentCompanyName).toBe('Hooli');

    const moved = await a.request({
      method: 'PATCH',
      url: `/api/v1/contacts/${sam.id}`,
      payload: { company: 'INITECH' },
    });
    expect(moved.json()).toMatchObject({
      currentCompanyId: companyId,
      currentCompanyName: 'Initech',
    });

    const companies = await a.request({ method: 'GET', url: '/api/v1/companies' });
    expect((companies.json() as { total: number }).total).toBe(2);

    const atInitech = await list(a, `?companyId=${companyId}`);
    expect(atInitech.items.map((c) => c.name).sort()).toEqual(['Jane Doe', 'Sam Lee']);
  });

  it('lists with paging, sort, and ?q over name and email', async () => {
    const { a } = await boot();
    await createContact(a, { name: 'Jane Doe', emails: ['jane@initech.example'] });
    await createContact(a, { name: 'Sam Lee', emails: ['sam@hooli.example'] });
    await createContact(a, { name: 'Ana Ruiz' });

    const all = await list(a, '?sort=name');
    expect(all.total).toBe(3);
    expect(all.items.map((c) => c.name)).toEqual(['Ana Ruiz', 'Jane Doe', 'Sam Lee']);
    const desc = await list(a, '?sort=-name&limit=1&offset=1');
    expect(desc.total).toBe(3);
    expect(desc.items.map((c) => c.name)).toEqual(['Jane Doe']);

    expect((await list(a, '?q=sam')).items.map((c) => c.name)).toEqual(['Sam Lee']);
    expect((await list(a, '?q=initech.example')).items.map((c) => c.name)).toEqual(['Jane Doe']);
    // LIKE wildcards in q are literal.
    expect((await list(a, '?q=%25')).total).toBe(0);

    const badSort = await a.request({ method: 'GET', url: '/api/v1/contacts?sort=password' });
    expect(badSort.statusCode).toBe(400);
  });

  it('indexes name and notes for full-text search, and drops the row on delete', async () => {
    const { a, b } = await boot();
    const jane = await createContact(a, { notes: 'Knows the observability team lead.' });
    const search = async (c: TestClient, q: string) =>
      (
        await c.request({ method: 'GET', url: `/api/v1/search?q=${encodeURIComponent(q)}` })
      ).json() as { items: { entityKind: string; entityId: string; opportunityId: null }[] };

    expect((await search(a, 'observability')).items).toEqual([
      expect.objectContaining({ entityKind: 'contact', entityId: jane.id, opportunityId: null }),
    ]);
    expect((await search(a, 'Jane')).items.map((h) => h.entityId)).toEqual([jane.id]);
    // Another user never sees it.
    expect((await search(b, 'observability')).items).toEqual([]);

    await a.request({
      method: 'PATCH',
      url: `/api/v1/contacts/${jane.id}`,
      payload: { notes: 'Now on the payments team.' },
    });
    expect((await search(a, 'observability')).items).toEqual([]);
    expect((await search(a, 'payments')).items).toHaveLength(1);

    await a.request({ method: 'DELETE', url: `/api/v1/contacts/${jane.id}` });
    expect((await search(a, 'payments')).items).toEqual([]);
    expect((await search(a, 'Jane')).items).toEqual([]);
  });

  it('never lists or filters into another user', async () => {
    const { a, b } = await boot();
    const jane = await createContact(a, { company: 'Initech' });
    expect((await list(b)).total).toBe(0);
    expect((await list(b, `?companyId=${jane.currentCompanyId}`)).total).toBe(0);
    expect((await list(b, '?q=Jane')).total).toBe(0);
    const patch = await b.request({
      method: 'PATCH',
      url: `/api/v1/contacts/${jane.id}`,
      payload: { name: 'Pwned' },
    });
    expect(patch.statusCode).toBe(404);
    const del = await b.request({ method: 'DELETE', url: `/api/v1/contacts/${jane.id}` });
    expect(del.statusCode).toBe(404);
    // Same company name for B maps to B's own company, never A's.
    const bJane = await createContact(b, { company: 'Initech' });
    expect(bJane.currentCompanyId).not.toBe(jane.currentCompanyId);
  });
});

assertIsolated({
  name: 'contacts (GET)',
  create: async (c) => (await createContact(c)).id,
  read: (c, id) => c.request({ method: 'GET', url: `/api/v1/contacts/${id}` }),
});

assertIsolated({
  name: 'contacts (PATCH)',
  create: async (c) => (await createContact(c)).id,
  read: (c, id) =>
    c.request({ method: 'PATCH', url: `/api/v1/contacts/${id}`, payload: { notes: 'x' } }),
});

assertIsolated({
  name: 'contacts (DELETE)',
  create: async (c) => (await createContact(c)).id,
  read: (c, id) => c.request({ method: 'DELETE', url: `/api/v1/contacts/${id}` }),
});
