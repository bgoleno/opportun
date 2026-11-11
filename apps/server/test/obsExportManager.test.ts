// The export manager (design.md 14.3, 14.8, 14.10; https://github.com/bgoleno/opportun/issues/342).
// It builds one exporter per signal the destination's type sends, attaches them to the slots in
// obs/index.ts while Collect and Export are both on, and sends every batch through the one
// allowlist, the destination check and the pinned sender. Checked here against local listeners:
// the shared-helper criterion over all three signals, each type's endpoint and credential header,
// the switches, drop forwarding, OTEL_* variables having no effect, and a refused destination
// sending nothing.
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { obsMetricPoints } from '../src/db/schema';
import { encryptSecret } from '../src/lib/secretBox';
import { MINUTE_MS } from '../src/obs/metrics';
import {
  attachedExporters,
  flushNow,
  obs,
  setCollecting,
  type GatedLogRecord,
  type GatedSpan,
} from '../src/obs';
import type { Destination } from '../src/obs/export/destination';
import {
  applyExport,
  buildExporters,
  EXPORT_BUFFER_MAX,
  exportStatus,
  flushExport,
  stopExport,
} from '../src/obs/export/manager';
import { writeExport } from '../src/obs/export/settings';
import { useApi } from './api';

const boot = useApi();

