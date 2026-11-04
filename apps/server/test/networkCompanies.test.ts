// The companies in the user's network (https://github.com/bgoleno/opportun/issues/216, #190
// slice N3): every company with at least one current contact, once, with its contact count, the
// strongest strength, its follow state and its board state; Follow does what accepting a
// suggestion does. Built from the user's own rows only: no AI call and no outbound request,
// which the last tests prove. All names and companies are made up.
import { runStructured } from '@opportun/ai';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { companies, discoverySources, jobs, networkContacts, taskRuns } from '../src/db/schema';
import { ATS_DETECT_KIND } from '../src/jobs/atsDetect';
import type { safeFetch } from '../src/lib/safeFetch';
import type { UserCtx } from '../src/repos/base';
import { createContact } from '../src/repos/contacts';
import { useApi } from './api';
import type { TestClient } from './isolation';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn(real.runStructured) };
});

afterEach(() => {
  vi.mocked(runStructured).mockClear();
});

const boot = useApi();
const ctxOf = (c: TestClient): UserCtx => ({ userId: c.userId, isAdmin: false });

interface NetworkCompanyJson {
  company: {
    id: string;
    name: string;
    status: string;
    atsKind: string | null;
    atsRef: string | null;
  };
  board: 'found' | 'not_found' | 'not_checked';
  contactCount: number;
  strongestStrength: number | null;
  contacts: { id: string; name: string; strength: number | null }[];
}

