// Assisted apply M1d (https://github.com/bgoleno/opportun/issues/117): the panel, the steps, the
// review gate and the handoff, against a stubbed API. Criteria: 1 the review shows everything,
// unticked; 2 any edit goes back to review; 3 a clock time, not a countdown; 4 keyboard and
// screen-reader paths; 5 nothing of the feature where it is off.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DetailsPanel } from '@/components/opportunity/DetailsPanel';
import { OpportunityDetail } from '@/components/opportunity/OpportunityDetail';
import type { OpportunityView } from '@/lib/opportunities';
import { parseApplySearch } from '@/routes/opportunities.$id_.apply';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import { ApplyPage } from './ApplyPage';
import { clockTime, type SubmissionView } from './api';
import { ApplyPanel } from './ApplyPanel';

const NOW = Date.now();
const MIN = 60 * 1000;
const DIGEST = 'a'.repeat(64);
// The full address, query included: the review must show exactly this (tl's S4 musts).
const DEST = 'https://boards.greenhouse.io/examplecorp/jobs/1000001?gh_src=abc&utm_source=x';

const OPP = {
  id: 'opp-1',
  userId: 'u1',
  companyId: 'c1',
  companyName: 'Acme',
  companyDomain: null,
  title: 'Staff PM',
  stage: 'preparing',
  sourceKind: 'manual',
  priority: 2,
  sortOrder: 0,
  postingUrl: DEST,
  location: 'Remote',
  descriptionMd: null,
  possibleDuplicates: [],
  descriptionIsUserWritten: false,
  hasCapturedPage: false,
  lastActivityAt: null,
  postingState: 'confirmed',
  atsJobRef: { kind: 'ats_greenhouse', org: 'examplecorp', externalId: '1000001', url: DEST },
  createdAt: NOW,
  updatedAt: NOW,
} as unknown as OpportunityView;

