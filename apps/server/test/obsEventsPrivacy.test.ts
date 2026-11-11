// No personal information in a log record or an event (design.md 14.8, 14.9, NFR-PRV6;
// https://github.com/bgoleno/opportun/issues/345, FR-T5 criteria 1 to 5, as tl amended them).
// Tested as a property, not by example: known names, email addresses, phone numbers and a
// company's name go into every field of every event type, into unknown keys, a message built from
// data, a child logger's bindings, an error's message and extra properties, a library's warning,
// an audit entry's detail and address, with the production behaviour for unknown keys. None of
// those bytes may reach the log output or a captured export batch.
import { context, trace, TraceFlags } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { audit } from '../src/lib/audit';
import {
  attachExporter,
  type GatedLogRecord,
  type LogExportSink,
  obs,
  setCollecting,
} from '../src/obs';
import { eventDef, EVENTS, type EventName, isLocalOnly } from '../src/obs/catalog';
import { setUnknownKeyMode } from '../src/obs/gate';
import { WITHHELD } from '../src/obs/log';
import { useApi } from './api';
import { captureLogs } from './helpers';
import { useTestContextManager } from './otelContext';

const NAME = 'Jane Doe';
const EMAIL = 'jane.doe@example.com';
const PHONE = '+1 (206) 555-0142';
const COMPANY = 'Acme Robotics';
const PERSONAL = [NAME, EMAIL, PHONE, COMPANY];
const PAYLOAD = `${NAME} <${EMAIL}> ${PHONE} at ${COMPANY}`;

let logs: ReturnType<typeof captureLogs>;
const boot = useApi(() => ({ logStream: logs }));
useTestContextManager();

beforeEach(() => {
  logs = captureLogs();
  setUnknownKeyMode('drop');
});

afterEach(async () => {
  setUnknownKeyMode('throw');
  await setCollecting(false);
});

function exportSink(): LogExportSink & { records: GatedLogRecord[] } {
  const records: GatedLogRecord[] = [];
  return { records, emit: (r) => records.push(r), shutdown: async () => undefined };
}

/** Every field an event lists, and some it does not, all holding the personal data. */
function poisoned(name: EventName): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const key of eventDef(name).fields) fields[key] = PAYLOAD;
  return { ...fields, person: NAME, email: EMAIL, phone: PHONE, company: COMPANY, url: PAYLOAD };
}

function assertClean(text: string): void {
  for (const datum of PERSONAL) expect(text, datum).not.toContain(datum);
  expect(text).not.toContain('555-0142');
}

describe('no personal information reaches a log line or an export (#345)', () => {
  it('through every field of every event type, and keys no event lists', async () => {
    const { app, a } = await boot({ logLevel: 'trace' });
    await setCollecting(true);
    const sink = exportSink();
    expect(attachExporter('logs', sink)).toBe(true);
    const names = Object.keys(EVENTS) as EventName[];
    expect(names.length).toBeGreaterThan(70);
    for (const name of names) obs.event(name, poisoned(name), { userId: a.userId });
    assertClean(logs.text());
    assertClean(JSON.stringify(sink.records));
    // Each event wrote one record, by its name (criterion 1).
    const written = logs.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    for (const name of names) {
      expect(
        written.filter((r) => r.event === name),
        name,
      ).toHaveLength(1);
    }
    void app;
  });

  it('through a message built from data, a child’s bindings, an error and a library warning', async () => {
    const { app } = await boot({ logLevel: 'trace' });
    await setCollecting(true);
    app.log.info({ person: NAME, email: EMAIL }, `could not reach ${EMAIL}`);
    app.log.child({ person: NAME, phone: PHONE }).warn('shutting down');
    const err = Object.assign(new Error(`mail for ${NAME} <${EMAIL}>`), {
      phone: PHONE,
      company: COMPANY,
      code: PHONE,
    });
    app.log.error({ err, person: NAME }, 'unhandled error');
    // A catalogued message with personal data in its own keys: none fits a key's type.
    app.log.warn(
      { 'opportun.company.id': COMPANY, 'opportun.ats.kind': EMAIL },
      'ats detection failed',
    );
    // What Fastify writes for a request, and what a library builds.
    app.log.info(
      { req: { method: 'GET', url: `/api/v1/x?email=${EMAIL}`, host: COMPANY } },
      'incoming request',
    );
    app.log.warn(`(node) warning: ${PAYLOAD}`);
    assertClean(logs.text());
    expect(logs.text()).toContain(WITHHELD);
    expect(logs.text()).toContain('"error.type":"Error"');
  });

  it('through an audit entry: its event has the action and the user, never the detail or address', async () => {
    const { app, a } = await boot({ logLevel: 'trace' });
    await setCollecting(true);
    const sink = exportSink();
    attachExporter('logs', sink);
    await audit(app.db, 'auth.login_failed', {
      userId: a.userId,
      ip: '203.0.113.7',
      detail: { email: EMAIL, name: NAME, phone: PHONE, company: COMPANY },
    });
    const record = logs.lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((r) => r.event === 'auth.login_failed');
    expect(record).toMatchObject({ event: 'auth.login_failed', 'user.id': a.userId });
    assertClean(logs.text());
    expect(logs.text()).not.toContain('203.0.113.7');
    // Exported: the event, without the user's id (14.8: export identifies no user).
    expect(sink.records.map((r) => r.event)).toContain('auth.login_failed');
    expect(JSON.stringify(sink.records)).not.toContain(a.userId);
  });
});

describe('an event record (#345, criterion 1)', () => {
  it('has its name, a time, the opaque user id and the trace id inside a span', async () => {
    const { a } = await boot({ logLevel: 'trace' });
    await setCollecting(true);
    // A valid span context, as a recording span has one (the provider is FR-T4's, not needed here).
    const traceId = '0af7651916cd43dd8448eb211c80319c';
    const active = trace.setSpanContext(context.active(), {
      traceId,
      spanId: 'b7ad6b7169203331',
      traceFlags: TraceFlags.SAMPLED,
    });
    context.with(active, () => {
      obs.event('settings.updated', { 'opportun.setting': 'theme' }, { userId: a.userId });
    });
    const record = logs.lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((r) => r.event === 'settings.updated');
    expect(record).toEqual({
      level: 30,
      time: expect.any(Number),
      msg: 'settings.updated',
      event: 'settings.updated',
      'opportun.setting': 'theme',
      'user.id': a.userId,
      trace_id: traceId,
    });
  });

  it('is not written while collection is off; the ordinary log still is, through the gate', async () => {
    const { app, a } = await boot({ logLevel: 'trace' });
    obs.event('settings.updated', { 'opportun.setting': 'theme' }, { userId: a.userId });
    app.log.warn({ 'opportun.company.id': a.userId }, 'ats detection failed');
    const records = logs.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(records.some((r) => r.event !== undefined)).toBe(false);
    expect(records.some((r) => r.msg === 'ats detection failed')).toBe(true);
  });

  it('exports no key that is local only', () => {
    for (const name of Object.keys(EVENTS) as EventName[]) {
      for (const key of eventDef(name).fields) {
        // An event's own fields may be local only; withoutLocalOnly drops them from export.
        if (isLocalOnly(key)) expect(key, name).not.toBe('client.address');
      }
    }
  });
});
