// A separate process for obsExportManager.test.ts's OTEL_* check (design.md 14.8;
// https://github.com/bgoleno/opportun/issues/342). The parent starts it with OTEL_* variables in
// its own environment, so they are set before any OpenTelemetry package loads, and without
// touching the test runner's process.env (issue #292). It builds the exporters for an OTLP
// destination at the port given, exports one span and one metric point, flushes, and exits.
import type { GatedSpan } from '../../src/obs';
import { buildExporters } from '../../src/obs/export/manager';

const port = Number(process.argv[2]);
if (!Number.isInteger(port)) throw new Error('usage: exportEnvChild <port>');

const span: GatedSpan = {
  traceId: '0af7651916cd43dd8448eb211c80319c',
  spanId: 'b7ad6b7169203331',
  parentSpanId: null,
  name: 'GET',
  kind: 'client',
  startMs: Date.now(),
  durationMs: 3,
  status: 'ok',
  attributes: { 'http.request.method': 'GET' },
};

const ex = await buildExporters(
  { type: 'otlp', scheme: 'http', host: '127.0.0.1', port, headerName: 'x-api-key' },
  'k',
  { allowPrivate: true, metricIntervalMs: 60_000, batchIntervalMs: 60_000 },
);
ex.sinks.spans?.export(span);
ex.sinks.metrics?.record('http.server.request.duration', 0.1, { 'http.route': '/x' });
await ex.flush();
await ex.shutdown();
// Says which OTEL_SERVICE_NAME it ran under, so the parent knows the variables reached it.
process.stdout.write(`done ${process.env.OTEL_SERVICE_NAME ?? ''}\n`);