const RESUME = {
  id: 'res-1',
  kind: 'base',
  opportunityId: null,
  title: 'Jane Final',
  store: 'google_doc',
  docRef: 'Doc_0123456789',
  url: 'https://docs.google.com/document/d/Doc_0123456789/edit',
  parentResumeId: null,
  status: 'final',
  archivedAt: null,
  submittedAt: null,
  submittedTo: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function submission(over: Partial<SubmissionView> = {}): SubmissionView {
  return {
    id: 'sub-1',
    opportunityId: 'opp-1',
    resumeId: 'res-1',
    atsKind: 'ats_greenhouse',
    atsRef: 'examplecorp',
    atsExternalId: '1000001',
    destinationUrl: DEST,
    status: 'draft',
    idempotencyKey: 'k1',
    resumeSha256: 'f00dfeed'.repeat(8),
    resumeTitle: 'Jane Final',
    resumeStore: 'google_doc',
    fields: { fullName: 'Jane Doe', email: 'jane@example.com' },
    answers: [
      { questionKey: 'question_1', label: 'Why Acme?', value: 'I like rockets.', source: 'user' },
      { questionKey: 'question_2', label: 'Notice period?', value: 'Two weeks', source: 'user' },
    ],
    reviewExpiresAt: null,
    reviewedAt: null,
    handedOffAt: null,
    submittedAt: null,
    confirmedAt: null,
    confirmationKind: null,
    failureReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    reviewDigest: DIGEST,
    snapshotState: 'ready',
    snapshotError: null,
    resumeAttachmentId: 'att-snap',
    ...over,
  } as SubmissionView;
}

function routes(sub: SubmissionView | null, extra: Record<string, unknown> = {}) {
  return {
    'GET /opportunities/opp-1': OPP,
    'GET /resumes': { items: [RESUME], total: 1 },
    'GET /opportunities/opp-1/submissions':
      sub === null ? { items: [], total: 0 } : { items: [sub], total: 1 },
    ...extra,
  };
}

interface FakeTab {
  opener: unknown;
  location: { href: string };
  close: ReturnType<typeof vi.fn>;
}

function fakeWindowOpen(blocked = false): { tab: FakeTab; open: ReturnType<typeof vi.spyOn> } {
  const tab: FakeTab = { opener: window, location: { href: 'about:blank' }, close: vi.fn() };
  const open = vi
    .spyOn(window, 'open')
    .mockImplementation(() => (blocked ? null : (tab as unknown as Window)));
  return { tab, open };
}

function renderStep(step: 'resume' | 'details' | 'review' | 'open', blocked = false) {
  const user = userEvent.setup();
  const out = renderWithProviders(
    <ApplyPage opportunityId="opp-1" step={step} blocked={blocked} />,
    { path: `/opportunities/opp-1/apply?step=${step}` },
  );
  return { user, ...out };
}

const calls = (all: ApiCall[], method: string, path: string) =>
  all.filter((c) => c.method === method && c.path === path);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('criterion 5: nothing of the feature where it is off', () => {
  it('the opportunity page shows no Assisted apply card, teaser or link when the routes answer 404', async () => {
    mockApi({
      'GET /opportunities/opp-1': OPP,
      'GET /opportunities/opp-1/timeline': { items: [], total: 0 },
      'GET /opportunities/opp-1/next-steps': { items: [], total: 0 },
      'GET /resumes': { items: [RESUME], total: 1 },
      'GET /opportunities/opp-1/submissions': () => ({
        status: 404,
        body: { error: { code: 'feature_unavailable' } },
      }),
    });
    renderWithProviders(<OpportunityDetail id="opp-1" />);
    expect(await screen.findByRole('heading', { name: 'Staff PM' })).toBeInTheDocument();
    await screen.findByText(/next steps/i);
    expect(screen.queryByText(/assisted apply/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/apply on/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /apply/i })).not.toBeInTheDocument();
  });

  it('the panel renders nothing at all on a 404', async () => {
    const api = mockApi({
      'GET /resumes': { items: [RESUME], total: 1 },
      'GET /opportunities/opp-1/submissions': () => ({
        status: 404,
        body: { error: { code: 'feature_unavailable' } },
      }),
    });
    const { container } = renderWithProviders(<ApplyPanel opp={OPP} />);
    await waitFor(() =>
      expect(calls(api.calls, 'GET', '/opportunities/opp-1/submissions')).toHaveLength(1),
    );
    expect(container.textContent).toBe('');
  });

  it('the opportunity page shows the card in the rail when the feature is on', async () => {
    mockApi({
      'GET /opportunities/opp-1/timeline': { items: [], total: 0 },
      'GET /opportunities/opp-1/next-steps': { items: [], total: 0 },
      ...routes(null),
    });
    renderWithProviders(<OpportunityDetail id="opp-1" />);
    const card = await screen.findByRole('region', { name: 'Assisted apply' });
    expect(within(card).getByRole('link', { name: 'Apply on Greenhouse' })).toHaveAttribute(
      'href',
      '/opportunities/opp-1/apply?step=resume',
    );
  });
});

describe('S1: the panel', () => {
  it('says why it cannot start, and keeps the button reachable (aria-disabled, not disabled)', async () => {
    mockApi({
      'GET /resumes': { items: [], total: 0 },
      'GET /opportunities/opp-1/submissions': { items: [], total: 0 },
    });
    renderWithProviders(<ApplyPanel opp={OPP} />);
    const button = await screen.findByRole('button', { name: 'Apply on Greenhouse' });
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAccessibleDescription('Attach a final resume first.');
  });

  it('shows an attempt in progress with its status in words', async () => {
    mockApi(routes(submission({ status: 'reviewed', reviewExpiresAt: NOW + 20 * MIN })));
    renderWithProviders(<ApplyPanel opp={OPP} />);
    expect(await screen.findByText('Submission status:', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('Reviewed')).toBeInTheDocument();
  });
});

describe('S2: the resume step', () => {
  it('creates the draft with the chosen final resume, then goes to details', async () => {
    const api = mockApi(
      routes(null, {
        'POST /opportunities/opp-1/submissions': () => ({ status: 201, body: submission() }),
      }),
    );
    const { user, router } = renderStep('resume');
    await user.click(await screen.findByRole('button', { name: 'Next: Details' }));
    await waitFor(() => expect(router.state.location.search).toEqual({ step: 'details' }));
    const [create] = calls(api.calls, 'POST', '/opportunities/opp-1/submissions');
    expect(create?.body).toMatchObject({ resumeId: 'res-1' });
  });

  it('a deleted saved file says the fingerprint is kept, and offers no download', async () => {
    mockApi(routes(submission({ resumeAttachmentId: null })));
    renderStep('resume');
    expect(await screen.findByText(/the saved file was deleted/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /download copy/i })).not.toBeInTheDocument();
  });
});

