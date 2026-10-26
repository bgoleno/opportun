// Mail filter routes (spec D7). The pattern tester is the interesting one: it runs a candidate
// against the user's real sender history so a shorthand like `*.gmail.com`, which matches
// nothing, is caught before it is saved rather than silently doing nothing forever.
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { upsertInbound } from '../src/repos/communications';
import { useApi } from './api';
import type { TestClient } from './isolation';

const boot = useApi();

let seq = 0;
async function seedSender(app: FastifyInstance, userId: string, from: string): Promise<void> {
  seq += 1;
  await upsertInbound(app.db, { userId, isAdmin: false }, 'gmail', {
    externalId: `api-ext-${seq}`,
    threadKey: `api-thread-${seq}`,
    from,
    to: ['me@user.example'],
    subject: `Subject ${seq}`,
    snippet: 'snippet',
    bodyText: 'body',
    sentAt: Date.now() - seq * 1000,
  });
}

const post = (c: TestClient, url: string, payload: Record<string, unknown>) =>
  c.request({ method: 'POST', url, payload });

describe('GET /mail-filters', () => {
  it('returns the rules, the label scope, and the consumer veto state', async () => {
    const { a } = await boot();
    const res = await a.request({ method: 'GET', url: '/api/v1/mail-filters' });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { rules: unknown[]; label: string | null; consumerVeto: boolean };
    expect(body.rules).toEqual([]);
    expect(body.label).toBeNull();
    expect(body.consumerVeto).toBe(true);
  });
});