interface Captured {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

const servers: Server[] = [];
afterEach(async () => {
  await stopExport();
  await setCollecting(false);
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function receiver(status = 200): Promise<{ port: number; got: Captured[] }> {
  const got: Captured[] = [];
  const s = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      got.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      res.writeHead(status).end();
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { port: (s.address() as AddressInfo).port, got };
}

const USER = '01a1c881-cef3-7b31-86a2-501450372158';
const LEAK = { 'secret.key': 'leak-value-9f2' };
const opts = { allowPrivate: true, metricIntervalMs: 60_000, batchIntervalMs: 60_000 };

const span: GatedSpan = {
  traceId: '0af7651916cd43dd8448eb211c80319c',
  spanId: 'b7ad6b7169203331',
  parentSpanId: null,
  name: 'GET',
  kind: 'client',
  startMs: Date.now(),
  durationMs: 3,
  status: 'ok',
  attributes: { 'http.request.method': 'GET', ...LEAK } as GatedSpan['attributes'],
};
const logRecord: GatedLogRecord = {
  event: 'error',
  timeMs: Date.now(),
  traceId: span.traceId,
  fields: { 'error.type': 'TypeError', 'user.id': USER, ...LEAK } as GatedLogRecord['fields'],
};

function otlp(port: number, over: Partial<Destination> = {}): Destination {
  return { type: 'otlp', scheme: 'http', host: '127.0.0.1', port, ...over };
}

describe('the shared export helper criterion (#342)', () => {
  it('a metric, a span and a log record, each with a key the catalog does not list: removed from all three', async () => {
    await boot();
    const { port, got } = await receiver();
    const ex = await buildExporters(otlp(port), undefined, opts);
    ex.sinks.metrics?.record('http.server.request.duration', 0.1, {
      'http.route': '/api/v1/x',
      ...LEAK,
    } as never);
    ex.sinks.spans?.export(span);
    ex.sinks.logs?.emit(logRecord);
    await ex.flush();
    await ex.shutdown();
    const byPath = new Map(got.map((g) => [g.url, g.body.toString('latin1')]));
    expect([...byPath.keys()].sort()).toEqual(['/v1/logs', '/v1/metrics', '/v1/traces']);
    expect(byPath.get('/v1/metrics')).toContain('http.route');
    expect(byPath.get('/v1/traces')).toContain('http.request.method');
    expect(byPath.get('/v1/logs')).toContain('error.type');
    for (const [path, body] of byPath) {
      expect(body, path).not.toContain('secret.key');
      expect(body, path).not.toContain('leak-value-9f2');
      // Export identifies no user (14.8).
      expect(body, path).not.toContain(USER);
      expect(body, path).not.toContain('user.id');
    }
  });
});

describe('each type: its endpoints and its credential header (14.10)', () => {
  it('OTLP: protobuf to /v1/* under the base path, the credential in the header it names', async () => {
    await boot();
    const { port, got } = await receiver();
    const ex = await buildExporters(
      otlp(port, { basePath: '/otlp', headerName: 'X-Api-Key' }),
      'k1',
      opts,
    );
    ex.sinks.spans?.export(span);
    await ex.flush();
    await ex.shutdown();
    expect(got.map((g) => g.url)).toEqual(['/otlp/v1/traces']);
    expect(got[0]?.headers['x-api-key']).toBe('k1');
    expect(got[0]?.headers['content-type']).toBe('application/x-protobuf');
    expect(got[0]?.headers.authorization).toBeUndefined();
  });

  it("Datadog: the Agent's three OTLP paths, no credential", async () => {
    await boot();
    const { port, got } = await receiver();
    const ex = await buildExporters({ ...otlp(port), type: 'datadog' }, undefined, opts);
    expect(Object.keys(ex.sinks).sort()).toEqual(['logs', 'metrics', 'spans']);
    ex.sinks.logs?.emit(logRecord);
    await ex.flush();
    await ex.shutdown();
    expect(got.map((g) => g.url)).toEqual(['/v1/logs']);
  });

  it('Prometheus: metrics only, to its OTLP receiver, the credential as the Authorization value', async () => {
    await boot();
    const { port, got } = await receiver();
    const ex = await buildExporters({ ...otlp(port), type: 'prometheus' }, 'Bearer p1', opts);
    expect(Object.keys(ex.sinks)).toEqual(['metrics']);
    ex.sinks.metrics?.record('opportun.obs.dropped', 1, {
      'opportun.obs.signal': 'spans',
      'opportun.obs.reason': 'buffer_full',
    });
    await ex.flush();
    await ex.shutdown();
    expect(got.map((g) => g.url)).toEqual(['/api/v1/otlp/v1/metrics']);
    expect(got[0]?.headers.authorization).toBe('Bearer p1');
  });

  it('InfluxDB: line protocol to /api/v2/write, the token as Token', async () => {
    await boot();
    const { port, got } = await receiver(204);
    const ex = await buildExporters(
      { ...otlp(port), type: 'influxdb', org: 'home', bucket: 'opportun' },
      'tok',
      opts,
    );
    expect(Object.keys(ex.sinks)).toEqual(['metrics']);
    ex.sinks.metrics?.record('http.server.request.duration', 0.2, { 'http.route': '/x' });
    await ex.flush();
    await ex.shutdown();
    expect(got.map((g) => g.url)).toEqual(['/api/v2/write?org=home&bucket=opportun&precision=ms']);
    expect(got[0]?.headers.authorization).toBe('Token tok');
    expect(got[0]?.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(got[0]?.body.toString()).toMatch(
      /^http\.server\.request\.duration,http\.route=\/x count=1i,/,
    );
  });
});

describe('the destination is checked before every batch (14.10 rules 2 to 4)', () => {
  it('a private destination without OPPORTUN_TELEMETRY_ALLOW_PRIVATE sends nothing, and says blocked', async () => {
    await boot();
    const { port, got } = await receiver();
    const ex = await buildExporters(otlp(port), undefined, { ...opts, allowPrivate: false });
    ex.sinks.spans?.export(span);
    await ex.flush();
    await ex.shutdown();
    expect(got).toEqual([]);
    expect(exportStatus().lastFailure?.outcome).toBe('blocked');
  });

  it('a refusal by the destination is reported as its class, and a success clears nothing else', async () => {
    await boot();
    const failing = await receiver(503);
    const ex = await buildExporters(otlp(failing.port), undefined, opts);
    ex.sinks.spans?.export(span);
    await ex.flush();
    await ex.shutdown();
    expect(exportStatus().lastFailure?.outcome).toBe('http_5xx');
    const ok = await receiver();
    const ex2 = await buildExporters(otlp(ok.port), undefined, opts);
    ex2.sinks.spans?.export(span);
    await ex2.flush();
    await ex2.shutdown();
    expect(exportStatus().lastSuccessAt).toBeGreaterThan(0);
    expect(exportStatus().lastFailure?.outcome).toBe('http_5xx');
  });
});

const CHILD = fileURLToPath(new URL('./fixtures/exportEnvChild.ts', import.meta.url));

function runChild(
  port: number,
  env: Record<string, string>,
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CHILD, String(port)], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (out += c));
    child.stderr.resume();
    child.once('close', (code) => resolve({ code, out }));
  });
}

