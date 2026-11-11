// The InfluxDB writer (design.md 14.10; https://github.com/bgoleno/opportun/issues/342). InfluxDB
// has no OTLP endpoint, and Telegraf's OTLP input speaks gRPC only, so metrics go as line
// protocol to /api/v2/write (InfluxDB 2 and 3, and 1.8 or later), one write per interval, through
// the same sender as every other destination.
//
// One line per data point: the metric's catalogued name as the measurement, its exported
// attributes as tags (sorted, as InfluxDB recommends), a counter's value or a histogram's count,
// sum, min and max as fields, and the point's end time in milliseconds (the URL says
// precision=ms). Every name and value came through the export allowlist, so they are catalogued
// keys and checked values; they are escaped anyway, so no value can start a tag, a field or a
// line.
import type { ResourceMetrics } from '@opentelemetry/sdk-metrics';

/** A measurement name: commas and spaces escaped; newlines removed. */
export function escapeMeasurement(s: string): string {
  return s
    .replace(/[\r\n]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/([, ])/g, '\\$1');
}

/** A tag key, tag value or field key: commas, equals signs and spaces escaped; newlines removed. */
export function escapeKey(s: string): string {
  return s
    .replace(/[\r\n]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/([, =])/g, '\\$1');
}

const ms = (t: readonly [number, number]): number => Math.round(t[0] * 1000 + t[1] / 1e6);

function tagSet(attributes: Readonly<Record<string, unknown>>): string {
  const tags = Object.entries(attributes)
    .filter(([, v]) => v !== undefined && v !== null && String(v) !== '')
    .map(([k, v]) => `${escapeKey(k)}=${escapeKey(Array.isArray(v) ? v.join('|') : String(v))}`)
    .sort();
  return tags.length === 0 ? '' : `,${tags.join(',')}`;
}

/** A float field, or nothing for a value line protocol cannot hold (NaN, infinity). */
function float(name: string, v: number | undefined): string | undefined {
  return v !== undefined && Number.isFinite(v) ? `${name}=${v}` : undefined;
}

interface HistogramValue {
  count: number;
  sum?: number;
  min?: number;
  max?: number;
}

/** The batch as line protocol, one point per line; empty when there is nothing to write. */
export function lineProtocol(batch: ResourceMetrics): string {
  const lines: string[] = [];
  for (const scope of batch.scopeMetrics) {
    for (const metric of scope.metrics) {
      const measurement = escapeMeasurement(metric.descriptor.name);
      for (const point of metric.dataPoints) {
        const value = point.value as number | HistogramValue;
        const fields =
          typeof value === 'number'
            ? [float('value', value)]
            : [
                `count=${Math.trunc(value.count)}i`,
                float('sum', value.sum),
                float('min', value.min),
                float('max', value.max),
              ];
        const set = fields.filter((f): f is string => f !== undefined);
        if (set.length === 0) continue;
        lines.push(
          `${measurement}${tagSet(point.attributes)} ${set.join(',')} ${ms(point.endTime)}`,
        );
      }
    }
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}
