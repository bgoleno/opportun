// The metric dashboards (FR-T6, https://github.com/bgoleno/opportun/issues/346): the list of
// metrics and its filters, a metric's chart with its range, zoom, statistic, filters and
// breakdown, the chart's keyboard cursor and its table, and the notice while collection is off.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import type { MetricCatalog, MetricSeries } from './api';
import { MetricsPage, type MetricsSearch } from './MetricsPage';

const H = 3_600_000;

/** A time as a datetime-local input takes it, to the minute, in the browser's zone. */
function localInput(t: number): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const CATALOG: MetricCatalog = {
  collect: true,
  metrics: [
    {
      name: 'http.server.request.duration',
      instrument: 'histogram',
      unit: 's',
      description: 'Duration of HTTP server requests.',
      scope: 'instance',
      attributes: ['http.request.method', 'http.route', 'http.response.status_code', 'error.type'],
      stats: ['count', 'errors', 'mean', 'max'],
    },
    {
      name: 'opportun.job.duration',
      instrument: 'histogram',
      unit: 's',
      description: 'Duration of background jobs, from claim to finish.',
      scope: 'instance',
      attributes: ['opportun.job.kind', 'opportun.job.outcome', 'error.type'],
      stats: ['count', 'errors', 'mean', 'max'],
    },
    {
      name: 'opportun.obs.dropped',
      instrument: 'counter',
      unit: '{item}',
      description: 'Telemetry items dropped by the gate or a full buffer.',
      scope: 'instance',
      attributes: ['opportun.obs.signal', 'opportun.obs.reason'],
      stats: ['sum'],
    },
  ],
};

/** A series answer for whatever was asked, with values 1, 2, 3, ... per step. */
function seriesFor(call: ApiCall): MetricSeries {
  const q = new URLSearchParams(call.search);
  const from = Number(q.get('from'));
  const to = Number(q.get('to'));
  const step = Math.max(60_000, Math.ceil((to - from) / 4 / 60_000) * 60_000);
  const times = [0, 1, 2, 3].map((i) => Math.floor(from / step) * step + i * step);
  const by = q.get('by');
  const labels = by === null ? [null] : ['GET', 'POST'];
  return {
    metric: q.get('metric') ?? '',
    stat: (q.get('stat') ?? 'count') as MetricSeries['stat'],
    from,
    to,
    step,
    resolution: 60_000,
    series: labels.map((label, k) => ({
      label,
      points: times.map((t, i) => ({ t, v: i === 2 && k === 0 ? null : (i + 1) * (k + 1) })),
    })),
    values: { 'http.request.method': ['GET', 'POST'], 'http.route': ['/api/v1/a'] },
    truncated: false,
  };
}

function Harness({ isAdmin = true, initial = {} }: { isAdmin?: boolean; initial?: MetricsSearch }) {
  const [search, setSearch] = useState<MetricsSearch>(initial);
  return <MetricsPage isAdmin={isAdmin} search={search} onSearchChange={setSearch} />;
}

const lastSeries = (calls: ApiCall[]) =>
  new URLSearchParams(calls.filter((c) => c.path === '/obs/metrics/series').at(-1)!.search);

