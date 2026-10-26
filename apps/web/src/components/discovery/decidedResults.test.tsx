// The decided-results view (#97): a separate view from the pending review queue, since its rows
// carry no accept/dismiss triage and instead expose the unsuppress action added by #96. The one
// requirement under test throughout: a result that has already been unsuppressed (dedupeKey:
// null) must render as a distinct, non-actionable state, never as the same button a never-acted-
// on row shows.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import type { DiscoveryResult } from './api';
import { DecidedResults } from './DecidedResults';

const NOW = Date.now();

function result(over: Partial<DiscoveryResult> & { id: string }): DiscoveryResult {
  return {
    runId: 'run-1',
    sourceId: 'src-1',
    sourceKind: 'ats_greenhouse',
    roleTargetId: null,
    posting: {
      company: 'Initech',
      title: 'Staff Engineer',
      descriptionMd: 'Build things.',
      postingUrl: 'https://boards.greenhouse.io/initech/jobs/1',
      location: 'Austin, TX',
    },
    dedupeKey: 'initech|staff-engineer|austin',
    aiScore: 80,
    aiRationale: null,
    resolution: 'full',
    resolvedSourceRef: null,
    disposition: 'dismissed',
    opportunityId: null,
    sourceMailChannel: null,
    sourceMailExternalId: null,
    dismissReason: null,
    dismissNote: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

/** disposition-aware GET /discovery/results, the way the two tabs' own queries expect. */
function queueHandler(items: { dismissed?: DiscoveryResult[]; accepted?: DiscoveryResult[] }) {
  const byDisposition = new Map(Object.entries(items));
  return (c: ApiCall) => {
    const disposition = new URLSearchParams(c.search).get('disposition') ?? '';
    const rows = byDisposition.get(disposition) ?? [];
    return { items: rows, total: rows.length };
  };
}

describe('DecidedResults', () => {
  it('has a Dismissed and an Accepted tab, each from its own disposition query', async () => {
    const dismissed = result({
      id: 'd1',
      posting: { company: 'Initech', title: 'Dismissed Role' },
    });
    const accepted = result({
      id: 'a1',
      disposition: 'accepted',
      opportunityId: 'opp-1',
      posting: { company: 'Globex', title: 'Accepted Role' },
    });
    const { calls } = mockApi({
      'GET /discovery/results': queueHandler({ dismissed: [dismissed], accepted: [accepted] }),
    });
    const user = userEvent.setup();
    renderWithProviders(<DecidedResults />);

    expect(await screen.findByRole('tab', { name: /^Dismissed/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^Accepted/ })).toBeInTheDocument();
    expect(await screen.findByText('Dismissed Role')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /^Accepted/ }));
    const panel = await screen.findByRole('tabpanel');
    expect(await within(panel).findByText('Accepted Role')).toBeInTheDocument();
    expect(calls.some((c) => c.search.includes('disposition=accepted'))).toBe(true);
    expect(calls.some((c) => c.search.includes('disposition=dismissed'))).toBe(true);
  });

  it('shows why a result was dismissed, naming the denied company for a denylist suppression (issue #199)', async () => {
    const manual = result({
      id: 'd1',
      posting: { company: 'Acme', title: 'Platform Lead' },
      dismissReason: 'seniority',
      dismissNote: null,
    });
    const suppressed = result({
      id: 'd2',
      posting: { company: 'Oracle', title: 'Staff PM' },
      dismissReason: 'denied_company',
      dismissNote: 'Oracle',
    });
    mockApi({
      'GET /discovery/results': queueHandler({ dismissed: [manual, suppressed] }),
    });
    renderWithProviders(<DecidedResults />);

    const manualRow = await screen.findByRole('listitem', { name: 'Platform Lead at Acme' });
    expect(within(manualRow).getByText('Dismissed: Seniority')).toBeInTheDocument();

    const suppressedRow = await screen.findByRole('listitem', { name: 'Staff PM at Oracle' });
    expect(
      within(suppressedRow).getByText('Dismissed: Denied company (Oracle)'),
    ).toBeInTheDocument();
  });

  it('shows nothing extra for a result with no recorded reason (predates this column, or was accepted)', async () => {
    const r = result({ id: 'd1', dismissReason: null });
    mockApi({ 'GET /discovery/results': queueHandler({ dismissed: [r] }) });
    renderWithProviders(<DecidedResults />);
    await screen.findByRole('listitem', { name: 'Staff Engineer at Initech' });
    expect(screen.queryByText(/^Dismissed:/)).not.toBeInTheDocument();
  });

  it('a row that still holds its dedupe key offers Unsuppress, which releases it', async () => {
    const r = result({ id: 'd1' });
    const { calls } = mockApi({
      'GET /discovery/results': queueHandler({ dismissed: [r] }),
      'POST /discovery/results/d1/unsuppress': { ...r, dedupeKey: null },
    });
    const user = userEvent.setup();
    renderWithProviders(<DecidedResults />);

    const row = await screen.findByRole('listitem', { name: 'Staff Engineer at Initech' });
    expect(within(row).queryByText('Unsuppressed')).toBeNull();
    await user.click(within(row).getByRole('button', { name: /unsuppress/i }));

    await waitFor(() => {
      const post = calls.find((c) => c.path === '/discovery/results/d1/unsuppress');
      expect(post).toBeDefined();
    });
    // The server's own answer, not an optimistic guess, is what flips the row (design principle 6).
    expect(await within(row).findByText('Unsuppressed')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /unsuppress/i })).toBeNull();
  });

  it('a result already unsuppressed shows the badge from the start, never the button', async () => {
    const neverTouched = result({
      id: 'd1',
      posting: { company: 'Initech', title: 'Never Decided Twin' },
    });
    const alreadyUnsuppressed = result({
      id: 'd2',
      dedupeKey: null,
      posting: { company: 'Initech', title: 'Already Reopened' },
    });
    mockApi({
      'GET /discovery/results': queueHandler({ dismissed: [neverTouched, alreadyUnsuppressed] }),
    });
    renderWithProviders(<DecidedResults />);

    const untouchedRow = await screen.findByRole('listitem', {
      name: 'Never Decided Twin at Initech',
    });
    expect(within(untouchedRow).getByRole('button', { name: /unsuppress/i })).toBeInTheDocument();
    expect(within(untouchedRow).queryByText('Unsuppressed')).toBeNull();

    const reopenedRow = screen.getByRole('listitem', { name: 'Already Reopened at Initech' });
    expect(within(reopenedRow).getByText('Unsuppressed')).toBeInTheDocument();
    expect(within(reopenedRow).queryByRole('button', { name: /unsuppress/i })).toBeNull();
  });

  it('shows the link to the linked opportunity on an accepted result', async () => {
    const r = result({
      id: 'a1',
      disposition: 'accepted',
      opportunityId: 'opp-9',
      posting: { company: 'Globex', title: 'Accepted Role' },
    });
    mockApi({ 'GET /discovery/results': queueHandler({ accepted: [r] }) });
    const user = userEvent.setup();
    renderWithProviders(<DecidedResults />);

    await user.click(await screen.findByRole('tab', { name: /^Accepted/ }));
    const row = await screen.findByRole('listitem', { name: 'Accepted Role at Globex' });
    expect(within(row).getByRole('link', { name: 'View opportunity' })).toHaveAttribute(
      'href',
      '/opportunities/opp-9',
    );
  });

  it('a 409 from an accepted result whose opportunity is still active leaves the button in place', async () => {
    const r = result({
      id: 'a1',
      disposition: 'accepted',
      opportunityId: 'opp-9',
      posting: { company: 'Globex', title: 'Accepted Role' },
    });
    mockApi({
      'GET /discovery/results': queueHandler({ accepted: [r] }),
      'POST /discovery/results/a1/unsuppress': {
        status: 409,
        body: { error: { code: 'opportunity_still_active' } },
      },
    });
    const user = userEvent.setup();
    renderWithProviders(<DecidedResults />);

    await user.click(await screen.findByRole('tab', { name: /^Accepted/ }));
    const row = await screen.findByRole('listitem', { name: 'Accepted Role at Globex' });
    await user.click(within(row).getByRole('button', { name: /unsuppress/i }));

    // The refusal is reported, not hidden behind an assumed success: the row keeps the active
    // button rather than flipping to the Unsuppressed badge it has not actually earned.
    await waitFor(() =>
      expect(within(row).getByRole('button', { name: /unsuppress/i })).toBeEnabled(),
    );
    expect(within(row).queryByText('Unsuppressed')).toBeNull();
  });

  it('keyboard: j/k move the selection between rows (issue #155)', async () => {
    const user = userEvent.setup();
    const first = result({ id: 'd1', posting: { company: 'Initech', title: 'First Role' } });
    const second = result({ id: 'd2', posting: { company: 'Globex', title: 'Second Role' } });
    mockApi({ 'GET /discovery/results': queueHandler({ dismissed: [first, second] }) });
    renderWithProviders(<DecidedResults />);

    await screen.findByText('First Role');
    await user.keyboard('j');
    expect(screen.getByRole('listitem', { name: /First Role/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    await user.keyboard('j');
    expect(screen.getByRole('listitem', { name: /Second Role/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    await user.keyboard('k');
    expect(screen.getByRole('listitem', { name: /First Role/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('keyboard: u unsuppresses the selected row', async () => {
    const user = userEvent.setup();
    const r = result({ id: 'd1' });
    const { calls } = mockApi({
      'GET /discovery/results': queueHandler({ dismissed: [r] }),
      'POST /discovery/results/d1/unsuppress': { ...r, dedupeKey: null },
    });
    renderWithProviders(<DecidedResults />);

    const row = await screen.findByRole('listitem', { name: 'Staff Engineer at Initech' });
    await user.keyboard('ju');
    await waitFor(() =>
      expect(calls.some((c) => c.path === '/discovery/results/d1/unsuppress')).toBe(true),
    );
    expect(await within(row).findByText('Unsuppressed')).toBeInTheDocument();
  });

  it('keyboard: u does nothing for a row that is already unsuppressed', async () => {
    const user = userEvent.setup();
    const r = result({ id: 'd1', dedupeKey: null });
    const { calls } = mockApi({ 'GET /discovery/results': queueHandler({ dismissed: [r] }) });
    renderWithProviders(<DecidedResults />);

    await screen.findByText('Staff Engineer');
    await user.keyboard('ju');
    expect(calls.some((c) => c.path.endsWith('/unsuppress'))).toBe(false);
  });

  it('keys typed in an input never trigger the Decided view either', async () => {
    const user = userEvent.setup();
    const r = result({ id: 'd1' });
    const { calls } = mockApi({ 'GET /discovery/results': queueHandler({ dismissed: [r] }) });
    renderWithProviders(
      <>
        <input aria-label="elsewhere" />
        <DecidedResults />
      </>,
    );
    await screen.findByText('Staff Engineer');
    await user.click(screen.getByLabelText('elsewhere'));
    await user.keyboard('ju');
    expect(calls.some((c) => c.path.endsWith('/unsuppress'))).toBe(false);
  });
});
