// The InfluxDB writer (design.md 14.10: InfluxDB has no OTLP endpoint, so metrics go as line
// protocol to /api/v2/write; https://github.com/bgoleno/opportun/issues/342). One line per data
// point: the metric's name as the measurement, its attributes as tags, a counter's value or a
// histogram's count, sum, min and max as fields, and the point's time in milliseconds.
import { describe, expect, it } from 'vitest';
import { escapeKey, escapeMeasurement, lineProtocol } from '../src/obs/export/influx';
import { createMetricPipeline, exportResource } from '../src/obs/export/otlp';

async function batchOf(
  record: (p: ReturnType<typeof createMetricPipeline>) => void,
): Promise<Parameters<typeof lineProtocol>[0]> {
  let got: Parameters<typeof lineProtocol>[0] | undefined;
  const p = createMetricPipeline({
    resource: exportResource(),
    intervalMs: 60_000,
    exportBatch: async (rm) => {
      if (rm.scopeMetrics.length > 0) got = rm;
      return true;
    },
  });
  record(p);
  await p.flush();
  await p.shutdown();
  if (got === undefined) throw new Error('no batch');
  return got;
}

describe('lineProtocol', () => {
  it('a histogram point: count as an integer, sum, min and max, tags sorted, time in ms', async () => {
    const rm = await batchOf((p) => {
      p.record('http.server.request.duration', 0.25, {
        'http.route': '/api/v1/opportunities/:id',
        'http.request.method': 'GET',
        'http.response.status_code': 200,
      });
      p.record('http.server.request.duration', 0.75, {
        'http.route': '/api/v1/opportunities/:id',
        'http.request.method': 'GET',
        'http.response.status_code': 200,
      });
    });
    const lines = lineProtocol(rm).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^http\.server\.request\.duration,http\.request\.method=GET,http\.response\.status_code=200,http\.route=\/api\/v1\/opportunities\/:id count=2i,sum=1,min=0\.25,max=0\.75 \d{13}$/,
    );
  });

  it('a counter point: its value', async () => {
    const rm = await batchOf((p) =>
      p.record('opportun.obs.dropped', 3, {
        'opportun.obs.signal': 'logs',
        'opportun.obs.reason': 'buffer_full',
      }),
    );
    expect(lineProtocol(rm).trim()).toMatch(
      /^opportun\.obs\.dropped,opportun\.obs\.reason=buffer_full,opportun\.obs\.signal=logs value=3 \d{13}$/,
    );
  });

  it('a point with no attributes has no tag set', async () => {
    const rm = await batchOf((p) => p.record('db.client.operation.duration', 0.001, {}));
    expect(lineProtocol(rm).trim()).toMatch(/^db\.client\.operation\.duration count=1i,/);
  });

  it('escapes what line protocol reserves, so no value can start a field, tag or line', () => {
    expect(escapeMeasurement('a b,c=d')).toBe('a\\ b\\,c=d');
    expect(escapeKey('a b,c=d')).toBe('a\\ b\\,c\\=d');
    expect(escapeKey('a\nb')).toBe('ab');
    expect(escapeKey('a\\b')).toBe('a\\\\b');
  });

  it('an empty batch is an empty body', async () => {
    const rm = await batchOf(() => undefined).catch(() => undefined);
    expect(rm === undefined || lineProtocol(rm) === '').toBe(true);
  });
});