describe('no OTEL_* variable changes anything (14.8)', () => {
  const VARS = {
    OTEL_EXPORTER_OTLP_ENDPOINT: '',
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '',
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: '',
    OTEL_EXPORTER_OTLP_HEADERS: 'x-leak=env-header',
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'x-leak2=env-header',
    OTEL_SERVICE_NAME: 'env-service-name',
    OTEL_RESOURCE_ATTRIBUTES: 'host.name=env-host,deployment.environment=env-deploy',
    OTEL_METRIC_EXPORT_INTERVAL: '1',
    OTEL_BSP_SCHEDULE_DELAY: '1',
    OTEL_TRACES_SAMPLER: 'always_off',
    OTEL_SDK_DISABLED: 'true',
    OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT: '1',
  };

  it('a captured batch goes to the configured address with only the configured header', async () => {
    await boot();
    const wrong = await receiver();
    const { port, got } = await receiver();
    const set = { ...VARS };
    set.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${wrong.port}`;
    set.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = `http://127.0.0.1:${wrong.port}/v1/traces`;
    set.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = `http://127.0.0.1:${wrong.port}/v1/metrics`;
    // In a child process with the variables in its own environment: set before any
    // OpenTelemetry package loads, and never in this runner's process.env (issue #292).
    const { code, out } = await runChild(port, set);
    expect({ code, out }).toEqual({ code: 0, out: 'done env-service-name\n' });
    expect(wrong.got).toEqual([]);
    expect(got.map((g) => g.url).sort()).toEqual(['/v1/metrics', '/v1/traces']);
    for (const g of got) {
      expect(Object.keys(g.headers).sort()).toEqual([
        'accept-encoding',
        'connection',
        'content-length',
        'content-type',
        'host',
        'user-agent',
        'x-api-key',
      ]);
      const body = g.body.toString('latin1');
      expect(body).not.toContain('env-');
      expect(body).not.toContain('host.name');
      expect(body).toContain('service.instance.id');
    }
    // The span was exported whole: no limit or sampler from the environment applied.
    expect(got.find((g) => g.url === '/v1/traces')?.body.toString('latin1')).toContain(
      'http.request.method',
    );
  });
});

describe('applyExport: the switches (14.1, 14.10)', () => {
  async function stored(app: Awaited<ReturnType<typeof boot>>['app'], d: Destination) {
    await writeExport(app.db, { enabled: true, destination: d, sealedCredential: null });
  }
  const deployment = { demo: false, telemetryAllowPrivate: true };

  it('on while Collect and Export are both on: the type’s signals attached; else none', async () => {
    const { app } = await boot();
    const { port } = await receiver();
    await stored(app, otlp(port));
    await applyExport(app.db, deployment, opts);
    expect(attachedExporters()).toEqual([]); // Collect is off
    await setCollecting(true);
    await applyExport(app.db, deployment, opts);
    expect(attachedExporters()).toEqual(['metrics', 'spans', 'logs']);
    // Another type rebuilds it without a restart.
    await stored(app, { ...otlp(port), type: 'prometheus' });
    await applyExport(app.db, deployment, opts);
    expect(attachedExporters()).toEqual(['metrics']);
    // Turned off: detached.
    await writeExport(app.db, { enabled: false, destination: otlp(port), sealedCredential: null });
    await applyExport(app.db, deployment, opts);
    expect(attachedExporters()).toEqual([]);
  });

  it('never on the demo deployment (rule 6)', async () => {
    const { app } = await boot();
    const { port } = await receiver();
    await stored(app, otlp(port));
    await setCollecting(true);
    await applyExport(app.db, { ...deployment, demo: true }, opts);
    expect(attachedExporters()).toEqual([]);
  });

  it('the stored credential is unsealed for the header', async () => {
    const { app } = await boot();
    const { port, got } = await receiver();
    await writeExport(app.db, {
      enabled: true,
      destination: otlp(port, { headerName: 'x-api-key' }),
      sealedCredential: encryptSecret(app.db, 'stored-k'),
    });
    await setCollecting(true);
    await applyExport(app.db, deployment, opts);
    obs.record('http.server.request.duration', 0.1, { 'http.route': '/x' });
    await flushExport();
    expect(got[0]?.headers['x-api-key']).toBe('stored-k');
  });

  it('drop counts reach the exporter: opportun.obs.dropped is exported (tl on #359)', async () => {
    const { app } = await boot();
    const { port, got } = await receiver();
    await stored(app, otlp(port));
    await setCollecting(true);
    await applyExport(app.db, deployment, opts);
    // A non-finite value is dropped and counted by obs.record itself, before any sink.
    obs.record('http.server.request.duration', Number.NaN, { 'http.route': '/x' });
    await flushNow();
    await flushExport();
    const metrics = got.find((g) => g.url === '/v1/metrics')?.body.toString('latin1') ?? '';
    expect(metrics).toContain('opportun.obs.dropped');
    expect(metrics).toContain('invalid_value');
  });
});

