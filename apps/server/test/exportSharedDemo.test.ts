// The export of a shared demo account: the people who sign in to it are different visitors, so its
// audit rows' request addresses are other people's. The export leaves every address out there. A
// dedicated account on a demo server, and any account elsewhere, exports them as before.
import type { FastifyInstance } from 'fastify';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { DEMO_USERS } from '../src/lib/demo/fixture';
import { useApi } from './api';
import { PASSWORD, sharedDemoUser } from './isolation';
import { queryAll } from './db';

const boot = useApi();

const VISITOR_A = '192.0.2.10';
const VISITOR_B = '198.51.100.20';
const SHARED_EMAIL = DEMO_USERS[1]!.email;
const DEDICATED_EMAIL = 'isolation-a@example.com';

/** A browser session from one address: every request it makes comes from there. */
async function sessionFrom(app: FastifyInstance, email: string, remoteAddress: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
    remoteAddress,
  });
  expect(res.statusCode, res.body).toBe(200);
  const cookie = (name: string) => res.cookies.find((c) => c.name === name)!.value;
  const session = cookie('opportun_session');
  const csrf = cookie('opportun_csrf');
  return (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
    app.inject({
      method,
      url,
      remoteAddress,
      ...(payload === undefined ? {} : { payload }),
      cookies: { opportun_session: session, opportun_csrf: csrf },
      headers: { 'x-csrf-token': csrf },
    });
}

/** The export as `request` downloads it: every file in the zip, as text. */
async function exportOf(request: Awaited<ReturnType<typeof sessionFrom>>) {
  const res = await request('GET', '/api/v1/export');
  expect(res.statusCode).toBe(200);
  const files = unzipSync(new Uint8Array(res.rawPayload));
  const text = Object.fromEntries(Object.entries(files).map(([n, b]) => [n, strFromU8(b)]));
  const json = JSON.parse(text['export.json']!) as {
    tables: { audit_log: { ip: string | null; event: string }[] };
  };
  return { text, auditLog: json.tables.audit_log };
}

/** Visitor A signs in and does an audited action; then visitor B exports. */
async function twoVisitors(app: FastifyInstance, email: string) {
  const a = await sessionFrom(app, email, VISITOR_A);
  // A second audited action of A's: a reauthenticated credential change, refused or not.
  await a('POST', '/api/v1/device-tokens', {
    name: 'laptop',
    scopes: ['mail:push'],
    password: PASSWORD,
  });
  const b = await sessionFrom(app, email, VISITOR_B);
  return await exportOf(b);
}

/** The addresses the audit trail holds for `userId`, as stored. */
async function storedAddresses(app: FastifyInstance, userId: string): Promise<string[]> {
  const rows = (await queryAll(app, 'SELECT ip FROM audit_log WHERE user_id = ?', userId)) as {
    ip: string | null;
  }[];
  return rows.flatMap((r) => (r.ip === null ? [] : [r.ip]));
}

const anyFileHas = (text: Record<string, string>, needle: string) =>
  Object.values(text).some((t) => t.includes(needle));

describe('the export of a shared demo account', () => {
  it("holds no visitor's request address, another visitor's or the exporter's own", async () => {
    const { app } = await boot({ demo: true });
    const shared = await sharedDemoUser(app, 1);
    const { text, auditLog } = await twoVisitors(app, SHARED_EMAIL);
    // The trail itself still records them: only the export leaves them out.
    expect(await storedAddresses(app, shared.userId)).toEqual(
      expect.arrayContaining([VISITOR_A, VISITOR_B]),
    );
    expect(auditLog.length).toBeGreaterThan(0);
    expect(auditLog.every((row) => row.ip === null)).toBe(true);
    expect(anyFileHas(text, VISITOR_A)).toBe(false);
    expect(anyFileHas(text, VISITOR_B)).toBe(false);
  });
});

describe('the export of every other account, unchanged', () => {
  it('a dedicated account on a demo server keeps its audit addresses', async () => {
    const { app } = await boot({ demo: true });
    const { auditLog } = await twoVisitors(app, DEDICATED_EMAIL);
    const ips = auditLog.map((row) => row.ip);
    expect(ips).toContain(VISITOR_A);
    expect(ips).toContain(VISITOR_B);
  });

  it('an account on an instance that is not a demo keeps its audit addresses', async () => {
    const { app } = await boot();
    const { auditLog } = await twoVisitors(app, DEDICATED_EMAIL);
    const ips = auditLog.map((row) => row.ip);
    expect(ips).toContain(VISITOR_A);
    expect(ips).toContain(VISITOR_B);
  });
});
