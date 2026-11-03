// The submission detail screen (https://github.com/bgoleno/opportun/issues/149; design Part B S7,
// (d), (g)), against a stubbed API: one application, its destination, the resume copy that was
// used, what was reviewed and when, its status and evidence, and the outcome actions for every
// submitted or unknown attempt (the Tech Lead's case: an earlier attempt the Apply panel no
// longer offers them for).
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { formatDateTime, type OpportunityView } from '@/lib/opportunities';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import type { SubmissionView } from './api';
import { SubmissionDetail } from './SubmissionDetail';

const NOW = Date.now();
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const DEST = 'https://boards.greenhouse.io/examplecorp/jobs/1000001?gh_src=abc';

const OPP = {
  id: 'opp-1',
  companyName: 'Acme',
  title: 'Staff PM',
  stage: 'applied',
} as unknown as OpportunityView;

function attempt(over: Partial<SubmissionView> = {}): SubmissionView {
  return {
    id: 'sub-1',
    opportunityId: 'opp-1',
    resumeId: 'res-1',
    atsKind: 'ats_greenhouse',
    atsRef: 'examplecorp',
    atsExternalId: '1000001',
    destinationUrl: DEST,
    status: 'submitted',
    idempotencyKey: 'k1',
    resumeSha256: 'f00dfeed'.repeat(8),
    resumeTitle: 'Jane Final',
    resumeStore: 'google_doc',
    snapshotState: 'ready',
    resumeAttachmentId: 'att-snap',
    snapshotError: null,
    fields: { fullName: 'Jane Doe', email: 'jane@example.com' },
    answers: [
      { questionKey: 'question_1', label: 'Why Acme?', value: 'I like rockets.', source: 'user' },
    ],
    reviewDigest: 'a'.repeat(64),
    reviewExpiresAt: NOW - 3 * DAY + 30 * MIN,
    reviewedAt: NOW - 3 * DAY,
    handedOffAt: NOW - 3 * DAY + 5 * MIN,
    submittedAt: NOW - 3 * DAY + 20 * MIN,
    confirmedAt: null,
    confirmationKind: null,
    failureReason: null,
    reapplyOf: null,
    reapplyReason: null,
    postingChangedAt: null,
    submittedActivityId: 'act-1',
    createdAt: NOW - 3 * DAY - 10 * MIN,
    updatedAt: NOW - 3 * DAY + 20 * MIN,
    ...over,
  } as SubmissionView;
}

function render(sub: SubmissionView | (() => unknown), others: SubmissionView[] = []) {
  const api = mockApi({
    'GET /opportunities/opp-1': OPP,
    'GET /submissions/sub-1': sub,
    'GET /opportunities/opp-1/submissions': () => {
      const self = typeof sub === 'function' ? [] : [sub];
      const items = [...others, ...self];
      return { items, total: items.length };
    },
    // Wrapped: a bare submission's `status` would be read as the HTTP status.
    'POST /submissions/sub-1/outcome': () => ({
      status: 200,
      body: { ...(typeof sub === 'function' ? attempt() : sub), status: 'confirmed' },
    }),
  });
  const user = userEvent.setup();
  renderWithProviders(<SubmissionDetail opportunityId="opp-1" submissionId="sub-1" />);
  return { api, user };
}