describe('criterion 1: the review shows everything, and the confirm starts unticked', () => {
  it('destination (whole address), resume, every field and every answer, none collapsed', async () => {
    mockApi(routes(submission()));
    renderStep('review');
    expect(await screen.findByText(DEST)).toBeVisible();
    expect(screen.getByText('1000001')).toBeVisible();
    expect(screen.getByText('Jane Final')).toBeVisible();
    for (const text of ['Jane Doe', 'jane@example.com', 'Why Acme?', 'I like rockets.']) {
      expect(screen.getByText(text)).toBeVisible();
    }
    expect(screen.getByText('Notice period?')).toBeVisible();
    expect(screen.getByText('Two weeks')).toBeVisible();
    // Nothing is behind a disclosure.
    expect(document.querySelector('details, [aria-expanded="false"]')).toBeNull();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('confirming unticked does nothing but say why and move focus to the box', async () => {
    const api = mockApi(routes(submission()));
    const { open } = fakeWindowOpen();
    const { user } = renderStep('review');
    const confirm = await screen.findByRole('button', {
      name: 'Confirm review and open boards.greenhouse.io',
    });
    expect(confirm).toHaveAttribute('aria-disabled', 'true');
    await user.click(confirm);
    expect(screen.getByRole('checkbox')).toHaveFocus();
    expect(confirm).toHaveAccessibleDescription('Tick the box to continue.');
    expect(open).not.toHaveBeenCalled();
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('ticked: reviews with the digest it showed, hands off, then opens exactly the returned address', async () => {
    const reviewed = submission({ status: 'reviewed', reviewExpiresAt: NOW + 30 * MIN });
    const api = mockApi(
      routes(submission(), {
        'POST /submissions/sub-1/review': reviewed,
        'POST /submissions/sub-1/handoff': { destinationUrl: DEST, expiresAt: NOW },
      }),
    );
    const { tab, open } = fakeWindowOpen();
    const { user, router } = renderStep('review');
    await user.click(await screen.findByRole('checkbox'));
    await user.click(
      screen.getByRole('button', { name: 'Confirm review and open boards.greenhouse.io' }),
    );
    await waitFor(() => expect(router.state.location.search).toEqual({ step: 'open' }));
    expect(calls(api.calls, 'POST', '/submissions/sub-1/review')[0]?.body).toEqual({
      reviewDigest: DIGEST,
      acknowledged: true,
    });
    expect(calls(api.calls, 'POST', '/submissions/sub-1/handoff')).toHaveLength(1);
    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(tab.opener).toBeNull();
    expect(tab.location.href).toBe(DEST);
  });

  it('a blocked pop-up still hands off, and says so on the next step', async () => {
    mockApi(
      routes(submission(), {
        'POST /submissions/sub-1/review': submission({ status: 'reviewed' }),
        'POST /submissions/sub-1/handoff': { destinationUrl: DEST, expiresAt: NOW },
      }),
    );
    fakeWindowOpen(true);
    const { user, router } = renderStep('review');
    await user.click(await screen.findByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /confirm review/i }));
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ step: 'open', blocked: true }),
    );
  });
});

