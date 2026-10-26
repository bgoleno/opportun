// The discovery detail view (spec D3b, Plan 3 Task 5). The failure Brian named is a queue row
// that cannot be judged without going and finding the original somewhere else, so the test is
// about self-sufficiency: everything the decision needs is here, and the one thing the app does
// not hold, the message itself, is a link rather than a copy.
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import type { DiscoveryResult } from './api';
import { ResultDetailDialog } from './QueueDialogs';

const CONNECTED = {
  connected: true,
  lastSyncAt: null,
  count: 0,
  status: null,
  lookbackDays: 180,
  accountEmail: 'mailbox@gmail.test',
};

const lead = (over: Partial<DiscoveryResult> = {}): DiscoveryResult =>
  ({
    id: 'r1',
    runId: 'run1',
    sourceId: 's1',
    sourceKind: 'alert_email',
    roleTargetId: null,
    posting: {
      company: 'Northwind Systems',
      title: 'Staff Platform Engineer',
      location: 'Austin, TX',
      remote: true,
      compNote: '$200,000 to $240,000',
      descriptionMd: 'Build and run the platform. Go, Kubernetes, and a small team.',
      postingUrl: 'https://boards.greenhouse.io/northwind/jobs/4242',
    },
    dedupeKey: 'northwind|staff-platform-engineer|austin',
    aiScore: 82,
    aiRationale: 'Matches the platform engineering target, and the comp band fits.',
    resolution: 'full',
    resolvedSourceRef: null,
    disposition: 'pending',
    opportunityId: null,
    sourceMailChannel: 'gmail',
    sourceMailExternalId: '1a14802e3951170a',
    dismissReason: null,
    dismissNote: null,
    createdAt: Date.UTC(2026, 9, 18),
    updatedAt: Date.UTC(2026, 9, 18),
    ...over,
  }) as DiscoveryResult;

const open = (result: DiscoveryResult) =>
  renderWithProviders(
    <ResultDetailDialog
      result={result}
      onClose={vi.fn()}
      onAccept={vi.fn()}
      onDismiss={vi.fn()}
      onCapture={vi.fn()}
    />,
  );

describe('ResultDetailDialog', () => {
  beforeEach(() => {
    mockApi({ 'GET /integrations/gmail': CONNECTED });
  });

  it('shows everything the decision needs without leaving the app', async () => {
    open(lead());

    expect(await screen.findByText('Staff Platform Engineer')).toBeInTheDocument();
    expect(screen.getByText(/northwind systems/i)).toBeInTheDocument();
    expect(screen.getByText(/austin, tx/i)).toBeInTheDocument();
    expect(screen.getByText('Remote')).toBeInTheDocument();
    expect(screen.getByText(/\$200,000 to \$240,000/)).toBeInTheDocument();
    expect(screen.getByText(/build and run the platform/i)).toBeInTheDocument();
    expect(screen.getByText(/matches the platform engineering target/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/ai score 82 of 100/i)).toBeInTheDocument();
    expect(screen.getByText(/from job alert email/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open the posting/i })).toBeInTheDocument();
  });

  it('links back to the email the lead was parsed out of', async () => {
    open(lead());

    const link = await screen.findByRole('link', { name: /view the source email/i });
    expect(link).toHaveAttribute('href', expect.stringContaining('1a14802e3951170a'));
    await waitFor(() =>
      expect(link).toHaveAttribute(
        'href',
        expect.stringContaining('authuser=mailbox%40gmail.test'),
      ),
    );
  });

  it('offers no source email for a lead that did not come from one', async () => {
    open(
      lead({ sourceKind: 'ats_greenhouse', sourceMailChannel: null, sourceMailExternalId: null }),
    );

    await screen.findByText('Staff Platform Engineer');
    expect(screen.queryByRole('link', { name: /source email/i })).toBeNull();
  });

  it('#137: says why, instead of showing nothing, when the source email cannot be addressed', async () => {
    open(lead({ sourceMailChannel: 'linkedin', sourceMailExternalId: 'linkedin:1' }));

    await screen.findByText('Staff Platform Engineer');
    expect(screen.queryByRole('link', { name: /source email/i })).toBeNull();
    expect(
      await screen.findByText(
        'This came from your LinkedIn export, so there is no mailbox copy to open.',
      ),
    ).toBeInTheDocument();
  });

  it('says a partial lead is partial, rather than showing an empty description', async () => {
    open(
      lead({ resolution: 'needs_capture', posting: { ...lead().posting, descriptionMd: null } }),
    );

    expect(await screen.findByText(/only a partial lead was found/i)).toBeInTheDocument();
    expect(screen.getByText(/no description/i)).toBeInTheDocument();
  });
});