describe('S7: what this application was', () => {
  it('names the company, the site, the requisition and when the user submitted it', async () => {
    const sub = attempt();
    render(sub);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Application to Acme' }),
    ).toBeVisible();
    expect(
      screen.getByText(
        `Greenhouse, 1000001. You reported submitting it on ${formatDateTime(sub.submittedAt as number)}.`,
      ),
    ).toBeVisible();
    expect(screen.getByText('Submission status:', { exact: false })).toBeInTheDocument();
  });

  it('shows the destination in full, and opens it safely', async () => {
    render(attempt());
    const link = await screen.findByRole('link', { name: DEST });
    expect(link).toHaveAttribute('href', DEST);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('shows the resume copy that was used, its download, and what deleting it does', async () => {
    render(attempt());
    const section = (await screen.findByRole('heading', { name: 'Resume used' })).closest(
      'section',
    ) as HTMLElement;
    expect(section).toHaveTextContent('Jane Final');
    expect(section).toHaveTextContent('f00dfeed');
    expect(within(section).getByRole('link', { name: /download the saved copy/i })).toHaveAttribute(
      'href',
      '/api/v1/submissions/sub-1/snapshot',
    );
    expect(section).toHaveTextContent(
      'This copy cannot change. You can delete it from Attachments',
    );
  });

  it('a deleted saved copy keeps its fingerprint and says so', async () => {
    render(attempt({ resumeAttachmentId: null }));
    const section = (await screen.findByRole('heading', { name: 'Resume used' })).closest(
      'section',
    ) as HTMLElement;
    expect(section).toHaveTextContent('The saved file was deleted. Its fingerprint is kept');
    expect(within(section).queryByRole('link', { name: /download/i })).not.toBeInTheDocument();
  });

  it('shows what was reviewed and when: every field and answer, and the re-apply reason', async () => {
    const sub = attempt({ reapplyReason: 'The first form errored out.' });
    render(sub);
    const section = (await screen.findByRole('heading', { name: 'What you reviewed' })).closest(
      'section',
    ) as HTMLElement;
    expect(section).toHaveTextContent(`Reviewed on ${formatDateTime(sub.reviewedAt as number)}`);
    for (const text of [
      'Full name',
      'Jane Doe',
      'jane@example.com',
      'Why Acme?',
      'I like rockets.',
    ]) {
      expect(section).toHaveTextContent(text);
    }
    expect(section).toHaveTextContent('Why you applied again: The first form errored out.');
  });

  it('lists the history in order, each step with its time', async () => {
    const sub = attempt({ status: 'confirmed', confirmationKind: 'user', confirmedAt: NOW - DAY });
    render(sub);
    const history = await screen.findByRole('list', { name: 'History' });
    const steps = within(history)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(steps).toEqual([
      expect.stringContaining('Started'),
      expect.stringContaining('Reviewed'),
      expect.stringContaining('Opened on the application site'),
      expect.stringContaining('Submitted (you reported it)'),
      expect.stringContaining('Confirmed (you marked it)'),
    ]);
    expect(steps[3]).toContain(formatDateTime(sub.submittedAt as number));
  });
});

describe('S7: status and evidence', () => {
  it.each([
    ['submitted', {}, 'Waiting for a confirmation.'],
    ['unknown', { status: 'unknown' }, 'No confirmation seen yet. This is not a failure.'],
    [
      'rejected',
      { status: 'rejected' },
      'The application site refused the form. Your stage was not changed.',
    ],
    [
      'failed',
      { status: 'failed', failureReason: 'other' },
      'This could not be completed. Nothing was submitted.',
    ],
    [
      'abandoned',
      { status: 'abandoned', failureReason: 'cancelled_by_user', submittedAt: null },
      'You stopped before submitting. Nothing was sent.',
    ],
  ] as const)('a %s attempt says what it means', async (_n, over, banner) => {
    render(attempt(over as Partial<SubmissionView>));
    expect(await screen.findByRole('status')).toHaveTextContent(banner);
  });

  it('a confirmation the user marked is evidence of their word only, and says so', async () => {
    const sub = attempt({ status: 'confirmed', confirmationKind: 'user', confirmedAt: NOW - DAY });
    render(sub);
    const evidence = (await screen.findByRole('heading', { name: 'Evidence' })).closest(
      'section',
    ) as HTMLElement;
    expect(evidence).toHaveTextContent(
      `You marked this confirmed on ${formatDateTime(NOW - DAY)}. No evidence attached.`,
    );
  });

  it('no confirmation yet: the evidence says there is none', async () => {
    render(attempt());
    const evidence = (await screen.findByRole('heading', { name: 'Evidence' })).closest(
      'section',
    ) as HTMLElement;
    expect(evidence).toHaveTextContent('No confirmation yet.');
  });
});

describe('S7: an email confirmation (#119)', () => {
  it('shows the email evidence card, with its unlink, instead of the one-line placeholder', async () => {
    render(
      attempt({
        status: 'confirmed',
        confirmationKind: 'email',
        confirmedAt: NOW - DAY,
        confirmationEmail: {
          communicationId: 'comm-1',
          subject: 'Application received',
          fromAddress: 'careers@examplecorp.example',
          sentAt: NOW - DAY,
          signals: ['ats_job_ref', 'time_window'],
        },
      }),
    );
    const evidence = (await screen.findByRole('heading', { name: 'Evidence' })).closest(
      'section',
    ) as HTMLElement;
    expect(evidence).toHaveTextContent('Application received');
    expect(
      within(evidence).getByRole('button', { name: 'Not this application (unlink)' }),
    ).toBeInTheDocument();
  });

  it('shows the recorded confirmation page, with its delete, instead of the one-line placeholder (#121)', async () => {
    render(
      attempt({
        status: 'confirmed',
        confirmationKind: 'page',
        confirmedAt: NOW - DAY,
        confirmationPage: {
          activityId: 'act-1',
          url: 'https://boards.greenhouse.io/examplecorp/jobs/123/confirmation',
          host: 'boards.greenhouse.io',
          recordedAt: NOW - DAY,
          text: 'Thank you for applying!',
        },
      }),
    );
    const evidence = (await screen.findByRole('heading', { name: 'Evidence' })).closest(
      'section',
    ) as HTMLElement;
    expect(
      within(evidence).getByRole('link', { name: 'boards.greenhouse.io' }),
    ).toBeInTheDocument();
    expect(
      within(evidence).getByRole('button', { name: 'Delete the recorded page' }),
    ).toBeInTheDocument();
  });
});

describe('S7: recording an outcome, for every submitted or unknown attempt (#149, tl)', () => {
  it('an earlier unknown attempt can be answered here while a newer one is submitted', async () => {
    const earlier = attempt({ status: 'unknown', submittedAt: NOW - 6 * DAY });
    const newer = attempt({ id: 'sub-2', status: 'submitted', submittedAt: NOW - DAY });
    const { api, user } = render(earlier, [newer]);
    await user.click(await screen.findByRole('button', { name: 'I saw a confirmation' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mark as confirmed?' });
    await user.click(within(dialog).getByRole('button', { name: 'Mark confirmed' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts(api.calls, '/submissions/sub-1/outcome')).toHaveLength(1);
    expect(posts(api.calls, '/submissions/sub-2/outcome')).toHaveLength(0);
  });

  it.each(['confirmed', 'rejected', 'failed', 'abandoned', 'draft', 'handed_off'] as const)(
    'a %s attempt offers no outcome actions',
    async (status) => {
      render(attempt({ status }));
      await screen.findByRole('heading', { level: 1 });
      expect(
        screen.queryByRole('button', { name: 'I saw a confirmation' }),
      ).not.toBeInTheDocument();
    },
  );

  it('lists the opportunity’s other applications, each linking to its own page', async () => {
    const newer = attempt({ id: 'sub-2', status: 'submitted', submittedAt: NOW - DAY });
    render(attempt({ status: 'unknown' }), [newer]);
    const others = await screen.findByRole('list', { name: 'Other applications for this role' });
    expect(within(others).getByRole('link')).toHaveAttribute(
      'href',
      '/opportunities/opp-1/applications/sub-2',
    );
  });
});

describe('S7: where it does not exist', () => {
  it('flag off or the demo: the screen says the feature is not available', async () => {
    render(() => ({ status: 404, body: { error: { code: 'feature_unavailable' } } }));
    expect(await screen.findByText('Assisted apply is not available here.')).toBeVisible();
  });

  it('another user’s application, or none: not found, and nothing of it shown', async () => {
    render(() => ({ status: 404, body: { error: { code: 'not_found' } } }));
    expect(await screen.findByText('This application was not found.')).toBeVisible();
    expect(screen.queryByRole('heading', { name: /Application to/ })).not.toBeInTheDocument();
  });

  it('an application of another opportunity, reached under this one: not found', async () => {
    render(attempt({ opportunityId: 'opp-9' }));
    expect(await screen.findByText('This application was not found.')).toBeVisible();
  });
});

function posts(calls: ApiCall[], path: string) {
  return calls.filter((c) => c.method === 'POST' && c.path === path);
}

describe('S7 follow-ups (#166; qa and tl on #163)', () => {
  it.each([
    ['no confirmation seen', { status: 'unknown' }, 'No confirmation seen'],
    ['refused', { status: 'rejected' }, 'The application site refused it'],
    ['failed', { status: 'failed', failureReason: 'other' }, 'Could not be completed'],
    ['stopped', { status: 'abandoned', failureReason: 'cancelled_by_user' }, 'Stopped'],
  ] as const)(
    'a %s attempt’s history ends with that end state, at its last change',
    async (_n, over, last) => {
      render(attempt({ ...(over as Partial<SubmissionView>), updatedAt: NOW - DAY }));
      const steps = within(await screen.findByRole('list', { name: 'History' }))
        .getAllByRole('listitem')
        .map((li) => li.textContent);
      expect(steps.at(-1)).toContain(last);
      expect(steps.at(-1)).toContain(formatDateTime(NOW - DAY));
    },
  );

  it('after an outcome, the page reads the attempt again and shows it', async () => {
    let current = attempt({ status: 'unknown' });
    const api = mockApi({
      'GET /opportunities/opp-1': OPP,
      'GET /submissions/sub-1': () => ({ status: 200, body: current }),
      'GET /opportunities/opp-1/submissions': () => ({ items: [current], total: 1 }),
      'POST /submissions/sub-1/outcome': () => {
        current = { ...current, status: 'confirmed', confirmationKind: 'user', confirmedAt: NOW };
        return { status: 200, body: current };
      },
    });
    const user = userEvent.setup();
    renderWithProviders(<SubmissionDetail opportunityId="opp-1" submissionId="sub-1" />);
    await user.click(await screen.findByRole('button', { name: 'I saw a confirmation' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mark as confirmed?' });
    const reads = api.calls.filter(
      (c) => c.method === 'GET' && c.path === '/submissions/sub-1',
    ).length;
    await user.click(within(dialog).getByRole('button', { name: 'Mark confirmed' }));
    await waitFor(() =>
      expect(
        api.calls.filter((c) => c.method === 'GET' && c.path === '/submissions/sub-1').length,
      ).toBeGreaterThan(reads),
    );
    expect(await screen.findByText(/You marked this confirmed on/)).toBeVisible();
    // Confirmed now: the actions are gone from the page.
    expect(screen.queryByRole('button', { name: 'I saw a confirmation' })).not.toBeInTheDocument();
  });

  it('a destination that is not http(s) is shown as text, never a link', async () => {
    render(attempt({ destinationUrl: 'javascript:alert(1)' }));
    const section = (await screen.findByRole('heading', { name: 'Where it went' })).closest(
      'section',
    ) as HTMLElement;
    expect(section).toHaveTextContent('javascript:alert(1)');
    expect(within(section).queryByRole('link')).not.toBeInTheDocument();
  });

  it('a refused attempt’s evidence says what was recorded, and when (#166)', async () => {
    render(attempt({ status: 'rejected', updatedAt: NOW - DAY }));
    const evidence = (await screen.findByRole('heading', { name: 'Evidence' })).closest(
      'section',
    ) as HTMLElement;
    expect(evidence).toHaveTextContent(
      `The application site refused the form on ${formatDateTime(NOW - DAY)}.`,
    );
    expect(evidence).not.toHaveTextContent('No confirmation yet');
  });
});

describe('test gaps (#172)', () => {
  // Only a refused attempt gets the dated refusal line (#166). A failed or stopped one, with no
  // confirmation, keeps "No confirmation yet.": widening the refusal's condition fails here.
  it.each([
    ['failed', { status: 'failed' }],
    ['stopped', { status: 'abandoned', failureReason: 'cancelled_by_user' }],
  ] as const)('a %s attempt keeps "No confirmation yet." as its evidence', async (_n, over) => {
    render(attempt({ ...over, updatedAt: NOW - DAY }));
    const evidence = (await screen.findByRole('heading', { name: 'Evidence' })).closest(
      'section',
    ) as HTMLElement;
    expect(evidence).toHaveTextContent('No confirmation yet.');
    expect(evidence).not.toHaveTextContent('refused the form');
  });
});
