// The export settings routes (design.md 14.1, 14.10 rules 1, 5, 6 and 7;
// https://github.com/bgoleno/opportun/issues/342 criteria 2, 5 and 6):
// - GET /api/v1/obs/export: every signed-in user sees whether export is on, its type and its
//   signals, never where to; an admin also sees the destination's fields, whether a credential is
//   stored (never the credential), the last success, the last failure as a class, and the drops.
// - PUT /api/v1/obs/export: an admin only, with their password confirmed again; refused on the
//   demo; on only while Collect is; the destination checked against the rule; audited with the
//   type and signals only; applied at once.
// - POST /api/v1/obs/export/test: one request, its outcome class only, under the same
//   re-confirmation and its rate limit.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { auditLog } from '../src/db/schema';
import { attachedExporters, isCollecting, setCollecting } from '../src/obs';
import { stopExport } from '../src/obs/export/manager';
import { readExport, writeExport } from '../src/obs/export/settings';
import { useApi } from './api';
import type { TestClient } from './isolation';

const boot = useApi();
const PASSWORD = 'correct horse battery';
const SECRET = 'tok-7d1e0f3a9b';

const servers: Server[] = [];
afterEach(async () => {
  await stopExport();
  await setCollecting(false);
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function receiver(): Promise<{ port: number; hits: string[] }> {
  const hits: string[] = [];
  const s = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      hits.push(req.url ?? '');
      res.writeHead(200).end();
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { port: (s.address() as AddressInfo).port, hits };
}

const local = (port: number) => ({
  type: 'otlp',
  scheme: 'http',
  host: '127.0.0.1',
  port,
  headerName: 'x-api-key',
});

function putExport(c: TestClient, payload: Record<string, unknown>) {
  return c.request({ method: 'PUT', url: '/api/v1/obs/export', payload });
}
async function collectOn(c: TestClient) {
  const r = await c.request({
    method: 'PUT',
    url: '/api/v1/obs/settings',
    payload: { collect: true },
  });
  expect(r.statusCode).toBe(200);
}

describe('GET /api/v1/obs/export', () => {
  it('off by default; everyone signed in sees it; an admin also sees the details', async () => {
    const { app, a, b } = await boot();
    const user = await b.request({ method: 'GET', url: '/api/v1/obs/export' });
    expect(user.statusCode).toBe(200);
    expect(user.json()).toEqual({ available: true, enabled: false, type: null, signals: [] });
    const admin = await a.request({ method: 'GET', url: '/api/v1/obs/export' });
    expect(admin.json()).toEqual({
      available: true,
      enabled: false,
      type: null,
      signals: [],
      admin: {
        destination: null,
        hasCredential: false,
        allowPrivate: false,
        lastSuccessAt: null,
        lastFailure: null,
        dropped: [],
      },
    });
    expect((await app.inject({ method: 'GET', url: '/api/v1/obs/export' })).statusCode).toBe(401);
  });
});

describe('PUT /api/v1/obs/export', () => {
  it('an admin turns it on with their password: applied at once, audited without host or credential', async () => {
    const { app, a, b } = await boot({ telemetryAllowPrivate: true });
    const { port } = await receiver();
    await collectOn(a);
    const r = await putExport(a, {
      password: PASSWORD,
      enabled: true,
      destination: local(port),
      credential: SECRET,
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.stringify(r.json())).not.toContain(SECRET);
    expect(attachedExporters()).toEqual(['metrics', 'spans', 'logs']);
    // Every user sees that it is on, its type and its signals; not where to.
    const seen = await b.request({ method: 'GET', url: '/api/v1/obs/export' });
    expect(seen.json()).toEqual({
      available: true,
      enabled: true,
      type: 'otlp',
      signals: ['metrics', 'spans', 'logs'],
    });
    // The admin sees the fields and that a credential is stored, never the credential.
    const admin = (await a.request({ method: 'GET', url: '/api/v1/obs/export' })).json() as {
      admin: { destination: unknown; hasCredential: boolean };
    };
    expect(admin.admin.destination).toEqual(local(port));
    expect(admin.admin.hasCredential).toBe(true);
    expect(JSON.stringify(admin)).not.toContain(SECRET);
    const audits = await app.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.event, 'telemetry.export.updated'))
      .all();
    expect(audits.map((x) => x.detail)).toEqual([
      { enabled: true, type: 'otlp', signals: ['metrics', 'spans', 'logs'] },
    ]);
    expect(audits[0]?.userId).toBe(a.userId);
    // The detail is where a host or a credential would go (the row's ip is the caller's).
    const details = JSON.stringify(audits.map((x) => x.detail));
    expect(details).not.toContain('127.0.0.1');
    expect(details).not.toContain(String(port));
    expect(JSON.stringify(audits)).not.toContain(SECRET);
  });

  it('refused to a non-admin, and to a wrong password, with nothing stored', async () => {
    const { app, a, b } = await boot({ telemetryAllowPrivate: true });
    await collectOn(a);
    const payload = { password: PASSWORD, enabled: true, destination: local(4318) };
    const notAdmin = await putExport(b, payload);
    expect(notAdmin.statusCode).toBe(403);
    expect(notAdmin.json()).toEqual({ error: { code: 'forbidden' } });
    const wrong = await putExport(a, { ...payload, password: 'not-it' });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json()).toEqual({ error: { code: 'invalid_password' } });
    expect((await readExport(app.db)).enabled).toBe(false);
    expect(attachedExporters()).toEqual([]);
  });

  it('on only while Collect is on', async () => {
    const { a } = await boot({ telemetryAllowPrivate: true });
    const r = await putExport(a, { password: PASSWORD, enabled: true, destination: local(4318) });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: { code: 'collect_off' } });
  });

  it.each([
    ['a private address without the flag', false, local(4318), 'private_not_allowed'],
    [
      'link-local, even with the flag',
      true,
      { ...local(80), host: '169.254.169.254' },
      'refused_address',
    ],
    [
      'plain http to a public address',
      true,
      { ...local(80), host: '8.8.8.8' },
      'plain_http_public',
    ],
  ])('the destination rule: %s is refused', async (_what, allowPrivate, destination, reason) => {
    const { app, a } = await boot({ telemetryAllowPrivate: allowPrivate });
    await collectOn(a);
    const r = await putExport(a, { password: PASSWORD, enabled: true, destination });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toEqual({ error: { code: 'destination_refused', reason } });
    expect((await readExport(app.db)).enabled).toBe(false);
  });

  it('an IPv6 literal with a zone id is refused by field, not a server error (tl on #377)', async () => {
    const { a } = await boot({ telemetryAllowPrivate: true });
    await collectOn(a);
    const r = await putExport(a, {
      password: PASSWORD,
      enabled: true,
      destination: { ...local(4318), host: '[fe80::1%en0]' },
    });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toEqual({ error: { code: 'invalid_destination', field: 'host' } });
  });

  it('a malformed destination is refused by field', async () => {
    const { a } = await boot({ telemetryAllowPrivate: true });
    await collectOn(a);
    const r = await putExport(a, {
      password: PASSWORD,
      enabled: false,
      destination: { ...local(4318), host: 'evil.example.com/path' },
    });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toEqual({ error: { code: 'invalid_destination', field: 'host' } });
  });

  it('turning Collect off turns Export off, stored and in this process (14.1)', async () => {
    const { app, a } = await boot({ telemetryAllowPrivate: true });
    const { port } = await receiver();
    await collectOn(a);
    expect(
      (await putExport(a, { password: PASSWORD, enabled: true, destination: local(port) }))
        .statusCode,
    ).toBe(200);
    const off = await a.request({
      method: 'PUT',
      url: '/api/v1/obs/settings',
      payload: { collect: false },
    });
    expect(off.statusCode).toBe(200);
    expect(isCollecting()).toBe(false);
    expect(attachedExporters()).toEqual([]);
    const stored = await readExport(app.db);
    expect(stored.enabled).toBe(false);
    expect(stored.destination).toEqual(local(port));
    // Collect back on does not bring Export back by itself.
    await collectOn(a);
    expect(attachedExporters()).toEqual([]);
  });

  it('off without a restart, and nothing more is sent', async () => {
    const { a } = await boot({ telemetryAllowPrivate: true });
    const { port } = await receiver();
    await collectOn(a);
    await putExport(a, { password: PASSWORD, enabled: true, destination: local(port) });
    const r = await putExport(a, { password: PASSWORD, enabled: false });
    expect(r.statusCode).toBe(200);
    expect(attachedExporters()).toEqual([]);
  });
});