const list = async (c: TestClient, query = '') => {
  const res = await c.request({
    method: 'GET',
    url: `/api/v1/discovery/network-companies${query}`,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ items: NetworkCompanyJson[] }>().items;
};

async function contact(
  app: FastifyInstance,
  c: TestClient,
  name: string,
  company: string | null,
  strength: number | null = null,
) {
  return await createContact(app.db, ctxOf(c), { name, company, strength });
}

async function companyId(app: FastifyInstance, c: TestClient, name: string): Promise<string> {
  const row = await app.db
    .select({ id: companies.id })
    .from(companies)
    .where(and(eq(companies.userId, c.userId), eq(companies.name, name)))
    .get();
  return row!.id;
}

async function setCompany(
  app: FastifyInstance,
  id: string,
  values: Partial<typeof companies.$inferInsert>,
) {
  await app.db.update(companies).set(values).where(eq(companies.id, id)).run();
}

/** Writes a contact's company straight to the table: no route can link across users. */
async function pointContactAt(app: FastifyInstance, contactId: string, currentCompanyId: string) {
  await app.db
    .update(networkContacts)
    .set({ currentCompanyId })
    .where(eq(networkContacts.id, contactId))
    .run();
}

describe('#216 criterion 1: every company with a current contact, once', () => {
  it('with its contact count and the strongest strength, most contacts first', async () => {
    const { app, a, b } = await boot();
    await contact(app, a, 'Riley Sample', 'Contoso', 3);
    await contact(app, a, 'Morgan Example', 'Contoso', 1);
    await contact(app, a, 'Casey Placeholder', 'Contoso', null);
    await contact(app, a, 'Jordan Test', 'Northwind Traders', 2);
    await contact(app, a, 'Avery Demo', null, 3); // no current company: not a company row
    await contact(app, b, 'Quinn Mock', 'Fabrikam', 3); // another user's network
    const items = await list(a);
    expect(items.map((i) => [i.company.name, i.contactCount, i.strongestStrength])).toEqual([
      ['Contoso', 3, 3],
      ['Northwind Traders', 1, 2],
    ]);
    // The names come strongest first, for the "You know N people" disclosure.
    expect(items[0]!.contacts.map((p) => p.name)).toEqual([
      'Riley Sample',
      'Morgan Example',
      'Casey Placeholder',
    ]);
  });

  it('a company with no contacts is not listed, and no strength at all reads as none', async () => {
    const { app, a } = await boot();
    await contact(app, a, 'Riley Sample', 'Contoso', null);
    await app.db
      .insert(companies)
      .values({
        id: crypto.randomUUID(),
        userId: a.userId,
        name: 'Lonely Corp',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();
    const items = await list(a);
    expect(items.map((i) => i.company.name)).toEqual(['Contoso']);
    expect(items[0]!.strongestStrength).toBeNull();
  });
});

describe('the list order and each user filter on its own (#211 items 4 and 5)', () => {
  it('most contacts first, then the strongest, then the name', async () => {
    const { app, a } = await boot();
    // Four, not three: only a pair tied on both count and strength can show the name's sort.
    // Beta is created before Alpha, so without the name's sort it would come first.
    await contact(app, a, 'Riley Sample', 'Zeta Holdings', 1);
    await contact(app, a, 'Morgan Example', 'Zeta Holdings', 1);
    await contact(app, a, 'Casey Placeholder', 'Middle Works', 3);
    await contact(app, a, 'Jordan Test', 'Beta Labs', 2);
    await contact(app, a, 'Avery Demo', 'Alpha Labs', 2);
    expect((await list(a)).map((i) => i.company.name)).toEqual([
      'Zeta Holdings',
      'Middle Works',
      'Alpha Labs',
      'Beta Labs',
    ]);
  });

  it("the contact filter: another user's contact at this user's company is not counted", async () => {
    const { app, a, b } = await boot();
    await contact(app, a, 'Riley Sample', 'Contoso', 1);
    const id = await companyId(app, a, 'Contoso');
    const stray = await contact(app, b, 'Quinn Mock', null, 3);
    await pointContactAt(app, stray.id, id);
    const items = await list(a);
    expect(items.map((i) => [i.company.name, i.contactCount, i.strongestStrength])).toEqual([
      ['Contoso', 1, 1],
    ]);
    expect(items[0]!.contacts.map((p) => p.name)).toEqual(['Riley Sample']);
  });

  it("the company filter: a contact pointing at another user's company does not list it", async () => {
    const { app, a, b } = await boot();
    await contact(app, a, 'Riley Sample', 'Contoso', 1);
    await contact(app, b, 'Quinn Mock', 'Fabrikam', 3);
    const stray = await contact(app, a, 'Morgan Example', null, 2);
    await pointContactAt(app, stray.id, await companyId(app, b, 'Fabrikam'));
    expect((await list(a)).map((i) => i.company.name)).toEqual(['Contoso']);
  });
});

describe('#216 criteria 1 and 6: follow, denied and board states', () => {
  it('followed and not; a board found, not found, or not checked', async () => {
    const { app, a } = await boot();
    await contact(app, a, 'Riley Sample', 'Contoso', 3);
    await contact(app, a, 'Jordan Test', 'Northwind Traders', 2);
    await contact(app, a, 'Casey Placeholder', 'Tailspin Toys', 1);
    await setCompany(app, await companyId(app, a, 'Contoso'), {
      status: 'followed',
      atsKind: 'ats_lever',
      atsRef: 'contoso',
      atsVerifiedAt: Date.now(),
    });
    await setCompany(app, await companyId(app, a, 'Northwind Traders'), {
      atsKind: 'none',
      atsVerifiedAt: Date.now(),
    });
    const byName = new Map((await list(a)).map((i) => [i.company.name, i]));
    expect(byName.get('Contoso')).toMatchObject({
      board: 'found',
      company: { status: 'followed', atsKind: 'ats_lever', atsRef: 'contoso' },
    });
    expect(byName.get('Northwind Traders')).toMatchObject({
      board: 'not_found',
      company: { status: 'none' },
    });
    expect(byName.get('Tailspin Toys')).toMatchObject({ board: 'not_checked' });
  });

  it('a denied company is hidden unless "Show denied" is chosen', async () => {
    const { app, a } = await boot();
    await contact(app, a, 'Riley Sample', 'Contoso', 3);
    await contact(app, a, 'Jordan Test', 'Northwind Traders', 2);
    await setCompany(app, await companyId(app, a, 'Contoso'), { status: 'denied' });
    expect((await list(a)).map((i) => i.company.name)).toEqual(['Northwind Traders']);
    const all = await list(a, '?showDenied=true');
    expect(all.map((i) => [i.company.name, i.company.status])).toEqual([
      ['Contoso', 'denied'],
      ['Northwind Traders', 'none'],
    ]);
  });
});

describe('#216 criterion 3: Follow does what accepting a suggestion does', () => {
  const follow = (c: TestClient, id: string) =>
    c.request({ method: 'POST', url: `/api/v1/companies/${id}/follow` });

  it('a company in the network becomes followed, and its board detection is queued', async () => {
    const { app, a } = await boot();
    await contact(app, a, 'Riley Sample', 'Contoso', 3);
    const id = await companyId(app, a, 'Contoso');
    const res = await follow(a, id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('followed');
    const queued = await app.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.kind, ATS_DETECT_KIND), eq(jobs.userId, a.userId)))
      .all();
    expect(queued).toHaveLength(1);
  });

  it('a company whose last detection found no board: detection is queued again (#211 item 2)', async () => {
    const { app, a } = await boot();
    await contact(app, a, 'Riley Sample', 'Contoso', 3);
    const id = await companyId(app, a, 'Contoso');
    await setCompany(app, id, { atsKind: 'none' });
    const res = await follow(a, id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('followed');
    const queued = await app.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.kind, ATS_DETECT_KIND), eq(jobs.userId, a.userId)))
      .all();
    expect(queued.map((j) => j.payload)).toEqual([{ companyId: id }]);
  });

  it('with a board already found, following enables its source, as accept does', async () => {
    const { app, a } = await boot();
    await contact(app, a, 'Riley Sample', 'Contoso', 3);
    const id = await companyId(app, a, 'Contoso');
    await setCompany(app, id, {
      atsKind: 'ats_lever',
      atsRef: 'contoso',
      atsVerifiedAt: Date.now(),
    });
    expect((await follow(a, id)).statusCode).toBe(200);
    const sources = await app.db
      .select()
      .from(discoverySources)
      .where(and(eq(discoverySources.userId, a.userId), eq(discoverySources.companyId, id)))
      .all();
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ kind: 'ats_lever', enabled: true });
  });

  it('a pending suggestion can be followed here too; following twice changes nothing', async () => {
    const { app, a } = await boot();
    await contact(app, a, 'Riley Sample', 'Contoso', 3);
    const id = await companyId(app, a, 'Contoso');
    await setCompany(app, id, { status: 'suggested' });
    expect((await follow(a, id)).statusCode).toBe(200);
    const again = await follow(a, id);
    expect(again.statusCode).toBe(200);
    expect(again.json<{ status: string }>().status).toBe('followed');
    const queued = await app.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.kind, ATS_DETECT_KIND), eq(jobs.userId, a.userId)))
      .all();
    expect(queued).toHaveLength(1);
  });

  it('a denied company is refused: undeny it first', async () => {
    const { app, a } = await boot();
    await contact(app, a, 'Riley Sample', 'Contoso', 3);
    const id = await companyId(app, a, 'Contoso');
    await setCompany(app, id, { status: 'denied' });
    const res = await follow(a, id);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('company_denied');
  });

  it("another user's company reads as not found", async () => {
    const { app, a, b } = await boot();
    await contact(app, b, 'Quinn Mock', 'Fabrikam', 3);
    const id = await companyId(app, b, 'Fabrikam');
    expect((await follow(a, id)).statusCode).toBe(404);
  });
});

describe('#216 criterion 5: nothing leaves the server', () => {
  it('listing the network companies, and following one, make no outbound request and no AI call', async () => {
    const { app, a } = await boot();
    await contact(app, a, 'Riley Sample', 'Contoso', 3);
    await contact(app, a, 'Jordan Test', 'Northwind Traders', 2);
    const fetched: string[] = [];
    app.jobs.services.sourceFetch = (async (url: string) => {
      fetched.push(`sourceFetch ${url}`);
      throw new Error('no fetch in this flow');
    }) as unknown as typeof safeFetch;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      fetched.push(`fetch ${String(input)}`);
      throw new Error('no fetch in this flow');
    }) as typeof fetch;
    try {
      await list(a);
      await list(a, '?showDenied=true');
      const id = await companyId(app, a, 'Contoso');
      expect(
        (await a.request({ method: 'POST', url: `/api/v1/companies/${id}/follow` })).statusCode,
      ).toBe(200);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(fetched).toEqual([]);
    expect(vi.mocked(runStructured)).not.toHaveBeenCalled();
    const ran = await app.db.select().from(taskRuns).where(eq(taskRuns.userId, a.userId)).all();
    expect(ran).toEqual([]);
  });
});