describe('MetricsPage', () => {
  it('lists every metric with its description and unit, and filters the list', async () => {
    mockApi({ 'GET /obs/metrics': CATALOG });
    renderWithProviders(<Harness />);
    const user = userEvent.setup();
    const list = await screen.findByRole('list', { name: 'Metrics' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(list).toHaveTextContent('Duration of HTTP server requests.');
    expect(list).toHaveTextContent('seconds');
    await user.type(screen.getByLabelText('Search metrics'), 'job');
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(list).toHaveTextContent('opportun.job.duration');
    await user.clear(screen.getByLabelText('Search metrics'));
    await user.selectOptions(screen.getByLabelText('Carries attribute'), 'opportun.obs.reason');
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(list).toHaveTextContent('opportun.obs.dropped');
  });

  it('links to the AI traces page, for each call one by one (FR-T7)', async () => {
    mockApi({ 'GET /obs/metrics': CATALOG });
    renderWithProviders(<Harness />);
    expect(await screen.findByRole('link', { name: 'AI traces' })).toHaveAttribute(
      'href',
      '/settings/traces',
    );
  });

  it('picking a metric charts it over the last 24 hours, with its first statistic', async () => {
    const { calls } = mockApi({
      'GET /obs/metrics': CATALOG,
      'GET /obs/metrics/series': seriesFor,
    });
    renderWithProviders(<Harness />);
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: /http\.server\.request\.duration/ }));
    expect(
      await screen.findByRole('heading', { name: 'http.server.request.duration' }),
    ).toBeInTheDocument();
    await screen.findByRole('table', { name: /Calls/ });
    const q = lastSeries(calls);
    expect(q.get('metric')).toBe('http.server.request.duration');
    expect(q.get('stat')).toBe('count');
    expect(Number(q.get('to')) - Number(q.get('from'))).toBe(24 * H);
  });

  it('changes the range by preset, by a custom range, and by zooming in and out', async () => {
    const { calls } = mockApi({
      'GET /obs/metrics': CATALOG,
      'GET /obs/metrics/series': seriesFor,
    });
    renderWithProviders(<Harness initial={{ metric: 'http.server.request.duration' }} />);
    const user = userEvent.setup();
    await screen.findByRole('table', { name: /Calls/ });
    const span = () => {
      const q = lastSeries(calls);
      return Number(q.get('to')) - Number(q.get('from'));
    };
    await user.selectOptions(screen.getByLabelText('Time range'), '7d');
    await screen.findByRole('table', { name: /Calls/ });
    await waitFor(() => expect(span()).toBe(7 * 24 * H));
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    await waitFor(() => expect(span()).toBe(3.5 * 24 * H));
    await user.click(screen.getByRole('button', { name: 'Zoom out' }));
    // Back to the same range as the preset: served from the query cache, so read the fields.
    const shown = () =>
      new Date((screen.getByLabelText('To') as HTMLInputElement).value).getTime() -
      new Date((screen.getByLabelText('From') as HTMLInputElement).value).getTime();
    expect(shown()).toBe(7 * 24 * H);
    // After a zoom the range is custom, and says so.
    expect(screen.getByLabelText('Time range')).toHaveValue('custom');

    await user.selectOptions(screen.getByLabelText('Time range'), 'custom');
    const from = screen.getByLabelText('From');
    const to = screen.getByLabelText('To');
    await user.clear(from);
    // Relative to now: the page refuses a range older than the 30 days points are kept, so a
    // fixed date would start failing a month later (tl on #363).
    const start = localInput(Date.now() - 3 * H);
    const end = localInput(Date.now() - H);
    await user.type(from, start);
    await user.clear(to);
    await user.type(to, end);
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    const q = lastSeries(calls);
    expect(Number(q.get('from'))).toBe(new Date(start).getTime());
    expect(Number(q.get('to'))).toBe(new Date(end).getTime());
  });

  it('refuses a custom range that ends before it starts', async () => {
    mockApi({ 'GET /obs/metrics': CATALOG, 'GET /obs/metrics/series': seriesFor });
    renderWithProviders(<Harness initial={{ metric: 'http.server.request.duration' }} />);
    const user = userEvent.setup();
    await screen.findByRole('table', { name: /Calls/ });
    await user.selectOptions(screen.getByLabelText('Time range'), 'custom');
    await user.clear(screen.getByLabelText('From'));
    await user.type(screen.getByLabelText('From'), localInput(Date.now() - H));
    await user.clear(screen.getByLabelText('To'));
    await user.type(screen.getByLabelText('To'), localInput(Date.now() - 3 * H));
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/ends before it starts/);
  });

  it('applies the last 30 days unchanged as a custom range', async () => {
    // The inputs hold whole minutes, so the start they show can be a few seconds older than 30
    // days: that is still the range the preset showed, not one past what is kept (tl on #363).
    const { calls } = mockApi({
      'GET /obs/metrics': CATALOG,
      'GET /obs/metrics/series': seriesFor,
    });
    renderWithProviders(<Harness initial={{ metric: 'http.server.request.duration' }} />);
    const user = userEvent.setup();
    await screen.findByRole('table', { name: /Calls/ });
    await user.selectOptions(screen.getByLabelText('Time range'), '30d');
    await user.selectOptions(screen.getByLabelText('Time range'), 'custom');
    const before = calls.length;
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(() => expect(calls.length).toBeGreaterThan(before));
    const q = lastSeries(calls);
    expect(Number(q.get('to')) - Number(q.get('from'))).toBeLessThanOrEqual(30 * 24 * H);
  });

  it('refuses a custom range that starts in the future', async () => {
    mockApi({ 'GET /obs/metrics': CATALOG, 'GET /obs/metrics/series': seriesFor });
    renderWithProviders(<Harness initial={{ metric: 'http.server.request.duration' }} />);
    const user = userEvent.setup();
    await screen.findByRole('table', { name: /Calls/ });
    await user.selectOptions(screen.getByLabelText('Time range'), 'custom');
    await user.clear(screen.getByLabelText('From'));
    await user.type(screen.getByLabelText('From'), localInput(Date.now() + H));
    await user.clear(screen.getByLabelText('To'));
    await user.type(screen.getByLabelText('To'), localInput(Date.now() + 2 * H));
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/starts in the future/);
  });

  it('sends the statistic, a filter and a breakdown, and draws a line per group', async () => {
    const { calls } = mockApi({
      'GET /obs/metrics': CATALOG,
      'GET /obs/metrics/series': seriesFor,
    });
    renderWithProviders(<Harness initial={{ metric: 'http.server.request.duration' }} />);
    const user = userEvent.setup();
    await screen.findByRole('table', { name: /Calls/ });
    await user.selectOptions(screen.getByLabelText('Statistic'), 'mean');
    await screen.findByRole('table', { name: /Mean duration/ });
    expect(lastSeries(calls).get('stat')).toBe('mean');
    await user.selectOptions(screen.getByLabelText('http.request.method'), 'POST');
    expect(lastSeries(calls).getAll('filter')).toEqual(['http.request.method=POST']);
    await user.selectOptions(screen.getByLabelText('Break down by'), 'http.request.method');
    expect(lastSeries(calls).get('by')).toBe('http.request.method');
    const legend = await screen.findByRole('list', { name: 'Legend' });
    expect(
      within(legend)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['GET', 'POST']);
    const table = screen.getByRole('table', { name: /Mean duration/ });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['Time', 'GET', 'POST']);
  });

  it('shows the same numbers in the table as in the chart, a gap as no data', async () => {
    mockApi({ 'GET /obs/metrics': CATALOG, 'GET /obs/metrics/series': seriesFor });
    renderWithProviders(<Harness initial={{ metric: 'http.server.request.duration' }} />);
    const table = await screen.findByRole('table', { name: /Calls/ });
    const cells = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((r) => within(r).getAllByRole('cell').at(-1)!.textContent);
    expect(cells).toEqual(['1', '2', 'no data', '4']);
  });

  it('moves a cursor along the chart by keyboard and reads out the value under it', async () => {
    mockApi({ 'GET /obs/metrics': CATALOG, 'GET /obs/metrics/series': seriesFor });
    renderWithProviders(<Harness initial={{ metric: 'http.server.request.duration' }} />);
    const user = userEvent.setup();
    const chart = await screen.findByRole('group', { name: /Chart of Calls/ });
    chart.focus();
    await user.keyboard('{Home}');
    const readout = screen.getByTestId('chart-readout');
    expect(readout).toHaveTextContent(/Calls: 1$/);
    await user.keyboard('{ArrowRight}');
    expect(readout).toHaveTextContent(/Calls: 2$/);
    await user.keyboard('{End}');
    expect(readout).toHaveTextContent(/Calls: 4$/);
    await user.keyboard('{ArrowLeft}');
    expect(readout).toHaveTextContent(/Calls: no data$/);
    // The zoom keys zoom around the cursor.
    await user.keyboard('{+}');
    expect(screen.getByLabelText('Time range')).toHaveValue('custom');
  });

  it('while collection is off, says so, and links an admin to the switch in Settings > Telemetry', async () => {
    mockApi({ 'GET /obs/metrics': { ...CATALOG, collect: false } });
    renderWithProviders(<Harness />);
    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent('Collection is off');
    expect(within(notice).getByRole('link', { name: 'Settings > Telemetry' })).toHaveAttribute(
      'href',
      '/settings/telemetry',
    );
  });

  it('while collection is off, tells a user to ask an admin, with no link', async () => {
    mockApi({ 'GET /obs/metrics': { ...CATALOG, collect: false } });
    renderWithProviders(<Harness isAdmin={false} />);
    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent(/Ask an admin/);
    expect(within(notice).queryByRole('link')).toBeNull();
  });

  it('tells a user with no metrics yet what they will see', async () => {
    mockApi({ 'GET /obs/metrics': { collect: true, metrics: [] } });
    renderWithProviders(<Harness isAdmin={false} />);
    expect(await screen.findByText(/No metrics are available to you yet/)).toBeInTheDocument();
  });
});
