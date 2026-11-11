// Number formats shared by the trace list and the trace view (FR-T7).
const usd = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const int = new Intl.NumberFormat();

export const formatUsd = (n: number): string => usd.format(n);
export const formatInt = (n: number): string => int.format(n);

/** A duration as a reader takes it in: ms under a second, then seconds, then minutes. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

export const statusLabel = (s: 'ok' | 'error'): string => (s === 'ok' ? 'OK' : 'Error');