describe('the demo deployment (14.10 rule 6)', () => {
  it('refuses the PUT and the test to every caller; the GET reads off', async () => {
    const { a, b } = await boot({ demo: true, telemetryAllowPrivate: true });
    for (const c of [a, b]) {
      const put = await putExport(c, { password: PASSWORD, enabled: false });
      expect(put.statusCode).toBe(403);
      expect(put.json()).toEqual({ error: { code: 'unavailable_on_demo' } });
      const test = await c.request({
        method: 'POST',
        url: '/api/v1/obs/export/test',
        payload: { password: PASSWORD },
      });
      expect(test.statusCode).toBe(403);
      expect(test.json()).toEqual({ error: { code: 'unavailable_on_demo' } });
    }
    // Unavailable, not off: no admin can turn it on there (as the dashboards say, #364).
    expect((await b.request({ method: 'GET', url: '/api/v1/obs/export' })).json()).toEqual({
      available: false,
      enabled: false,
      type: null,
      signals: [],
    });
  });
});

describe('POST /api/v1/obs/export/test (14.10 rule 7)', () => {
  it('one request to the stored destination, its outcome class only', async () => {
    const { a } = await boot({ telemetryAllowPrivate: true });
    const { port, hits } = await receiver();
    await putExport(a, { password: PASSWORD, enabled: false, destination: local(port) });
    const r = await a.request({
      method: 'POST',
      url: '/api/v1/obs/export/test',
      payload: { password: PASSWORD },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ outcome: 'ok' });
    expect(hits).toEqual(['/v1/metrics']);
  });

  it('no destination yet; a non-admin; a wrong password', async () => {
    const { a, b } = await boot({ telemetryAllowPrivate: true });
    const none = await a.request({
      method: 'POST',
      url: '/api/v1/obs/export/test',
      payload: { password: PASSWORD },
    });
    expect(none.json()).toEqual({ outcome: 'no_destination' });
    const user = await b.request({
      method: 'POST',
      url: '/api/v1/obs/export/test',
      payload: { password: PASSWORD },
    });
    expect(user.statusCode).toBe(403);
    const wrong = await a.request({
      method: 'POST',
      url: '/api/v1/obs/export/test',
      payload: { password: 'nope' },
    });
    expect(wrong.statusCode).toBe(403);
  });

  it('rate-limited with the re-confirmation: the eleventh try in the window is refused', async () => {
    const { a } = await boot({ telemetryAllowPrivate: true });
    const codes: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      const r = await a.request({
        method: 'POST',
        url: '/api/v1/obs/export/test',
        payload: { password: PASSWORD },
      });
      codes.push(r.statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});

describe('what pins the guards of the export routes (sec on #377)', () => {
  it('Send a test checks the stored destination itself: private without the flag is blocked, no request', async () => {
    // Saved while export is off, a destination is stored without the address check, so the
    // test send's own check is its only guard (X32).
    const { app, a } = await boot({ telemetryAllowPrivate: false });
    const { port, hits } = await receiver();
    await writeExport(app.db, {
      enabled: false,
      destination: { type: 'otlp', scheme: 'http', host: '127.0.0.1', port },
      sealedCredential: null,
    });
    const r = await a.request({
      method: 'POST',
      url: '/api/v1/obs/export/test',
      payload: { password: PASSWORD },
    });
    expect(r.json()).toEqual({ outcome: 'blocked' });
    expect(hits).toEqual([]);
  });

  it('a wrong password on Send a test makes no request (X22b)', async () => {
    const { a } = await boot({ telemetryAllowPrivate: true });
    const { port, hits } = await receiver();
    await putExport(a, { password: PASSWORD, enabled: false, destination: local(port) });
    const r = await a.request({
      method: 'POST',
      url: '/api/v1/obs/export/test',
      payload: { password: 'not-it' },
    });
    expect(r.statusCode).toBe(403);
    // The 403 is sent by confirmPassword itself, so the response alone cannot show that the
    // handler stopped there: give a send that should not happen the time to arrive.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(hits).toEqual([]);
  });

  it('the PUT is rate-limited with the re-confirmation: the eleventh in the window is refused (X20)', async () => {
    const { a } = await boot({ telemetryAllowPrivate: true });
    const codes: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      codes.push((await putExport(a, { password: PASSWORD, enabled: false })).statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});