describe('refusals at the gate: one request each, no retry loop, no tab left open', () => {
  async function refusedWith(status: number, error: Record<string, unknown>) {
    const api = mockApi(
      routes(submission(), {
        'POST /submissions/sub-1/review': () => ({ status, body: { error } }),
      }),
    );
    const { tab } = fakeWindowOpen();
    const { user } = renderStep('review');
    await user.click(await screen.findByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /confirm review/i }));
    await waitFor(() => expect(tab.close).toHaveBeenCalled());
    expect(calls(api.calls, 'POST', '/submissions/sub-1/review')).toHaveLength(1);
    expect(calls(api.calls, 'POST', '/submissions/sub-1/handoff')).toHaveLength(0);
    expect(tab.location.href).toBe('about:blank');
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    return api;
  }

  it('409 review_stale: says something changed, and refreshes the digest it holds', async () => {
    const api = await refusedWith(409, { code: 'review_stale' });
    expect(await screen.findByText(/something changed while you were reviewing/i)).toBeVisible();
    await waitFor(() =>
      expect(calls(api.calls, 'GET', '/opportunities/opp-1/submissions').length).toBeGreaterThan(1),
    );
  });

  it('429 daily_review_cap: the reset time, and the draft is kept', async () => {
    const resetAt = NOW + 5 * 60 * MIN;
    await refusedWith(429, { code: 'daily_review_cap', resetAt });
    const alert = await screen.findByText(/review limit reached for today/i);
    expect(alert.closest('[role="alert"]')).toHaveTextContent(/your draft is saved/i);
  });

  it('409 review_expired at handoff: back to review, with the time it expired', async () => {
    const expiresAt = NOW + 30 * MIN;
    const api = mockApi(
      routes(submission({ status: 'reviewed', reviewExpiresAt: expiresAt }), {
        'POST /submissions/sub-1/handoff': () => ({
          status: 409,
          body: { error: { code: 'review_expired' } },
        }),
      }),
    );
    const { tab } = fakeWindowOpen();
    const { user } = renderStep('review');
    await user.click(await screen.findByRole('button', { name: 'Open boards.greenhouse.io' }));
    expect(
      await screen.findByText(`Your review expired at ${clockTime(expiresAt)}.`),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Review again' })).toBeVisible();
    expect(tab.close).toHaveBeenCalled();
    expect(calls(api.calls, 'POST', '/submissions/sub-1/handoff')).toHaveLength(1);
  });

  it('422 destination_not_allowed: says plainly the address cannot be opened from here', async () => {
    const api = mockApi(
      routes(submission({ status: 'reviewed', reviewExpiresAt: NOW + 30 * MIN }), {
        'POST /submissions/sub-1/handoff': () => ({
          status: 422,
          body: { error: { code: 'destination_not_allowed' } },
        }),
      }),
    );
    const { tab } = fakeWindowOpen();
    const { user } = renderStep('review');
    await user.click(await screen.findByRole('button', { name: 'Open boards.greenhouse.io' }));
    expect(
      await screen.findByText(/this posting's address cannot be opened from here/i),
    ).toBeVisible();
    expect(tab.location.href).toBe('about:blank');
    expect(calls(api.calls, 'POST', '/submissions/sub-1/handoff')).toHaveLength(1);
  });
});

describe('criterion 2: any edit goes back to review', () => {
  it('an edit to a reviewed attempt is saved, and the next step is the review', async () => {
    const reviewed = submission({ status: 'reviewed', reviewExpiresAt: NOW + 30 * MIN });
    const api = mockApi(
      routes(reviewed, {
        // Wrapped: a bare body with a `status` key would be read as the HTTP status.
        'PATCH /submissions/sub-1': (c: ApiCall) => ({
          status: 200,
          body: { ...reviewed, ...(c.body as object), status: 'draft', reviewExpiresAt: null },
        }),
      }),
    );
    const { user, router } = renderStep('details');
    const answer = await screen.findByLabelText('Your answer', { selector: '#q-value-0' });
    await user.clear(answer);
    await user.type(answer, 'I like rockets a lot.');
    await user.click(screen.getByRole('button', { name: 'Next: Review' }));
    await waitFor(() => expect(router.state.location.search).toEqual({ step: 'review' }));
    const [edit] = calls(api.calls, 'PATCH', '/submissions/sub-1');
    expect(edit?.body).toMatchObject({
      answers: [
        expect.objectContaining({ value: 'I like rockets a lot.' }),
        expect.objectContaining({ value: 'Two weeks' }),
      ],
    });
  });

  it('no change: no write, so a valid review is kept', async () => {
    const api = mockApi(
      routes(submission({ status: 'reviewed', reviewExpiresAt: NOW + 30 * MIN })),
    );
    const { user, router } = renderStep('details');
    await user.click(await screen.findByRole('button', { name: 'Next: Review' }));
    await waitFor(() => expect(router.state.location.search).toEqual({ step: 'review' }));
    expect(calls(api.calls, 'PATCH', '/submissions/sub-1')).toHaveLength(0);
  });
});

