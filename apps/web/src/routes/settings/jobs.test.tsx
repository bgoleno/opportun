// #140: the one queue every background job shares had no page. JobsCard is the thin
// admin-only route's actual content (jobs.tsx's own admin gate is untested, matching the
// same-shaped gate in users.tsx, which has none either); this covers what an operator
// diagnosing a stuck instance needs to read off it.
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import { displayStatus, JobsCard, type JobsAnswer, type JobView } from './-jobs';

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

const NONE: JobsAnswer['counts'] = { queued: 0, retrying: 0, running: 0, done: 0, dead: 0 };

/** What the server answers when `items` are the jobs: the status asked for, and every one counted. */
const answer =
  (items: JobView[]) =>
  (call: ApiCall): JobsAnswer => {
    const status = new URLSearchParams(call.search).get('status');
    const counts = { ...NONE };
    for (const j of items) counts[displayStatus(j)] += 1;
    return {
      items: items.filter((j) => status === null || displayStatus(j) === status),
      counts,
    };
  };

describe('JobsCard', () => {
  it('shows a fresh pending job as Queued, not Retrying', async () => {
    mockApi({ 'GET /jobs': answer([job({ id: 'j1', attempts: 0 })]) });
    renderWithProviders(<JobsCard />);
    const table = await screen.findByRole('table', { name: 'Jobs' });
    const row = within(table).getAllByRole('row')[1]!;
    expect(row).toHaveTextContent('gmail.sync');
    expect(row).toHaveTextContent('Queued');
    expect(row).toHaveTextContent('0 / 5');
  });

  it('shows a pending job that already failed once as Retrying, with the error', async () => {
    mockApi({
      'GET /jobs': answer([
        job({
          id: 'j1',
          attempts: 2,
          lastError: 'ECONNRESET: connection reset while talking to Gmail',
        }),
      ]),
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
      'GET /jobs': answer([
        job({ id: 'j1', kind: 'backup', status: 'running', attempts: 1 }),
        job({ id: 'j2', kind: 'discovery.run', status: 'done', attempts: 1 }),
        job({
          id: 'j3',
          kind: 'comms.classify',
          status: 'dead',
          attempts: 5,
          lastError: 'invalid payload: message missing',
        }),
      ]),
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
      'GET /jobs': answer([
        job({ id: 'overdue', runAt: NOW - 120_000 }),
        job({ id: 'future', runAt: NOW + 120_000 }),
      ]),
    });
    renderWithProviders(<JobsCard />);
    const table = await screen.findByRole('table', { name: 'Jobs' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('(overdue)');
    expect(rows[1]).not.toHaveTextContent('(overdue)');
  });

  it('counts jobs by status in the summary tiles', async () => {
    mockApi({
      'GET /jobs': answer([
        job({ id: 'j1', attempts: 0 }),
        job({ id: 'j2', attempts: 0 }),
        job({ id: 'j3', attempts: 3 }),
        job({ id: 'j4', status: 'dead', attempts: 5 }),
      ]),
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
      'GET /jobs': answer([
        job({ id: 'queued-1', kind: 'backup', attempts: 0 }),
        job({ id: 'dead-1', kind: 'comms.classify', status: 'dead', attempts: 5 }),
      ]),
    });
    renderWithProviders(<JobsCard />);
    await screen.findByRole('table', { name: 'Jobs' });

    const deadTile = screen.getByRole('button', { name: /Dead/ });
    await user.click(deadTile);
    const filtered = await screen.findByRole('table', { name: 'Jobs' });
    const filteredRows = within(filtered).getAllByRole('row').slice(1);
    expect(filteredRows).toHaveLength(1);
    expect(filteredRows[0]).toHaveTextContent('comms.classify');
    expect(deadTile).toHaveAttribute('aria-pressed', 'true');

    await user.click(deadTile);
    const cleared = await screen.findByRole('table', { name: 'Jobs' });
    expect(within(cleared).getAllByRole('row')).toHaveLength(3);
    expect(deadTile).toHaveAttribute('aria-pressed', 'false');
  });

  it('names the user a per-user job ran for, and says nothing for an instance-wide one', async () => {
    mockApi({
      'GET /jobs': answer([
        job({ id: 'j1', kind: 'imports.linkedin', userId: 'u-42' }),
        job({ id: 'j2', kind: 'backup', userId: null }),
      ]),
    });
    renderWithProviders(<JobsCard />);
    const table = await screen.findByRole('table', { name: 'Jobs' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('user u-42');
    expect(rows[1]).not.toHaveTextContent('user');
  });

  it('says there are no jobs yet, rather than showing an empty table', async () => {
    mockApi({ 'GET /jobs': answer([]) });
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

// https://github.com/bgoleno/opportun/issues/982: the page counted and filtered the 200 jobs it had
// been given, and could say there were no dead ones when there were.
describe('JobsCard, with more jobs than it lists (#982)', () => {
  const COUNTS = { queued: 4, retrying: 1, running: 2, done: 1200, dead: 3 };
  const DEAD = job({ id: 'dead-1', kind: 'comms.classify', status: 'dead', attempts: 5 });
  const DONE = Array.from({ length: 200 }, (_, i) =>
    job({ id: `done-${i}`, kind: 'backup', status: 'done', attempts: 1 }),
  );
  /** The 200 listed are all done; the dead ones changed before them. */
  const server = (call: ApiCall): JobsAnswer => ({
    items: new URLSearchParams(call.search).get('status') === 'dead' ? [DEAD] : DONE,
    counts: COUNTS,
  });
  const tile = (name: string) =>
    within(screen.getByRole('list', { name: 'Jobs by status' })).getByRole('button', {
      name: (n) => n.startsWith(name),
    });

  it("shows the server's counts, of the jobs it does not list too", async () => {
    mockApi({ 'GET /jobs': server });
    renderWithProviders(<JobsCard />);
    await screen.findByRole('table', { name: 'Jobs' });
    expect(tile('Queued')).toHaveTextContent('Queued4');
    expect(tile('Running')).toHaveTextContent('Running2');
    expect(tile('Retrying')).toHaveTextContent('Retrying1');
    expect(tile('Dead')).toHaveTextContent('Dead3');
    expect(tile('Done')).toHaveTextContent('Done1,200');
  });

  it('asks the server for the status pressed, and for all again when it is pressed again', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({ 'GET /jobs': server });
    renderWithProviders(<JobsCard />);
    await screen.findByRole('table', { name: 'Jobs' });
    await user.click(tile('Dead'));
    expect(await screen.findByText('comms.classify')).toBeInTheDocument();
    expect(screen.queryByText('backup')).toBeNull();
    expect(tile('Done')).toHaveTextContent('1,200');
    await user.click(tile('Dead'));
    await screen.findAllByText('backup');
    const asked = calls.filter((c) => c.path === '/jobs').map((c) => c.search);
    expect(asked).toEqual(['?limit=200', '?limit=200&status=dead', '?limit=200']);
  });

  it('asks for queued and retrying apart', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({ 'GET /jobs': server });
    renderWithProviders(<JobsCard />);
    await screen.findByRole('table', { name: 'Jobs' });
    for (const [name, status] of [
      ['Queued', 'queued'],
      ['Retrying', 'retrying'],
      ['Running', 'running'],
      ['Done', 'done'],
    ] as const) {
      await user.click(tile(name));
      await screen.findByRole('table', { name: 'Jobs' });
      expect(calls.at(-1)?.search).toBe(`?limit=200&status=${status}`);
    }
  });

  it('says which jobs it shows, and how many there are beyond them', async () => {
    const user = userEvent.setup();
    mockApi({ 'GET /jobs': server });
    renderWithProviders(<JobsCard />);
    expect(
      await screen.findByText(
        'The 200 most recently changed jobs are shown, newest first. 1,010 more are not.',
      ),
    ).toBeInTheDocument();
    await user.click(tile('Done'));
    expect(
      await screen.findByText(
        'The 200 most recently changed done jobs are shown, newest first. 1,000 more are not.',
      ),
    ).toBeInTheDocument();
  });

  it('says one more as one', async () => {
    mockApi({ 'GET /jobs': { items: DONE, counts: { ...NONE, done: 201 } } });
    renderWithProviders(<JobsCard />);
    expect(
      await screen.findByText(
        'The 200 most recently changed jobs are shown, newest first. 1 more is not.',
      ),
    ).toBeInTheDocument();
  });

  it('says so when all of them are shown', async () => {
    const user = userEvent.setup();
    const jobs = [job({ id: 'q1' }), job({ id: 'q2' }), DEAD];
    mockApi({ 'GET /jobs': answer(jobs) });
    renderWithProviders(<JobsCard />);
    expect(
      await screen.findByText('All 3 jobs are shown, most recently changed first.'),
    ).toBeInTheDocument();
    await user.click(tile('Queued'));
    expect(
      await screen.findByText('All 2 queued jobs are shown, most recently changed first.'),
    ).toBeInTheDocument();
    await user.click(tile('Dead'));
    expect(await screen.findByText('The one dead job is shown.')).toBeInTheDocument();
  });

  it('a list read just after the counts were is never short of them', async () => {
    // Two reads: a job added between them is in the second only.
    mockApi({ 'GET /jobs': { items: [job()], counts: NONE } });
    renderWithProviders(<JobsCard />);
    expect(await screen.findByText('The one job is shown.')).toBeInTheDocument();
  });

  it("shows no other status's jobs, and no answer, until the server has answered", async () => {
    const user = userEvent.setup();
    let release: (a: JobsAnswer) => void = () => undefined;
    mockApi({
      'GET /jobs': (call: ApiCall) =>
        call.search.includes('status=dead')
          ? new Promise<JobsAnswer>((resolve) => {
              release = resolve;
            })
          : server(call),
    });
    renderWithProviders(<JobsCard />);
    await screen.findByRole('table', { name: 'Jobs' });
    await user.click(tile('Dead'));
    expect(tile('Dead')).toHaveAttribute('aria-pressed', 'true');
    expect(tile('Dead')).toHaveTextContent('3');
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Jobs' })).toBeNull();
    expect(screen.queryByText(/are shown/)).toBeNull();
    expect(screen.queryByText('No dead jobs.')).toBeNull();
    release({ items: [], counts: { ...COUNTS, dead: 0 } });
    expect(await screen.findByText('No dead jobs.')).toBeInTheDocument();
    expect(tile('Dead')).toHaveTextContent('0');
  });

  it('asks again for a status it has shown before, and does not show the old answer meanwhile', async () => {
    const user = userEvent.setup();
    let dead = [DEAD];
    mockApi({
      'GET /jobs': (call: ApiCall) =>
        call.search.includes('status=dead') ? { items: dead, counts: COUNTS } : server(call),
    });
    renderWithProviders(<JobsCard />);
    await screen.findByRole('table', { name: 'Jobs' });
    await user.click(tile('Dead'));
    await screen.findByText('comms.classify');
    await user.click(tile('Dead'));
    await screen.findAllByText('backup');
    dead = [job({ id: 'dead-2', kind: 'discovery.run', status: 'dead', attempts: 5 })];
    await user.click(tile('Dead'));
    expect(screen.queryByText('comms.classify')).toBeNull();
    expect(await screen.findByText('discovery.run')).toBeInTheDocument();
  });

  it('a status that could not be read can be left for all of them', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /jobs': (call: ApiCall) =>
        call.search.includes('status=dead')
          ? { status: 500, body: { error: { code: 'server_error' } } }
          : server(call),
    });
    renderWithProviders(<JobsCard />);
    await screen.findByRole('table', { name: 'Jobs' });
    await user.click(tile('Dead'));
    expect(await screen.findByText(/server_error/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show all jobs' }));
    expect(await screen.findByRole('table', { name: 'Jobs' })).toBeInTheDocument();
    expect(tile('Dead')).toHaveAttribute('aria-pressed', 'false');
  });
});