describe('the Gen AI token and cost metrics are exported (criterion 3; FR-T4 part 2 records them)', () => {
  it('by task, feature, provider and model, as input and output counters and a cost, with no user', async () => {
    const { app, a } = await boot();
    const { port, got } = await receiver();
    await writeExport(app.db, { enabled: true, destination: otlp(port), sealedCredential: null });
    await setCollecting(true);
    await applyExport(app.db, { demo: false, telemetryAllowPrivate: true }, opts);
    const call = (model: string) => ({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'anthropic',
      'opportun.ai.provider': 'anthropic',
      'gen_ai.request.model': model,
      'opportun.ai.task': 'resume.tailor',
      'opportun.ai.feature': 'resume_tailoring',
    });
    const text = { 'gen_ai.token.modality': 'text' };
    // A user's metrics (14.4 scope user): recorded for the user, exported without them.
    const forUser = { userId: a.userId };
    obs.record(
      'gen_ai.client.inference.usage.input_tokens',
      1200,
      { ...call('claude-sonnet-5-5'), ...text },
      forUser,
    );
    obs.record(
      'gen_ai.client.inference.usage.output_tokens',
      300,
      { ...call('claude-sonnet-5-5'), ...text },
      forUser,
    );
    obs.record(
      'opportun.gen_ai.usage.cost',
      0.0081,
      { ...call('claude-sonnet-5-5'), 'opportun.ai.cost.estimated': false },
      forUser,
    );
    // A model the price table does not list leaves as _OTHER (14.8).
    obs.record(
      'gen_ai.client.inference.usage.input_tokens',
      50,
      { ...call('my-private-finetune'), ...text },
      forUser,
    );
    await flushExport();
    const body = got.find((g) => g.url === '/v1/metrics')?.body.toString('latin1') ?? '';
    for (const name of [
      'gen_ai.client.inference.usage.input_tokens',
      'gen_ai.client.inference.usage.output_tokens',
      'opportun.gen_ai.usage.cost',
      'opportun.ai.task',
      'resume.tailor',
      'opportun.ai.feature',
      'gen_ai.provider.name',
      'claude-sonnet-5-5',
      '_OTHER',
    ]) {
      expect(body, name).toContain(name);
    }
    expect(body).not.toContain('my-private-finetune');
    expect(body).not.toContain(a.userId);
    expect(body).not.toContain('user.id');
  });
});