describe('mail filter CRUD', () => {
  it('creates, updates and deletes a rule', async () => {
    const { a } = await boot();
    const created = await post(a, '/api/v1/mail-filters', {
      pattern: '*@clinic-a.example',
      effect: 'deny',
    });
    expect(created.statusCode, created.body).toBe(201);
    const { id } = created.json() as { id: string };

    const patched = await a.request({
      method: 'PATCH',
      url: `/api/v1/mail-filters/${id}`,
      payload: { enabled: false },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect((patched.json() as { enabled: boolean }).enabled).toBe(false);

    const removed = await a.request({ method: 'DELETE', url: `/api/v1/mail-filters/${id}` });
    expect(removed.statusCode).toBe(204);
  });

  it('rejects a pattern the matcher cannot parse', async () => {
    const { a } = await boot();
    const res = await post(a, '/api/v1/mail-filters', { pattern: 'nodot', effect: 'deny' });
    expect(res.statusCode).toBe(400);
  });

  it("will not touch another user's rule", async () => {
    const { a, b } = await boot();
    const created = await post(a, '/api/v1/mail-filters', {
      pattern: '*@acme.test',
      effect: 'deny',
    });
    const { id } = created.json() as { id: string };

    const res = await b.request({
      method: 'PATCH',
      url: `/api/v1/mail-filters/${id}`,
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('PUT /mail-filters/label', () => {
  it('sets and clears the watched label', async () => {
    const { a } = await boot();
    const set = await a.request({
      method: 'PUT',
      url: '/api/v1/mail-filters/label',
      payload: { label: 'JobSearch' },
    });
    expect(set.statusCode, set.body).toBe(200);
    expect((set.json() as { label: string | null }).label).toBe('JobSearch');

    const cleared = await a.request({
      method: 'PUT',
      url: '/api/v1/mail-filters/label',
      payload: { label: null },
    });
    expect((cleared.json() as { label: string | null }).label).toBeNull();
  });

  it('refuses a label Gmail cannot be asked for safely', async () => {
    const { a } = await boot();
    const res = await a.request({
      method: 'PUT',
      url: '/api/v1/mail-filters/label',
      payload: { label: 'bad"label' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /mail-filters/test', () => {
  it('offers the address form when a subdomain shorthand matches nothing', async () => {
    const { app, a } = await boot();
    await seedSender(app, a.userId, 'someone@gmail.com');
    await seedSender(app, a.userId, 'other@gmail.com');

    const res = await post(a, '/api/v1/mail-filters/test', { pattern: '*.gmail.com' });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      valid: boolean;
      matchCount: number;
      suggestions: { pattern: string; matchCount: number }[];
    };
    expect(body.valid).toBe(true);
    expect(body.matchCount).toBe(0);
    expect(body.suggestions).toEqual([{ pattern: '*@gmail.com', matchCount: 2 }]);
  });

  it('counts matches for an explicit pattern and suggests nothing', async () => {
    const { app, a } = await boot();
    await seedSender(app, a.userId, 'someone@gmail.com');

    const res = await post(a, '/api/v1/mail-filters/test', { pattern: '*@gmail.com' });

    const body = res.json() as { matchCount: number; suggestions: unknown[] };
    expect(body.matchCount).toBe(1);
    expect(body.suggestions).toEqual([]);
  });

  it('never suggests a correction that also matches nothing', async () => {
    const { app, a } = await boot();
    await seedSender(app, a.userId, 'someone@brightforge.example');

    const res = await post(a, '/api/v1/mail-filters/test', { pattern: '*.nowhere.test' });

    const body = res.json() as { matchCount: number; suggestions: unknown[] };
    expect(body.matchCount).toBe(0);
    expect(body.suggestions).toEqual([]);
  });

  it('reports an unparseable pattern as invalid rather than failing the request', async () => {
    const { a } = await boot();
    const res = await post(a, '/api/v1/mail-filters/test', { pattern: 'nodot' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { valid: boolean }).valid).toBe(false);
  });

  it("counts only the caller's own senders", async () => {
    const { app, a, b } = await boot();
    await seedSender(app, b.userId, 'someone@gmail.com');

    const res = await post(a, '/api/v1/mail-filters/test', { pattern: '*@gmail.com' });

    expect((res.json() as { matchCount: number }).matchCount).toBe(0);
  });
});

// Known job senders, rule 4 (spec D7 item 4, decision D-3). The list ships in code, so the
// interesting behavior is not CRUD: it is that switching a built-in off is a DISABLED rule
// naming the same pattern, which is what keeps a code-shipped list the user's to edit while
// still letting a later release change it.
describe('GET /mail-filters/job-senders', () => {
  const senders = async (c: TestClient) => {
    const res = await c.request({ method: 'GET', url: '/api/v1/mail-filters/job-senders' });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { senders: JobSenderView[] }).senders;
  };

  interface JobSenderView {
    pattern: string;
    platform: string;
    sends: string;
    builtIn: boolean;
    enabled: boolean;
    matchCount: number;
  }

  it('lists the built-in senders, enabled, with what each one sends', async () => {
    const { a } = await boot();

    const list = await senders(a);

    const linkedin = list.find((s) => s.pattern === 'inmail-hit-reply@linkedin.com');
    expect(linkedin).toMatchObject({ builtIn: true, enabled: true, platform: 'LinkedIn' });
    expect(linkedin?.sends.length).toBeGreaterThan(0);
    expect(list.every((s) => s.builtIn)).toBe(true);
  });

  it('counts each pattern against the senders in the caller mail only', async () => {
    const { app, a, b } = await boot();
    await seedSender(app, a.userId, 'no-reply@us.greenhouse-mail.io');
    await seedSender(app, a.userId, 'other@us.greenhouse-mail.io');
    await seedSender(app, b.userId, 'third@us.greenhouse-mail.io');

    const list = await senders(a);

    expect(list.find((s) => s.pattern === '*@*.greenhouse-mail.io')?.matchCount).toBe(2);
    expect(list.find((s) => s.pattern === 'inmail-hit-reply@linkedin.com')?.matchCount).toBe(0);
  });

  it('switches a built-in off by storing a disabled rule for the same pattern', async () => {
    const { a } = await boot();

    const res = await a.request({
      method: 'PUT',
      url: '/api/v1/mail-filters/job-senders',
      payload: { pattern: 'inmail-hit-reply@linkedin.com', enabled: false },
    });
    expect(res.statusCode, res.body).toBe(200);

    const list = await senders(a);
    expect(list.find((s) => s.pattern === 'inmail-hit-reply@linkedin.com')?.enabled).toBe(false);
    // The rule is how the choice survives a release that edits the built-in list.
    const rules = (
      (await a.request({ method: 'GET', url: '/api/v1/mail-filters' })).json() as {
        rules: { pattern: string; effect: string; enabled: boolean }[];
      }
    ).rules;
    expect(rules).toEqual([
      expect.objectContaining({
        pattern: 'inmail-hit-reply@linkedin.com',
        effect: 'job_sender',
        enabled: false,
      }),
    ]);
  });

  it('switching one off twice is not an error, and switching it back on removes the rule', async () => {
    const { a } = await boot();
    const off = (enabled: boolean) =>
      a.request({
        method: 'PUT',
        url: '/api/v1/mail-filters/job-senders',
        payload: { pattern: '*@candidate.fyi', enabled },
      });

    expect((await off(false)).statusCode).toBe(200);
    expect((await off(false)).statusCode).toBe(200);
    expect((await senders(a)).find((s) => s.pattern === '*@candidate.fyi')?.enabled).toBe(false);

    expect((await off(true)).statusCode).toBe(200);
    expect((await senders(a)).find((s) => s.pattern === '*@candidate.fyi')?.enabled).toBe(true);
    expect(
      (
        (await a.request({ method: 'GET', url: '/api/v1/mail-filters' })).json() as {
          rules: unknown[];
        }
      ).rules,
    ).toEqual([]);
  });

  it('refuses a pattern that is not a built-in, so the UI cannot invent one here', async () => {
    const { a } = await boot();

    const res = await a.request({
      method: 'PUT',
      url: '/api/v1/mail-filters/job-senders',
      payload: { pattern: '*@not-a-builtin.example', enabled: false },
    });

    expect(res.statusCode, res.body).toBe(404);
  });

  it("lists the user's own additions alongside the built-ins, marked as theirs", async () => {
    const { a } = await boot();
    await post(a, '/api/v1/mail-filters', {
      pattern: '*@talentpartners.example',
      effect: 'job_sender',
    });

    const list = await senders(a);

    const own = list.find((s) => s.pattern === '*@talentpartners.example');
    expect(own).toMatchObject({ builtIn: false, enabled: true, platform: '' });
    expect(list.filter((s) => s.builtIn).length).toBeGreaterThan(0);
  });

  it('shows a disabled built-in once, not twice', async () => {
    // The disabling rule and the built-in it names are the same row in the UI, and a list that
    // showed both would offer two switches for one sender.
    const { a } = await boot();
    await a.request({
      method: 'PUT',
      url: '/api/v1/mail-filters/job-senders',
      payload: { pattern: 'hit-reply@linkedin.com', enabled: false },
    });

    const list = await senders(a);

    expect(list.filter((s) => s.pattern === 'hit-reply@linkedin.com')).toHaveLength(1);
  });
});
