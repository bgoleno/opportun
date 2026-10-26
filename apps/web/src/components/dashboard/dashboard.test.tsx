import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { DashboardData } from '@/lib/opportunities';
import { mockApi, renderWithProviders } from '@/test/render';
import { Dashboard } from './Dashboard';

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

const payload: DashboardData = {
  stageCounts: {
    discovered: 4,
    interested: 2,
    preparing: 1,
    applied: 3,
    in_process: 1,
    offer: 0,
    dismissed: 7,
    closed: 2,
  },
  dueNextSteps: [
    {
      id: 'step-1',
      userId: 'u1',
      opportunityId: 'opp-1',
      action: 'Send thank-you note',
      dueAt: NOW - DAY,
      doneAt: null,
      owner: null,
      createdAt: NOW - 3 * DAY,
      updatedAt: NOW - 3 * DAY,
      opportunityTitle: 'Staff PM',
      companyName: 'Acme',
    },
    {
      id: 'step-2',
      userId: 'u1',
      opportunityId: 'opp-2',
      action: 'Prep system design',
      dueAt: NOW + 2 * DAY,
      doneAt: null,
      owner: null,
      createdAt: NOW - DAY,
      updatedAt: NOW - DAY,
      opportunityTitle: 'Principal Engineer',
      companyName: 'Globex',
    },
  ],
  recentActivity: [
    {
      kind: 'activity',
      id: 'act-1',
      opportunityId: 'opp-1',
      opportunityTitle: 'Staff PM',
      occurredAt: NOW - 2 * 60 * 60 * 1000,
      activityKind: 'interview',
      title: 'Hiring manager screen',
      bodyMd: null,
      participants: [],
      externalUrl: null,
    },
    {
      kind: 'stage',
      id: 'st-1',
      opportunityId: 'opp-2',
      opportunityTitle: 'Principal Engineer',
      occurredAt: NOW - DAY,
      fromStage: 'interested',
      toStage: 'applied',
      note: null,
    },
  ],
  needsTriage: { communications: 5 },
};

describe('Dashboard', () => {
  it('renders stage counts, due next steps, recent activity and the triage badge', async () => {
    mockApi({ 'GET /dashboard': payload });
    renderWithProviders(<Dashboard />);

    const stages = await screen.findByRole('region', { name: 'Pipeline by stage' });
    const applied = within(stages).getByRole('link', { name: /Applied/ });
    expect(applied).toHaveTextContent('3');
    expect(applied).toHaveAttribute('href', '/pipeline?stage=applied');
    expect(within(stages).getByRole('link', { name: /New/ })).toHaveTextContent('4');
    expect(within(stages).getByRole('link', { name: /Dismissed/ })).toHaveTextContent('7');

    const steps = screen.getByRole('region', { name: 'Due next steps' });
    const stepItems = within(steps).getAllByRole('listitem');
    expect(stepItems).toHaveLength(2);
    expect(stepItems[0]).toHaveTextContent('Send thank-you note');
    expect(stepItems[0]).toHaveTextContent('Acme');
    expect(stepItems[0]).toHaveTextContent('Overdue');
    expect(stepItems[1]).toHaveTextContent('Prep system design');
    expect(stepItems[1]).not.toHaveTextContent('Overdue');

    const activity = screen.getByRole('region', { name: 'Recent activity' });
    const activityItems = within(activity).getAllByRole('listitem');
    expect(activityItems).toHaveLength(2);
    expect(activityItems[0]).toHaveTextContent('Hiring manager screen');
    expect(activityItems[1]).toHaveTextContent('Interested to Applied');
    expect(activityItems[1]).toHaveTextContent('Principal Engineer');

    const triage = screen.getByRole('link', { name: /5 communications need triage/ });
    expect(triage).toHaveAttribute('href', '/inbox');
  });

  it('marks a next step done from its checkbox', async () => {
    const api = mockApi({
      'GET /dashboard': payload,
      'PATCH /next-steps/step-1': { ...payload.dueNextSteps[0], doneAt: NOW },
    });
    const user = userEvent.setup();
    renderWithProviders(<Dashboard />);

    await user.click(await screen.findByRole('checkbox', { name: 'Done: Send thank-you note' }));
    await waitFor(() =>
      expect(api.calls).toContainEqual(
        expect.objectContaining({
          method: 'PATCH',
          path: '/next-steps/step-1',
          body: { done: true },
        }),
      ),
    );
  });

  it('shows empty states when there is nothing due or recent', async () => {
    mockApi({
      'GET /dashboard': {
        ...payload,
        dueNextSteps: [],
        recentActivity: [],
        needsTriage: { communications: 0 },
      },
    });
    renderWithProviders(<Dashboard />);
    expect(await screen.findByText('Nothing due in the next 7 days.')).toBeInTheDocument();
    expect(screen.getByText('No activity yet.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Inbox is clear/ })).toHaveAttribute('href', '/inbox');
  });
});