describe('the batches (14.10, 14.11)', () => {
  it('queues at most 2,048 spans; the next is dropped and counted as buffer_full', async () => {
    const { app } = await boot();
    const { port } = await receiver();
    await setCollecting(true);
    expect(EXPORT_BUFFER_MAX).toBe(2_048);
    const ex = await buildExporters(otlp(port), undefined, opts);
    // A span with catalogued keys only, so the one drop counted is the buffer's.
    const clean: GatedSpan = { ...span, attributes: { 'http.request.method': 'GET' } };
    for (let i = 0; i <= EXPORT_BUFFER_MAX; i += 1) ex.sinks.spans?.export(clean);
    await flushNow();
    const drops = await app.db
      .select()
      .from(obsMetricPoints)
      .where(eq(obsMetricPoints.metric, 'opportun.obs.dropped'))
      .all();
    expect(
      drops
        .filter((d) => d.resolution === MINUTE_MS)
        .map((d) => ({ ...d.attributes, count: d.count })),
    ).toEqual([{ 'opportun.obs.signal': 'spans', 'opportun.obs.reason': 'buffer_full', count: 1 }]);
    await ex.shutdown();
  });

  it('checks the name again for every batch: re-pointed to a refused address, the next batch is not sent', async () => {
    await boot();
    const { port, got } = await receiver();
    let answer = '127.0.0.1';
    const ex = await buildExporters({ ...otlp(port), host: 'collector.test' }, undefined, {
      ...opts,
      lookup: async () => [answer],
    });
    ex.sinks.spans?.export(span);
    await ex.flush();
    expect(got.map((g) => g.url)).toEqual(['/v1/traces']);
    expect(got[0]?.headers.host).toBe(`collector.test:${port}`);
    answer = '169.254.169.254';
    ex.sinks.spans?.export(span);
    await ex.flush();
    await ex.shutdown();
    expect(got).toHaveLength(1);
    expect(exportStatus().lastFailure?.outcome).toBe('blocked');
  });
});

describe("stopping export stops what is in flight (sec's Blocking 2 on #377)", () => {
  it('a send held open by the destination is destroyed when export stops, and nothing starts after', async () => {
    await boot();
    const started: IncomingMessage[] = [];
    const closed: string[] = [];
    const s = createServer((req) => {
      // Accepts the request and never answers.
      started.push(req);
      req.socket.once('close', () => closed.push(req.url ?? ''));
    });
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    const port = (s.address() as AddressInfo).port;
    const ex = await buildExporters(otlp(port), undefined, opts);
    ex.sinks.spans?.export(span);
    const flushing = ex.flush();
    for (let i = 0; i < 100 && started.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(started).toHaveLength(1);
    const stoppedAt = Date.now();
    await ex.shutdown();
    await flushing;
    for (let i = 0; i < 100 && closed.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(closed).toEqual(['/v1/traces']);
    expect(Date.now() - stoppedAt).toBeLessThan(2_000);
    ex.sinks.spans?.export(span);
    await ex.flush();
    expect(started).toHaveLength(1);
  });

  it('a batch still in its address check when export stops never connects', async () => {
    await boot();
    const { port, got } = await receiver();
    let answer: (addresses: string[]) => void = () => undefined;
    const ex = await buildExporters({ ...otlp(port), host: 'collector.test' }, undefined, {
      ...opts,
      lookup: () =>
        new Promise<string[]>((resolve) => {
          answer = resolve;
        }),
    });
    ex.sinks.spans?.export(span);
    const flushing = ex.flush();
    await new Promise((r) => setTimeout(r, 20));
    await ex.shutdown();
    answer(['127.0.0.1']);
    await flushing;
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toEqual([]);
  });
});

describe('log records reach the export slot through the log gate (#376 merged; tl on #377)', () => {
  it('obs.event is gated, then exported as a log record with no user', async () => {
    const { app, a } = await boot();
    const { port, got } = await receiver();
    await writeExport(app.db, { enabled: true, destination: otlp(port), sealedCredential: null });
    await setCollecting(true);
    await applyExport(app.db, { demo: false, telemetryAllowPrivate: true }, opts);
    obs.event(
      'error',
      { 'error.type': 'TypeError', 'http.route': '/api/v1/opportunities/:id' },
      { userId: a.userId },
    );
    await flushExport();
    const logs = got.find((g) => g.url === '/v1/logs')?.body.toString('latin1') ?? '';
    expect(logs).toContain('error.type');
    expect(logs).toContain('TypeError');
    expect(logs).toContain('/api/v1/opportunities/:id');
    expect(logs).not.toContain(a.userId);
    expect(logs).not.toContain('user.id');
  });
});
