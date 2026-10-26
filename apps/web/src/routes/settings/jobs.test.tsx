// #140: the one queue every background job shares had no page. JobsCard is the thin
// admin-only route's actual content (jobs.tsx's own admin gate is untested, matching the
// same-shaped gate in users.tsx, which has none either); this covers what an operator
// diagnosing a stuck instance needs to read off it.
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import { JobsCard, type JobView } from './-jobs';

// The component reads Date.now() directly (not an injected clock), so the fixtures below use
// it too rather than a fixed date that could drift from whatever "now" actually is.
const NOW = Date.now();

const job = (over: Partial<JobView> = {}): JobView => ({
  id: 'j1',
  kind: 'gmail.sync',
  status: 'pending',
  attempts: 0,
  maxAttempts: 5,
  runAt: NOW,
  lastError: null,
  userId: null,
  createdAt: NOW - 60_000,
  updatedAt: NOW - 60_000,
  ...over,
});

describe('JobsCard', () => {
  it('shows a fresh pending job as Queued, not Retrying', async () => {
    mockApi({ 'GET /jobs': { items: [job({ id: 'j1', attempts: 0 })] } });
    renderWithProviders(<JobsCard />);
    const table = await screen.findByRole('table', { name: 'Jobs' });
    const row = within(table).getAllByRole('row')[1]!;
    expect(row).toHaveTextContent('gmail.sync');
    expect(row).toHaveTextContent('Queued');
    expect(row).toHaveTextContent('0 / 5');
  });

  it('shows a pending job that already failed once as Retrying, with the error', async () => {
    mockApi({
      'GET /jobs': {
        items: [
          job({
            id: 'j1',
            attempts: 2,
            lastError: 'ECONNRESET: connection reset while talking to Gmail',
          }),
        ],
      },
    });
    renderWithProviders(<JobsCard />);
    const table = await screen.findByRole('table', { name: 'Jobs' });
    const row = within(table).getAllByRole('row')[1]!;
    expect(row).toHaveTextContent('Retrying');
    expect(row).toHaveTextContent('2 / 5');
    expect(row).toHaveTextContent(/ECONNRESET/);
  });

  it('shows running, done and dead without translation', async () => {
    mockApi({
      'GET /jobs': {
        items: [
          job({ id: 'j1', kind: 'backup', status: 'running', attempts: 1 }),
          job({ id: 'j2', kind: 'discovery.run', status: 'done', attempts: 1 }),
          job({
            id: 'j3',
            kind: 'comms.classify',
            status: 'dead',
            attempts: 5,
            lastError: 'invalid payload: message missing',
          }),
        ],
      },
    });
    renderWithProviders(<JobsCard />);
    const table = await screen.findByRole('table', { name: 'Jobs' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Running');
    expect(rows[1]).toHaveTextContent('Done');
    expect(rows[2]).toHaveTextContent('Dead');
    expect(rows[2]).toHaveTextContent(/invalid payload/);
  });

  it('flags a pending job as overdue once its due time has passed', async () => {
    mockApi({
      'GET /jobs': {
        items: [
          job({ id: 'overdue', runAt: NOW - 120_000 }),
          job({ id: 'future', runAt: NOW + 120_000 }),
        ],
      },
    });
    renderWithProviders(<JobsCard />);
    const table = await screen.findByRole('table', { name: 'Jobs' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('(overdue)');
    expect(rows[1]).not.toHaveTextContent('(overdue)');
  });

  it('counts jobs by status in the summary tiles', async () => {
    mockApi({
      'GET /jobs': {
        items: [
          job({ id: 'j1', attempts: 0 }),
          job({ id: 'j2', attempts: 0 }),
          job({ id: 'j3', attempts: 3 }),
          job({ id: 'j4', status: 'dead', attempts: 5 }),
        ],
      },
    });
    renderWithProviders(<JobsCard />);
    const tiles = await screen.findByRole('list', { name: 'Jobs by status' });
    expect(within(tiles).getByRole('button', { name: /Queued/ })).toHaveTextContent('2');
    expect(within(tiles).getByRole('button', { name: /Retrying/ })).toHaveTextContent('1');
    expect(within(tiles).getByRole('button', { name: /Dead/ })).toHaveTextContent('1');
    expect(within(tiles).getByRole('button', { name: /Running/ })).toHaveTextContent('0');
  });

  it('filters the table to one status on click, and clears it on a second click', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /jobs': {
        items: [
          job({ id: 'queued-1', kind: 'backup', attempts: 0 }),
          job({ id: 'dead-1', kind: 'comms.classify', status: 'dead', attempts: 5 }),
        ],
      },
    });
    renderWithProviders(<JobsCard />);
    await screen.findByRole('table', { name: 'Jobs' });

    const deadTile = screen.getByRole('button', { name: /Dead/ });
    await user.click(deadTile);
    const filtered = screen.getByRole('table', { name: 'Jobs' });
    const filteredRows = within(filtered).getAllByRole('row').slice(1);
    expect(filteredRows).toHaveLength(1);
    expect(filteredRows[0]).toHaveTextContent('comms.classify');
    expect(deadTile).toHaveAttribute('aria-pressed', 'true');

    await user.click(deadTile);
    const cleared = screen.getByRole('table', { name: 'Jobs' });
    expect(within(cleared).getAllByRole('row')).toHaveLength(3);
    expect(deadTile).toHaveAttribute('aria-pressed', 'false');
  });

  it('names the user a per-user job ran for, and says nothing for an instance-wide one', async () => {
    mockApi({
      'GET /jobs': {
        items: [
          job({ id: 'j1', kind: 'imports.linkedin', userId: 'u-42' }),
          job({ id: 'j2', kind: 'backup', userId: null }),
        ],
      },
    });
    renderWithProviders(<JobsCard />);
    const table = await screen.findByRole('table', { name: 'Jobs' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('user u-42');
    expect(rows[1]).not.toHaveTextContent('user');
  });

  it('says there are no jobs yet, rather than showing an empty table', async () => {
    mockApi({ 'GET /jobs': { items: [] } });
    renderWithProviders(<JobsCard />);
    expect(await screen.findByText('No jobs yet.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('surfaces a failed listing instead of rendering empty slots', async () => {
    mockApi({ 'GET /jobs': () => ({ status: 500, body: { error: { code: 'server_error' } } }) });
    renderWithProviders(<JobsCard />);
    expect(await screen.findByText(/server_error/)).toBeInTheDocument();
  });
});