describe('criterion 3: the expiry is a clock time, not a countdown', () => {
  it('a valid review says until when, as a time, and nothing ticks', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const until = NOW + 30 * MIN;
      mockApi(routes(submission({ status: 'reviewed', reviewExpiresAt: until })));
      renderStep('review');
      const line = await screen.findByText(/It stays valid until/);
      expect(line).toHaveTextContent(`It stays valid until ${clockTime(until)}.`);
      const before = document.body.textContent;
      vi.advanceTimersByTime(61 * 1000);
      expect(document.body.textContent).toBe(before);
      expect(document.body.textContent).not.toMatch(/minutes? (left|remaining)|seconds?/i);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('criterion 4: keyboard and screen-reader paths', () => {
  it('each step moves focus to its heading', async () => {
    mockApi(routes(submission()));
    renderStep('review');
    const heading = await screen.findByRole('heading', {
      level: 1,
      name: 'Check everything before you open the form',
    });
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it('the whole gate works from the keyboard alone', async () => {
    mockApi(
      routes(submission(), {
        'POST /submissions/sub-1/review': submission({ status: 'reviewed' }),
        'POST /submissions/sub-1/handoff': { destinationUrl: DEST, expiresAt: NOW },
      }),
    );
    const { tab } = fakeWindowOpen();
    const { user, router } = renderStep('review');
    const box = await screen.findByRole('checkbox', { name: /I will press Submit myself/ });
    box.focus();
    await user.keyboard(' ');
    expect(box).toBeChecked();
    await user.tab();
    expect(screen.getByRole('button', { name: /confirm review/i })).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(router.state.location.search).toEqual({ step: 'open' }));
    expect(tab.location.href).toBe(DEST);
  });

  it('the stepper names the current step for assistive technology', async () => {
    mockApi(routes(submission()));
    renderStep('review');
    await screen.findByRole('heading', { level: 1 });
    expect(document.querySelector('[aria-current="step"]')).toHaveTextContent(/review/i);
  });
});

describe('S5: open the form', () => {
  it('says nothing was submitted, offers the link again, and the details to copy', async () => {
    mockApi(routes(submission({ status: 'handed_off', handedOffAt: NOW })));
    renderStep('open');
    expect(await screen.findByText(/Opportun has not submitted anything/)).toBeVisible();
    const again = screen.getByRole('link', { name: /open boards\.greenhouse\.io/i });
    expect(again).toHaveAttribute('href', DEST);
    expect(again).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(screen.getByRole('button', { name: 'Copy Why Acme?' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Copy Full name' })).toBeVisible();
  });

  it('a blocked tab is an alert with the link to open it yourself', async () => {
    mockApi(routes(submission({ status: 'handed_off', handedOffAt: NOW })));
    renderStep('open', true);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/your browser blocked the new tab/i);
    expect(within(alert).getByRole('link')).toHaveAttribute('href', DEST);
  });
});

describe('the route', () => {
  it('starts at the resume step for a missing or unknown step, and only takes blocked from the open step', () => {
    expect(parseApplySearch({})).toEqual({ step: 'resume' });
    expect(parseApplySearch({ step: 'submit' })).toEqual({ step: 'resume' });
    expect(parseApplySearch({ step: 'review' })).toEqual({ step: 'review' });
    expect(parseApplySearch({ step: 'open', blocked: true })).toEqual({
      step: 'open',
      blocked: true,
    });
    expect(parseApplySearch({ step: 'open', blocked: 'yes' })).toEqual({ step: 'open' });
  });
});

describe('deleting the resume snapshot (tl on #115, sec on #131)', () => {
  const SNAPSHOT = {
    id: 'att-snap',
    userId: 'u1',
    opportunityId: 'opp-1',
    filename: 'Jane Final.pdf',
    mime: 'application/pdf',
    bytes: 2048,
    sha256: 'x',
    createdAt: NOW,
  };
  const OTHER = { ...SNAPSHOT, id: 'att-other', filename: 'offer-letter.pdf' };

  function setupDetails(sub: SubmissionView | null) {
    const api = mockApi({
      'GET /opportunities/opp-1/attachments': { items: [SNAPSHOT, OTHER], total: 2 },
      'GET /opportunities/opp-1/submissions':
        sub === null
          ? () => ({ status: 404, body: { error: { code: 'feature_unavailable' } } })
          : { items: [sub], total: 1 },
      'DELETE /attachments/att-snap': () => ({ status: 204 }),
      'DELETE /attachments/att-other': () => ({ status: 204 }),
    });
    const user = userEvent.setup();
    renderWithProviders(<DetailsPanel opp={OPP} />);
    return { api, user };
  }

  it('a snapshot an application names: the confirm says what goes and what is kept', async () => {
    const { api, user } = setupDetails(submission());
    await user.click(await screen.findByRole('button', { name: 'Delete Jane Final.pdf' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete this resume snapshot?')).toBeVisible();
    expect(dialog).toHaveTextContent(/cannot be changed, but you can delete it/i);
    expect(dialog).toHaveTextContent(/keeps its fingerprint and title/i);
    const before = calls(api.calls, 'GET', '/opportunities/opp-1/submissions').length;
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(calls(api.calls, 'DELETE', '/attachments/att-snap')).toHaveLength(1),
    );
    // The server cleared the reference: the attempt is read again.
    await waitFor(() =>
      expect(calls(api.calls, 'GET', '/opportunities/opp-1/submissions').length).toBeGreaterThan(
        before,
      ),
    );
  });

  it('any other file keeps the plain confirm', async () => {
    const { user } = setupDetails(submission());
    await user.click(await screen.findByRole('button', { name: 'Delete offer-letter.pdf' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete this file?')).toBeVisible();
    expect(dialog).toHaveTextContent('offer-letter.pdf will be deleted.');
  });

  it('with the feature off, the snapshot is an ordinary file', async () => {
    const { user } = setupDetails(null);
    await user.click(await screen.findByRole('button', { name: 'Delete Jane Final.pdf' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete this file?')).toBeVisible();
  });
});

describe('the saved copy at the review gate (#115: 409 snapshot_pending, snapshot_failed)', () => {
  it('pending: says so, keeps confirm off even ticked, and turns it on once the copy is ready', async () => {
    let reads = 0;
    const api = mockApi({
      ...routes(null),
      'GET /opportunities/opp-1/submissions': () => {
        reads += 1;
        const sub = submission({ snapshotState: reads < 2 ? 'pending' : 'ready' });
        return { items: [sub], total: 1 };
      },
    });
    const { open } = fakeWindowOpen();
    const { user } = renderStep('review');
    const status = await screen.findByText(
      'Still preparing your resume file. The Confirm button turns on when it is ready.',
      { selector: '[role="status"]' },
    );
    expect(status).toBeVisible();
    await user.click(screen.getByRole('checkbox'));
    const confirm = screen.getByRole('button', { name: /confirm review/i });
    expect(confirm).toHaveAttribute('aria-disabled', 'true');
    await user.click(confirm);
    expect(open).not.toHaveBeenCalled();
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    // The list is read again while the copy is pending; once ready, confirm turns on.
    await waitFor(() => expect(confirm).not.toHaveAttribute('aria-disabled'), { timeout: 6000 });
    expect(screen.queryByText(/still preparing your resume file/i)).not.toBeInTheDocument();
  });

  it('failed: an alert with the reason and the way back to the resume step', async () => {
    mockApi(routes(submission({ snapshotState: 'failed', snapshotError: 'no_access' })));
    const { user } = renderStep('review');
    const alert = (
      await screen.findByText('Opportun could not save a PDF of this resume.')
    ).closest('[role="alert"]') as HTMLElement;
    expect(alert).toHaveTextContent(/can no longer open this document/i);
    expect(within(alert).getByRole('link', { name: 'Go to the resume step' })).toHaveAttribute(
      'href',
      '/opportunities/opp-1/apply?step=resume',
    );
    await user.click(screen.getByRole('checkbox'));
    const confirm = screen.getByRole('button', { name: /confirm review/i });
    expect(confirm).toHaveAttribute('aria-disabled', 'true');
  });

  it('refused by the server as pending: no error banner, the refreshed state says why', async () => {
    let reads = 0;
    mockApi({
      ...routes(null),
      'GET /opportunities/opp-1/submissions': () => {
        reads += 1;
        // The screen read `ready`; the server has since gone back to preparing the copy.
        const sub = submission({ snapshotState: reads < 2 ? 'ready' : 'pending' });
        return { items: [sub], total: 1 };
      },
      'POST /submissions/sub-1/review': () => ({
        status: 409,
        body: { error: { code: 'snapshot_pending' } },
      }),
    });
    const { tab } = fakeWindowOpen();
    const { user } = renderStep('review');
    await user.click(await screen.findByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /confirm review/i }));
    await waitFor(() => expect(tab.close).toHaveBeenCalled());
    expect(
      await screen.findByText(/still preparing your resume file/i, {
        selector: '[role="status"]',
      }),
    ).toBeVisible();
    expect(screen.queryByText(/could not save your review/i)).not.toBeInTheDocument();
  });
});

describe('tl on #138', () => {
  it('(1) a double click on a valid review opens one tab and hands off once', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const api = mockApi(
      routes(submission({ status: 'reviewed', reviewExpiresAt: NOW + 30 * MIN }), {
        'POST /submissions/sub-1/handoff': async () => {
          await held;
          return { destinationUrl: DEST, expiresAt: NOW };
        },
      }),
    );
    const { open } = fakeWindowOpen();
    const { user, router } = renderStep('review');
    const button = await screen.findByRole('button', { name: 'Open boards.greenhouse.io' });
    await user.dblClick(button);
    await user.click(button);
    release();
    await waitFor(() => expect(router.state.location.search).toEqual({ step: 'open' }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(calls(api.calls, 'POST', '/submissions/sub-1/handoff')).toHaveLength(1);
  });

  it('(1) a double click on a first confirm reviews once and hands off once', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const api = mockApi(
      routes(submission(), {
        'POST /submissions/sub-1/review': async () => {
          await held;
          // Wrapped: a bare submission's `status` would be read as the HTTP status.
          return {
            status: 200,
            body: submission({ status: 'reviewed', reviewExpiresAt: NOW + 30 * MIN }),
          };
        },
        'POST /submissions/sub-1/handoff': { destinationUrl: DEST, expiresAt: NOW },
      }),
    );
    const { open } = fakeWindowOpen();
    const { user, router } = renderStep('review');
    await user.click(await screen.findByRole('checkbox'));
    const button = screen.getByRole('button', { name: /confirm review/i });
    await user.dblClick(button);
    release();
    await waitFor(() => expect(router.state.location.search).toEqual({ step: 'open' }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(calls(api.calls, 'POST', '/submissions/sub-1/review')).toHaveLength(1);
    expect(calls(api.calls, 'POST', '/submissions/sub-1/handoff')).toHaveLength(1);
  });

  it('(2) a create refused with live_submission_exists says so in words and shows the attempt', async () => {
    let reads = 0;
    const api = mockApi({
      ...routes(null),
      // Another tab started an attempt after this page loaded.
      'GET /opportunities/opp-1/submissions': () => {
        reads += 1;
        return reads < 2
          ? { items: [], total: 0 }
          : { items: [submission({ resumeId: 'res-1' })], total: 1 };
      },
      'POST /opportunities/opp-1/submissions': () => ({
        status: 409,
        body: { error: { code: 'live_submission_exists', submissionId: 'sub-1' } },
      }),
    });
    const { user } = renderStep('resume');
    await user.click(await screen.findByRole('button', { name: 'Next: Details' }));
    expect(await screen.findByText(/already has an application in progress/i)).toBeVisible();
    expect(document.body.textContent).not.toContain('live_submission_exists');
    await waitFor(() =>
      expect(calls(api.calls, 'GET', '/opportunities/opp-1/submissions').length).toBeGreaterThan(1),
    );
    // The attempt that exists is now the page's: the saved copy it carries is shown.
    expect(await screen.findByRole('link', { name: /download the saved copy/i })).toBeVisible();
  });

  it('(2) a refused edit says so in words, never the code', async () => {
    mockApi(
      routes(submission(), {
        'PATCH /submissions/sub-1': () => ({
          status: 409,
          body: { error: { code: 'invalid_transition' } },
        }),
      }),
    );
    const { user } = renderStep('details');
    await user.type(await screen.findByLabelText('Phone'), '555 0100');
    await user.click(screen.getByRole('button', { name: 'Next: Review' }));
    expect(await screen.findByText(/changed in another tab or window/i)).toBeVisible();
    expect(document.body.textContent).not.toContain('invalid_transition');
  });

  it('(3) the review shows the saved copy itself: its download, and what can and cannot change', async () => {
    mockApi(routes(submission()));
    renderStep('review');
    const section = (await screen.findByRole('heading', { name: 'Resume' })).closest(
      'section',
    ) as HTMLElement;
    expect(within(section).getByText('Jane Final')).toBeVisible();
    expect(within(section).getByRole('link', { name: /download the saved copy/i })).toHaveAttribute(
      'href',
      '/api/v1/submissions/sub-1/snapshot',
    );
    expect(section).toHaveTextContent(/this copy cannot change/i);
    expect(section).toHaveTextContent(/delete it from Attachments/i);
  });

  it.each([
    [
      'unsupported',
      { snapshotState: 'unsupported', snapshotError: 'export_unsupported' },
      /attach the resume file yourself/i,
    ],
    ['deleted', { resumeAttachmentId: null }, /the saved file was deleted/i],
  ] as const)('(3) the review says so when the saved copy is %s', async (_n, over, text) => {
    mockApi(routes(submission(over as Partial<SubmissionView>)));
    renderStep('review');
    const section = (await screen.findByRole('heading', { name: 'Resume' })).closest(
      'section',
    ) as HTMLElement;
    expect(section).toHaveTextContent(text);
    expect(within(section).queryByRole('link', { name: /download/i })).not.toBeInTheDocument();
  });

  it('(4) a handoff refused as invalid_transition says the attempt changed, not the connection', async () => {
    mockApi(
      routes(submission({ status: 'reviewed', reviewExpiresAt: NOW + 30 * MIN }), {
        'POST /submissions/sub-1/handoff': () => ({
          status: 409,
          body: { error: { code: 'invalid_transition' } },
        }),
      }),
    );
    const { tab } = fakeWindowOpen();
    const { user } = renderStep('review');
    await user.click(await screen.findByRole('button', { name: 'Open boards.greenhouse.io' }));
    expect(await screen.findByText(/changed in another tab or window/i)).toBeVisible();
    expect(screen.queryByText(/check your connection/i)).not.toBeInTheDocument();
    expect(tab.close).toHaveBeenCalled();
  });

  it('(4) a review the sweep closed says so, with the way to start again', async () => {
    mockApi(routes(submission({ status: 'abandoned', failureReason: 'review_expired' })));
    renderStep('review');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/your review expired and this application was closed/i);
    expect(within(alert).getByRole('link', { name: 'resume step' })).toHaveAttribute(
      'href',
      '/opportunities/opp-1/apply?step=resume',
    );
  });

  it('(4) Review again that is refused shows why', async () => {
    mockApi(
      routes(submission({ status: 'reviewed', reviewExpiresAt: NOW - MIN }), {
        'PATCH /submissions/sub-1': () => ({
          status: 409,
          body: { error: { code: 'invalid_transition' } },
        }),
      }),
    );
    const { user } = renderStep('review');
    await user.click(await screen.findByRole('button', { name: 'Review again' }));
    expect(await screen.findByText(/changed in another tab or window/i)).toBeVisible();
  });

  it('(4) Try again on a failed copy that is refused shows why', async () => {
    mockApi(
      routes(submission({ snapshotState: 'failed', snapshotError: 'unavailable' }), {
        'PATCH /submissions/sub-1': () => ({
          status: 429,
          body: { error: { code: 'rate_limited' } },
        }),
      }),
    );
    const { user } = renderStep('resume');
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/too many attempts/i)).toBeVisible();
  });

  it('(5) a handoff address that is not http(s) never reaches the tab', async () => {
    mockApi(
      routes(submission({ status: 'reviewed', reviewExpiresAt: NOW + 30 * MIN }), {
        'POST /submissions/sub-1/handoff': {
          destinationUrl: 'javascript:alert(1)',
          expiresAt: NOW,
        },
      }),
    );
    const { tab } = fakeWindowOpen();
    const { user, router } = renderStep('review');
    await user.click(await screen.findByRole('button', { name: 'Open boards.greenhouse.io' }));
    expect(
      await screen.findByText(/this posting's address cannot be opened from here/i),
    ).toBeVisible();
    expect(tab.location.href).toBe('about:blank');
    expect(tab.close).toHaveBeenCalled();
    expect(router.state.location.search).toEqual({ step: 'review' });
  });

  it('(optional) after the daily cap, confirm stays off until the reset time', async () => {
    const resetAt = NOW + 5 * 60 * MIN;
    const api = mockApi(
      routes(submission(), {
        'POST /submissions/sub-1/review': () => ({
          status: 429,
          body: { error: { code: 'daily_review_cap', resetAt } },
        }),
      }),
    );
    fakeWindowOpen();
    const { user } = renderStep('review');
    await user.click(await screen.findByRole('checkbox'));
    const button = screen.getByRole('button', { name: /confirm review/i });
    await user.click(button);
    await screen.findByText(/review limit reached for today/i);
    await user.click(screen.getByRole('checkbox'));
    expect(button).toHaveAttribute('aria-disabled', 'true');
    await user.click(button);
    expect(calls(api.calls, 'POST', '/submissions/sub-1/review')).toHaveLength(1);
  });
});
