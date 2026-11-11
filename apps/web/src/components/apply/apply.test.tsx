// Assisted apply M1d (https://github.com/bgoleno/opportun/issues/117): the panel, the steps, the
// review gate and the handoff, against a stubbed API. Criteria: 1 the review shows everything,
// unticked; 2 any edit goes back to review; 3 a clock time, not a countdown; 4 keyboard and
// screen-reader paths; 5 nothing of the feature where it is off.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DetailsPanel } from '@/components/opportunity/DetailsPanel';
import { OpportunityDetail } from '@/components/opportunity/OpportunityDetail';
import { formatDate, formatDateTime, type OpportunityView } from '@/lib/opportunities';
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

// https://github.com/bgoleno/opportun/issues/395: a refused Apply button looked enabled and a click
// did nothing at all. It must look disabled, stay reachable, show its own reason next to it, and
// say so when clicked.
const TAILORED_IN_REVIEW = {
  ...RESUME,
  id: 'res-2',
  kind: 'tailored',
  opportunityId: 'opp-1',
  title: 'Acme tailored',
  status: 'in_review',
};

describe('#395: a refused Apply button says why, and never swallows a click', () => {
  function renderRefused(opp: OpportunityView, resumes: unknown[] = [RESUME]) {
    const api = mockApi({
      'GET /resumes': { items: resumes, total: resumes.length },
      'GET /opportunities/opp-1/submissions': { items: [], total: 0 },
    });
    const user = userEvent.setup();
    renderWithProviders(<ApplyPanel opp={opp} />);
    return { api, user };
  }

  it('a click on a refused button says it cannot start, and why, instead of nothing', async () => {
    const { api, user } = renderRefused({ ...OPP, stage: 'in_process' } as OpportunityView);
    const button = await screen.findByRole('button', { name: 'Apply on Greenhouse' });
    await user.click(button);
    const reason = screen.getByText(/Apply on Greenhouse is not available yet/);
    expect(reason).toBeVisible();
    expect(reason).toHaveTextContent('This opportunity is In process.');
    expect(reason).toHaveAttribute('aria-live', 'polite');
    // Still nothing sent and nowhere to go: the refusal is the answer.
    expect(api.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
    expect(button).toHaveFocus();
  });

  it('looks disabled (dimmed, a not-allowed cursor, no hover colour) and stays focusable', async () => {
    renderRefused({ ...OPP, stage: 'in_process' } as OpportunityView);
    const button = await screen.findByRole('button', { name: 'Apply on Greenhouse' });
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    // The Button's own disabled: styles match only the disabled attribute, never aria-disabled.
    expect(button.className).toMatch(/\baria-disabled:opacity-50\b/);
    expect(button.className).toMatch(/\baria-disabled:cursor-not-allowed\b/);
    expect(button.className).toMatch(/\baria-disabled:hover:bg-primary\b/);
    button.focus();
    expect(button).toHaveFocus();
  });

  it('an eligible opportunity keeps the plain link, with no disabled styling', async () => {
    renderRefused(OPP);
    const link = await screen.findByRole('link', { name: 'Apply on Greenhouse' });
    expect(link).not.toHaveAttribute('aria-disabled');
    expect(screen.queryByText(/is not available yet/)).toBeNull();
  });

  it.each([
    [
      'the stage',
      { stage: 'in_process' },
      [RESUME],
      'Apply on Greenhouse',
      'This opportunity is In process. Applying is available at Interested, Preparing or Applied. Change its stage to apply.',
    ],
    [
      'closed',
      { stage: 'closed' },
      [RESUME],
      'Apply on Greenhouse',
      'This opportunity is Closed. Reopen it to apply.',
    ],
    [
      'dismissed',
      { stage: 'dismissed' },
      [RESUME],
      'Apply on Greenhouse',
      'This opportunity is Dismissed. Reopen it to apply.',
    ],
    [
      'no ATS recognised',
      { atsJobRef: null },
      [RESUME],
      'Apply on an ATS',
      "We have not recognised this company's application system yet. Open the posting from the Details tab, or use Find posting.",
    ],
    [
      'a posting that needs review',
      { postingState: 'needs_review' },
      [RESUME],
      'Apply on Greenhouse',
      "This opportunity's posting needs review. Confirm it on the Details tab first.",
    ],
    ['no final resume', {}, [], 'Apply on Greenhouse', 'Attach a final resume first.'],
    // Brian's third case on #395: a resume is attached, but not Final. Say so, and how to fix it.
    [
      'an attached resume In review',
      { stage: 'interested' },
      [TAILORED_IN_REVIEW],
      'Apply on Greenhouse',
      'The resume attached here ("Acme tailored") is In review. Open it from the Resume tab and set its Status to Final.',
    ],
    [
      'an attached resume in Draft',
      { stage: 'interested' },
      [{ ...TAILORED_IN_REVIEW, status: 'draft' }],
      'Apply on Greenhouse',
      'The resume attached here ("Acme tailored") is Draft. Open it from the Resume tab and set its Status to Final.',
    ],
    // Brian's second case on #395: Interested, nothing attached.
    [
      'no final resume at Interested',
      { stage: 'interested' },
      [],
      'Apply on Greenhouse',
      'Attach a final resume first.',
    ],
  ] as const)(
    'refused for %s: the reason is visible next to the button and describes it',
    async (_name, over, resumes, label, reason) => {
      renderRefused({ ...OPP, ...over } as unknown as OpportunityView, [...resumes]);
      const button = await screen.findByRole('button', { name: label });
      expect(button).toHaveAttribute('aria-disabled', 'true');
      expect(button).not.toBeDisabled();
      expect(button.className).toMatch(/\baria-disabled:opacity-50\b/);
      expect(button).toHaveAccessibleDescription(reason);
      // Visible text, not only for screen readers, and right after the button.
      const text = screen.getByText(reason);
      expect(text).toBeVisible();
      expect(text.className).not.toMatch(/\bsr-only\b/);
      expect(button.nextElementSibling).toBe(text);
    },
  );
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

describe('#144: a posting change under the attempt is shown, and nothing is cancelled', () => {
  const NEW = 'https://boards.greenhouse.io/examplecorp/jobs/2000002';
  const moved = {
    ...OPP,
    postingUrl: NEW,
    atsJobRef: { kind: 'ats_greenhouse', org: 'examplecorp', externalId: '2000002', url: NEW },
  } as unknown as OpportunityView;
  const changed = (over: Partial<SubmissionView> = {}) =>
    submission({ postingChangedAt: NOW - MIN, ...over });

  it('the review says which job it was started for, what the posting is now, and how to use it', async () => {
    mockApi({ ...routes(changed()), 'GET /opportunities/opp-1': moved });
    renderStep('review');
    const notice = await screen.findByText(/The posting changed after you started/);
    const text = notice.closest('[role="status"]')?.textContent ?? '';
    expect(text).toContain('started for boards.greenhouse.io, REQ 1000001, and still goes there');
    expect(text).toContain('The posting is now boards.greenhouse.io, REQ 2000002');
    expect(text).toContain('Your answers are kept');
    expect(text).toContain('cancel this application and start again');
    // The pinned destination is still shown in full, as the review always shows it.
    expect(screen.getByText(DEST)).toBeVisible();
  });

  it('the panel says so too, and offers nothing that cancels by itself', async () => {
    const api = mockApi({ ...routes(changed()), 'GET /opportunities/opp-1': moved });
    renderWithProviders(<ApplyPanel opp={moved} />);
    expect(await screen.findByText(/The posting changed after you started/)).toBeVisible();
    expect(api.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('a posting that is no longer on a recognised site says so', async () => {
    const page = {
      ...OPP,
      atsJobRef: null,
      postingUrl: 'https://www.examplecorp.example/careers?gh_jid=2000002',
    } as unknown as OpportunityView;
    mockApi({ ...routes(changed()), 'GET /opportunities/opp-1': page });
    renderWithProviders(<ApplyPanel opp={page} />);
    expect(
      await screen.findByText(/www\.examplecorp\.example, which is not an application site/),
    ).toBeVisible();
  });

  it('a different job with no recorded change still shows the notice (a change during the create, tl on #154)', async () => {
    mockApi({
      ...routes(submission({ postingChangedAt: null })),
      'GET /opportunities/opp-1': moved,
    });
    renderStep('review');
    expect(await screen.findByText(/The posting changed after you started/)).toBeVisible();
  });

  it('no notice when the posting never changed, or changed back to the same job', async () => {
    mockApi(routes(submission()));
    renderStep('review');
    expect(await screen.findByText(DEST)).toBeVisible();
    expect(screen.queryByText(/The posting changed after you started/)).toBeNull();

    mockApi(routes(changed()));
    renderWithProviders(<ApplyPanel opp={OPP} />);
    expect(await screen.findAllByText('Submission status:', { exact: false })).not.toHaveLength(0);
    expect(screen.queryByText(/The posting changed after you started/)).toBeNull();
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

  // Two clicks in one tick (tl and qa on #138): the second lands before React has re-rendered
  // with `busy`, so only the in-flight ref set inside the first click can stop it.
  it('(1) two clicks in the same tick on a valid review: one tab, one handoff', async () => {
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
    const { router } = renderStep('review');
    const button = await screen.findByRole('button', { name: 'Open boards.greenhouse.io' });
    fireEvent.click(button);
    fireEvent.click(button);
    release();
    await waitFor(() => expect(router.state.location.search).toEqual({ step: 'open' }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(calls(api.calls, 'POST', '/submissions/sub-1/handoff')).toHaveLength(1);
  });

  it('(1) two clicks in the same tick on a first confirm: one review, one handoff, one tab', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const api = mockApi(
      routes(submission(), {
        'POST /submissions/sub-1/review': async () => {
          await held;
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
    fireEvent.click(button);
    fireEvent.click(button);
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

describe('M2a (#118): "I submitted it" on the open step', () => {
  const handedOff = () => submission({ status: 'handed_off', handedOffAt: NOW });

  it('records with "Move to Applied" pre-ticked and the time left as now, then returns to the opportunity', async () => {
    const api = mockApi(
      routes(handedOff(), {
        'POST /submissions/sub-1/attest': submission({ status: 'submitted', submittedAt: NOW }),
      }),
    );
    const { user, router } = renderStep('open');
    await user.click(await screen.findByRole('button', { name: 'I submitted it' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Record that you submitted this application?',
    });
    expect(within(dialog).getByText(/this is your word/i)).toBeVisible();
    // The date field takes focus, so the primary button is never the first stop.
    await waitFor(() =>
      expect(within(dialog).getByLabelText('When did you submit?')).toHaveFocus(),
    );
    expect(
      within(dialog).getByRole('checkbox', { name: 'Move this opportunity to Applied' }),
    ).toBeChecked();
    // Field values never reach the timeline: the summary says so.
    expect(within(dialog).getByText(/not your answers/)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Yes, I submitted it' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/opportunities/opp-1'));
    expect(calls(api.calls, 'POST', '/submissions/sub-1/attest')).toEqual([
      expect.objectContaining({ body: { moveToApplied: true } }),
    ]);
  });

  it('unticked, the stage is left alone; a changed time is sent as the user typed it', async () => {
    const api = mockApi(
      routes(handedOff(), {
        'POST /submissions/sub-1/attest': submission({ status: 'submitted', submittedAt: NOW }),
      }),
    );
    const { user } = renderStep('open');
    await user.click(await screen.findByRole('button', { name: 'I submitted it' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(
      within(dialog).getByRole('checkbox', { name: 'Move this opportunity to Applied' }),
    );
    const when = within(dialog).getByLabelText('When did you submit?');
    fireEvent.change(when, { target: { value: '2026-10-30T09:15' } });
    await user.click(within(dialog).getByRole('button', { name: 'Yes, I submitted it' }));
    await waitFor(() =>
      expect(calls(api.calls, 'POST', '/submissions/sub-1/attest')).toHaveLength(1),
    );
    expect(calls(api.calls, 'POST', '/submissions/sub-1/attest')[0]?.body).toEqual({
      moveToApplied: false,
      submittedAt: new Date('2026-10-30T09:15').getTime(),
    });
  });

  it('"Not yet" records nothing, and a refusal stays in the dialog in words', async () => {
    const api = mockApi(
      routes(handedOff(), {
        'POST /submissions/sub-1/attest': () => ({
          status: 422,
          body: { error: { code: 'submitted_at_in_future' } },
        }),
      }),
    );
    const { user } = renderStep('open');
    await user.click(await screen.findByRole('button', { name: 'I submitted it' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Not yet' }),
    );
    expect(calls(api.calls, 'POST', '/submissions/sub-1/attest')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'I submitted it' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Yes, I submitted it' }));
    expect(await within(dialog).findByText(/That time has not happened yet/)).toBeVisible();
    expect(within(dialog).queryByText('submitted_at_in_future')).toBeNull();
  });

  it('"now" is when the dialog opens, not when the page loaded (tl on #145)', async () => {
    mockApi(routes(handedOff()));
    const local = (ms: number) => {
      const d = new Date(ms);
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    const { user } = renderStep('open');
    await user.click(await screen.findByRole('button', { name: 'I submitted it' }));
    let dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Not yet' }));
    // Two hours later, the same page: the dialog opens with the time it opens at.
    const later = Date.now() + 2 * 60 * MIN;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      await user.click(screen.getByRole('button', { name: 'I submitted it' }));
      dialog = await screen.findByRole('dialog');
      await waitFor(() =>
        expect(within(dialog).getByLabelText('When did you submit?')).toHaveValue(local(later)),
      );
    } finally {
      clock.mockRestore();
    }
  });

  it('a stage already past Applied is not offered the move', async () => {
    mockApi({
      ...routes(handedOff()),
      'GET /opportunities/opp-1': { ...OPP, stage: 'in_process' },
    });
    const { user } = renderStep('open');
    await user.click(await screen.findByRole('button', { name: 'I submitted it' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
  });
});

describe('M2a (#118): applying again needs a typed reason', () => {
  const earlier = submission({
    id: 'sub-0',
    status: 'submitted',
    submittedAt: NOW - 10 * 24 * 60 * MIN,
  });
  const withEarlier = (extra: Record<string, unknown> = {}) => ({
    ...routes(submission()),
    'GET /opportunities/opp-1/submissions': { items: [submission(), earlier], total: 2 },
    ...extra,
  });
  const confirmButton = () =>
    screen.getByRole('button', { name: 'Confirm review and open boards.greenhouse.io' });

  it('with an earlier application here, the confirm waits for a reason, then sends it', async () => {
    const reviewed = submission({ status: 'reviewed', reviewExpiresAt: NOW + 30 * MIN });
    const api = mockApi(
      withEarlier({
        'POST /submissions/sub-1/review': reviewed,
        'POST /submissions/sub-1/handoff': { destinationUrl: DEST, expiresAt: NOW },
      }),
    );
    fakeWindowOpen();
    const { user, router } = renderStep('review');
    const field = await screen.findByLabelText('Why are you applying again?');
    await user.click(screen.getByRole('checkbox'));
    expect(confirmButton()).toHaveAttribute('aria-disabled', 'true');
    await user.click(confirmButton());
    expect(field).toHaveFocus();
    expect(confirmButton()).toHaveAccessibleDescription('Say why you are applying again.');
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(0);

    await user.type(field, '  The recruiter asked me to.  ');
    await user.click(confirmButton());
    await waitFor(() => expect(router.state.location.search).toEqual({ step: 'open' }));
    expect(calls(api.calls, 'POST', '/submissions/sub-1/review')[0]?.body).toEqual({
      reviewDigest: DIGEST,
      acknowledged: true,
      reapplyReason: 'The recruiter asked me to.',
    });
  });

  it('a first application sends no reason and shows no field', async () => {
    const api = mockApi(
      routes(submission(), {
        'POST /submissions/sub-1/review': submission({
          status: 'reviewed',
          reviewExpiresAt: NOW + 30 * MIN,
        }),
        'POST /submissions/sub-1/handoff': { destinationUrl: DEST, expiresAt: NOW },
      }),
    );
    fakeWindowOpen();
    const { user, router } = renderStep('review');
    await user.click(await screen.findByRole('checkbox'));
    expect(screen.queryByLabelText('Why are you applying again?')).toBeNull();
    await user.click(confirmButton());
    await waitFor(() => expect(router.state.location.search).toEqual({ step: 'open' }));
    expect(calls(api.calls, 'POST', '/submissions/sub-1/review')[0]?.body).toEqual({
      reviewDigest: DIGEST,
      acknowledged: true,
    });
  });

  it('an earlier application the server knows of (another opportunity) asks for the reason there', async () => {
    const api = mockApi(
      routes(submission(), {
        'POST /submissions/sub-1/review': () => ({
          status: 422,
          body: { error: { code: 'reapply_reason_required', submissionId: 'sub-elsewhere' } },
        }),
      }),
    );
    const { tab } = fakeWindowOpen();
    const { user } = renderStep('review');
    await user.click(await screen.findByRole('checkbox'));
    await user.click(confirmButton());
    const field = await screen.findByLabelText('Why are you applying again?');
    await waitFor(() => expect(field).toHaveFocus());
    expect(screen.getByText(/from another opportunity/)).toBeVisible();
    // The blank tab opened inside the click is closed again: nothing was handed off.
    expect(tab.close).toHaveBeenCalled();
    expect(calls(api.calls, 'POST', '/submissions/sub-1/handoff')).toHaveLength(0);
  });
});

describe('a draft refused at creation for its destination (#135)', () => {
  it('says so in words, never the code, and stays on the resume step', async () => {
    mockApi(
      routes(null, {
        'POST /opportunities/opp-1/submissions': () => ({
          status: 422,
          body: { error: { code: 'destination_not_allowed' } },
        }),
      }),
    );
    const { user, router } = renderStep('resume');
    await user.click(await screen.findByRole('button', { name: 'Next: Details' }));
    expect(
      await screen.findByText(/isn't the employer's own posting on a recognised application site/i),
    ).toBeVisible();
    expect(document.body.textContent).not.toContain('destination_not_allowed');
    expect(router.state.location.search).toEqual({ step: 'resume' });
  });
});

describe('what happened after submitting (#148)', () => {
  const SUBMITTED = { status: 'submitted', submittedAt: NOW - 60 * MIN } as const;

  function panel(sub: SubmissionView, extra: Record<string, unknown> = {}) {
    const api = mockApi(routes(sub, extra));
    const user = userEvent.setup();
    renderWithProviders(<ApplyPanel opp={OPP} />);
    return { api, user };
  }

  it.each([
    ['submitted', SUBMITTED, false],
    ['no confirmation seen', { status: 'unknown', submittedAt: NOW - 4 * 24 * 60 * MIN }, true],
  ] as const)('a %s attempt offers both actions', async (_n, over, explains) => {
    panel(submission(over as Partial<SubmissionView>));
    expect(await screen.findByText('What happened?')).toBeVisible();
    expect(screen.getByRole('button', { name: 'I saw a confirmation' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'The site refused it' })).toBeVisible();
    expect(screen.queryAllByText(/This is not a failure/).length > 0).toBe(explains);
  });

  it.each(['confirmed', 'rejected', 'abandoned', 'draft', 'reviewed', 'handed_off'] as const)(
    'a %s attempt offers neither',
    async (status) => {
      panel(submission({ status, reviewExpiresAt: NOW + 30 * MIN }));
      await screen.findByRole('region', { name: 'Assisted apply' });
      expect(
        screen.queryByRole('button', { name: 'I saw a confirmation' }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'The site refused it' })).not.toBeInTheDocument();
    },
  );

  it('"I saw a confirmation" says what it records, then records it and closes', async () => {
    const unknown = submission({ status: 'unknown', submittedAt: NOW - 4 * 24 * 60 * MIN });
    const { api, user } = panel(unknown, {
      'POST /submissions/sub-1/outcome': () => ({
        status: 200,
        body: submission({ status: 'confirmed', confirmationKind: 'user' }),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'I saw a confirmation' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mark as confirmed?' });
    expect(dialog).toHaveTextContent('No evidence will be attached.');
    expect(dialog).toHaveTextContent('Marked confirmed by you (no evidence attached)');
    expect(dialog).toHaveTextContent(
      'Check whether your application to Acme was received” as done, if it is still open.',
    );
    expect(dialog).toHaveTextContent('Leave this opportunity’s stage as it is.');
    expect(calls(api.calls, 'POST', '/submissions/sub-1/outcome')).toHaveLength(0);

    const reads = calls(api.calls, 'GET', '/opportunities/opp-1/submissions').length;
    await user.click(within(dialog).getByRole('button', { name: 'Mark confirmed' }));
    // A native <dialog>: closed, it stays in the DOM but is no longer a dialog.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls(api.calls, 'POST', '/submissions/sub-1/outcome')[0]?.body).toEqual({
      outcome: 'confirmed_by_user',
    });
    // The attempt (and the opportunity, with its next steps) are read again.
    await waitFor(() =>
      expect(calls(api.calls, 'GET', '/opportunities/opp-1/submissions').length).toBeGreaterThan(
        reads,
      ),
    );
    expect(await screen.findByText('Confirmation recorded')).toBeVisible();
  });

  it('"The site refused it" takes the user\'s note and records it', async () => {
    const { api, user } = panel(submission(SUBMITTED), {
      'POST /submissions/sub-1/outcome': () => ({
        status: 200,
        body: submission({ status: 'rejected' }),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'The site refused it' }));
    const dialog = await screen.findByRole('dialog', { name: 'Record that the site refused it?' });
    expect(dialog).toHaveTextContent('The application site refused the form');
    expect(dialog).toHaveTextContent('Leave this opportunity’s stage as it is.');
    // A submitted attempt has no follow-up step yet, so none is promised.
    expect(dialog).not.toHaveTextContent('Check whether');
    await user.type(within(dialog).getByLabelText(/What did the site say/), '  Already applied.  ');
    await user.click(within(dialog).getByRole('button', { name: 'Record refusal' }));
    // A native <dialog>: closed, it stays in the DOM but is no longer a dialog.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls(api.calls, 'POST', '/submissions/sub-1/outcome')[0]?.body).toEqual({
      outcome: 'ats_refused',
      note: 'Already applied.',
    });
  });

  it('a refusal with no note sends none', async () => {
    const { api, user } = panel(submission(SUBMITTED), {
      'POST /submissions/sub-1/outcome': () => ({
        status: 200,
        body: submission({ status: 'rejected' }),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'The site refused it' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Record refusal' }));
    // A native <dialog>: closed, it stays in the DOM but is no longer a dialog.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls(api.calls, 'POST', '/submissions/sub-1/outcome')[0]?.body).toEqual({
      outcome: 'ats_refused',
    });
  });

  it('Not now records nothing', async () => {
    const { api, user } = panel(submission(SUBMITTED));
    await user.click(await screen.findByRole('button', { name: 'I saw a confirmation' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Not now' }));
    // A native <dialog>: closed, it stays in the DOM but is no longer a dialog.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls(api.calls, 'POST', '/submissions/sub-1/outcome')).toHaveLength(0);
  });

  it('a refused report stays open and says why in words', async () => {
    const { user } = panel(submission(SUBMITTED), {
      'POST /submissions/sub-1/outcome': () => ({
        status: 409,
        body: { error: { code: 'invalid_transition' } },
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'I saw a confirmation' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Mark confirmed' }));
    expect(await within(dialog).findByText(/changed in another tab or window/i)).toBeVisible();
    expect(dialog).not.toHaveTextContent('invalid_transition');
  });
});

describe('an earlier submission can still be reported on (#148, tl)', () => {
  const EARLIER_AT = NOW - 5 * 24 * 60 * MIN;
  const earlier = submission({
    id: 'sub-old',
    status: 'unknown',
    submittedAt: EARLIER_AT,
    createdAt: NOW - 6 * 24 * 60 * MIN,
  });

  function panelWith(items: SubmissionView[]) {
    const api = mockApi({
      'GET /resumes': { items: [RESUME], total: 1 },
      'GET /opportunities/opp-1/submissions': { items, total: items.length },
      'POST /submissions/sub-old/outcome': () => ({
        status: 200,
        body: { ...earlier, status: 'confirmed', confirmationKind: 'user' },
      }),
    });
    const user = userEvent.setup();
    renderWithProviders(<ApplyPanel opp={OPP} />);
    return { api, user };
  }

  it.each([
    ['while a re-application is in progress', submission({ id: 'sub-new', status: 'draft' })],
    [
      'after a newer attempt was cancelled',
      submission({ id: 'sub-new', status: 'abandoned', failureReason: 'cancelled_by_user' }),
    ],
    [
      'after a newer attempt’s review expired',
      submission({ id: 'sub-new', status: 'abandoned', failureReason: 'review_expired' }),
    ],
  ])('%s, named by when it was submitted', async (_n, newer) => {
    const { api, user } = panelWith([newer, earlier]);
    const block = await screen.findByRole('region', { name: 'Earlier application' });
    expect(block).toHaveTextContent(`Earlier application, submitted ${formatDateTime(EARLIER_AT)}`);
    expect(block).toHaveTextContent('No confirmation seen');
    await user.click(within(block).getByRole('button', { name: 'I saw a confirmation' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mark as confirmed?' });
    await user.click(within(dialog).getByRole('button', { name: 'Mark confirmed' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The report is about the earlier attempt, never the newer one.
    expect(calls(api.calls, 'POST', '/submissions/sub-old/outcome')).toHaveLength(1);
    expect(api.calls.filter((c) => c.path === '/submissions/sub-new/outcome')).toHaveLength(0);
  });

  it('the newest submission shows its actions once, with no "earlier" block', async () => {
    panelWith([earlier]);
    expect(await screen.findByRole('button', { name: 'I saw a confirmation' })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Earlier application' })).not.toBeInTheDocument();
  });

  it('nothing reportable: no block', async () => {
    panelWith([
      submission({ id: 'sub-new', status: 'draft' }),
      { ...earlier, status: 'confirmed' },
    ]);
    await screen.findByRole('region', { name: 'Assisted apply' });
    expect(screen.queryByRole('region', { name: 'Earlier application' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'I saw a confirmation' })).not.toBeInTheDocument();
  });
});

describe('the review screen shows the daily review usage from the server (#130)', () => {
  it('"n of N reviews used in the last 24 hours" and when the next frees up', async () => {
    const nextFreeAt = NOW + 3 * 60 * MIN;
    mockApi(
      routes(submission(), {
        'GET /settings/applications': {
          used: 4,
          cap: 10,
          instanceCap: 10,
          userCap: null,
          nextFreeAt,
        },
      }),
    );
    renderStep('review');
    expect(await screen.findByText(/4 of 10 reviews used in the last 24 hours/)).toHaveTextContent(
      `The next place frees up at ${formatDateTime(nextFreeAt)}.`,
    );
  });

  it('a review reads the usage again, so the count moves with it', async () => {
    const api = mockApi(
      routes(submission(), {
        'GET /settings/applications': {
          used: 4,
          cap: 10,
          instanceCap: 10,
          userCap: null,
          nextFreeAt: null,
        },
        'POST /submissions/sub-1/review': submission({ status: 'reviewed' }),
        'POST /submissions/sub-1/handoff': { destinationUrl: DEST, expiresAt: NOW },
      }),
    );
    fakeWindowOpen();
    const { user, router } = renderStep('review');
    await screen.findByText(/4 of 10 reviews used/);
    const before = calls(api.calls, 'GET', '/settings/applications').length;
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /confirm review/i }));
    await waitFor(() => expect(router.state.location.search).toEqual({ step: 'open' }));
    await waitFor(() =>
      expect(calls(api.calls, 'GET', '/settings/applications').length).toBeGreaterThan(before),
    );
  });

  it('no line where the usage route is off', async () => {
    mockApi(routes(submission()));
    renderStep('review');
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText(/reviews used in the last 24 hours/)).not.toBeInTheDocument();
  });
});

describe('the Apply panel links to each application’s own page (#149)', () => {
  it('the last submitted application, and an earlier one, each link to their page', async () => {
    const earlier = submission({
      id: 'sub-old',
      status: 'unknown',
      submittedAt: NOW - 6 * 24 * 60 * MIN,
    });
    mockApi({
      'GET /resumes': { items: [RESUME], total: 1 },
      'GET /opportunities/opp-1/submissions': {
        items: [submission({ id: 'sub-new', status: 'draft' }), earlier],
        total: 2,
      },
    });
    renderWithProviders(<ApplyPanel opp={OPP} />);
    const block = await screen.findByRole('region', { name: 'Earlier application' });
    expect(within(block).getByRole('link', { name: 'View application' })).toHaveAttribute(
      'href',
      '/opportunities/opp-1/applications/sub-old',
    );
  });

  it('the newest submitted application links to its page', async () => {
    mockApi(routes(submission({ status: 'submitted', submittedAt: NOW - 60 * MIN })));
    renderWithProviders(<ApplyPanel opp={OPP} />);
    expect(await screen.findByRole('link', { name: 'View application' })).toHaveAttribute(
      'href',
      '/opportunities/opp-1/applications/sub-1',
    );
  });
});

describe('M3a (#181): the fields prefill reads by name', () => {
  const PREFILL = {
    firstName: 'Jane',
    lastName: 'Doe-Example',
    linkedinUrl: 'https://www.linkedin.com/in/jane-doe-example',
    websiteUrl: 'https://jane.example.com',
  };

  it('the details step has first and last name, LinkedIn and website, and saves them by name', async () => {
    const api = mockApi(
      routes(submission(), {
        'PATCH /submissions/sub-1': (c: ApiCall) => ({
          status: 200,
          body: { ...submission(), ...(c.body as object) },
        }),
      }),
    );
    const { user, router } = renderStep('details');
    await user.type(await screen.findByLabelText('First name'), PREFILL.firstName);
    await user.type(screen.getByLabelText('Last name'), PREFILL.lastName);
    await user.type(screen.getByLabelText('LinkedIn profile'), PREFILL.linkedinUrl);
    await user.type(screen.getByLabelText('Website'), ` ${PREFILL.websiteUrl} `);
    // The full name and the free-text links stay as they were: nothing is split or derived.
    expect(screen.getByLabelText('Full name')).toHaveValue('Jane Doe');
    await user.click(screen.getByRole('button', { name: 'Next: Review' }));
    await waitFor(() => expect(router.state.location.search).toEqual({ step: 'review' }));
    const [edit] = calls(api.calls, 'PATCH', '/submissions/sub-1');
    expect((edit?.body as { fields: unknown }).fields).toEqual({
      fullName: 'Jane Doe',
      email: 'jane@example.com',
      ...PREFILL,
    });
  });

  it('the links are web-address inputs and the names offer the browser’s own name autofill', async () => {
    mockApi(routes(submission()));
    renderStep('details');
    expect(await screen.findByLabelText('First name')).toHaveAttribute(
      'autocomplete',
      'given-name',
    );
    expect(screen.getByLabelText('Last name')).toHaveAttribute('autocomplete', 'family-name');
    expect(screen.getByLabelText('LinkedIn profile')).toHaveAttribute('type', 'url');
    expect(screen.getByLabelText('Website')).toHaveAttribute('type', 'url');
  });

  it('the review shows each under its own label, in the order of the details step', async () => {
    mockApi(
      routes(
        submission({
          // Stored order is not display order (Postgres jsonb sorts its keys).
          fields: {
            websiteUrl: PREFILL.websiteUrl,
            email: 'jane@example.com',
            linkedinUrl: PREFILL.linkedinUrl,
            lastName: PREFILL.lastName,
            firstName: PREFILL.firstName,
          },
        }),
      ),
    );
    renderStep('review');
    const section = (await screen.findByRole('heading', { name: 'Your details' })).closest(
      'section',
    ) as HTMLElement;
    const terms = within(section)
      .getAllByRole('term')
      .map((t) => t.textContent);
    expect(terms).toEqual(['First name', 'Last name', 'Email', 'LinkedIn profile', 'Website']);
    for (const value of [...Object.values(PREFILL), 'jane@example.com']) {
      expect(within(section).getByText(value)).toBeVisible();
    }
  });

  it('the open step offers each to copy, under its label', async () => {
    mockApi(routes(submission({ status: 'handed_off', handedOffAt: NOW, fields: { ...PREFILL } })));
    renderStep('open');
    for (const label of ['First name', 'Last name', 'LinkedIn profile', 'Website']) {
      expect(await screen.findByRole('button', { name: `Copy ${label}` })).toBeVisible();
    }
  });

  it('an attempt without them shows empty fields, and the review invents none', async () => {
    mockApi(routes(submission({ status: 'reviewed', reviewExpiresAt: NOW + 30 * MIN })));
    const first = renderStep('details');
    expect(await screen.findByLabelText('First name')).toHaveValue('');
    expect(screen.getByLabelText('Last name')).toHaveValue('');
    expect(screen.getByLabelText('LinkedIn profile')).toHaveValue('');
    expect(screen.getByLabelText('Website')).toHaveValue('');
    first.unmount();
    renderStep('review');
    await screen.findByText('Jane Doe');
    for (const label of ['First name', 'Last name', 'LinkedIn profile', 'Website']) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  for (const [code, field, words] of [
    ['field_url_invalid', 'linkedinUrl', /LinkedIn profile.*https:\/\//i],
    ['field_url_invalid', 'websiteUrl', /Website.*https:\/\//i],
    ['field_name_invalid', 'firstName', /First name.*one line.*100 characters/i],
    ['field_name_invalid', 'lastName', /Last name.*one line.*100 characters/i],
    ['field_email_invalid', 'email', /Email.*one line, like name@example\.com/i],
    ['field_phone_invalid', 'phone', /Phone.*digits, spaces, \+, -, \., \( \) and an extension/i],
  ] as const) {
    it(`422 ${code} on ${field}: plain words naming the field, never the code`, async () => {
      mockApi(
        routes(submission(), {
          'PATCH /submissions/sub-1': () => ({
            status: 422,
            body: { error: { code, field } },
          }),
        }),
      );
      const { user, router } = renderStep('details');
      await user.type(await screen.findByLabelText('Phone'), '555 0100');
      await user.click(screen.getByRole('button', { name: 'Next: Review' }));
      expect(await screen.findByText(words)).toBeVisible();
      expect(document.body.textContent).not.toContain(code);
      expect(router.state.location.search).toEqual({ step: 'details' });
    });
  }
});

describe('#186: starting again from pre-check values, and a review refused by the rate limit', () => {
  const expired = submission({
    id: 'sub-old',
    status: 'abandoned',
    failureReason: 'review_expired',
    fields: {
      firstName: ' Legacy',
      linkedinUrl: 'linkedin.com/in/legacy',
      email: 'jane@example.com',
      fullName: 'Jane Doe',
    },
  });

  it('start again carries the details that still pass, drops the others, and names them', async () => {
    const fresh = submission({ id: 'sub-2', fields: {}, answers: [] });
    const api = mockApi({
      ...routes(null),
      'GET /opportunities/opp-1/submissions': { items: [expired], total: 1 },
      'POST /opportunities/opp-1/submissions': () => ({ status: 201, body: fresh }),
      'PATCH /submissions/sub-2': (c: ApiCall) => ({
        status: 200,
        body: { ...fresh, ...(c.body as object) },
      }),
    });
    const { user, router } = renderStep('resume');
    await user.click(await screen.findByRole('button', { name: 'Next: Details' }));
    await waitFor(() =>
      expect(router.state.location.search).toEqual({
        step: 'details',
        cleared: ['firstName', 'linkedinUrl'],
      }),
    );
    const [copy] = calls(api.calls, 'PATCH', '/submissions/sub-2');
    // Only what passes today's checks is sent, so the copy is never refused (qa on #184).
    expect((copy?.body as { fields: unknown }).fields).toEqual({
      email: 'jane@example.com',
      fullName: 'Jane Doe',
    });
  });

  it('the details step names what was not carried over', async () => {
    mockApi(routes(submission({ fields: { email: 'jane@example.com' } })));
    renderWithProviders(
      <ApplyPage opportunityId="opp-1" step="details" cleared={['firstName', 'linkedinUrl']} />,
      { path: '/opportunities/opp-1/apply?step=details' },
    );
    const notice = await screen.findByRole('status', { name: /not carried over/i });
    expect(notice).toHaveTextContent(
      'Not carried over from your earlier application, because they no longer pass the checks: First name, LinkedIn profile. Enter them again if you need them.',
    );
  });

  it('no notice when nothing was dropped', async () => {
    mockApi(routes(submission()));
    renderStep('details');
    await screen.findByLabelText('First name');
    expect(screen.queryByText(/not carried over/i)).toBeNull();
  });

  it('the route keeps only known field names, and only on the details step', () => {
    expect(
      parseApplySearch({ step: 'details', cleared: ['firstName', 'constructor', '<b>', 7] }),
    ).toEqual({ step: 'details', cleared: ['firstName'] });
    expect(parseApplySearch({ step: 'details', cleared: 'firstName' })).toEqual({
      step: 'details',
    });
    expect(parseApplySearch({ step: 'review', cleared: ['firstName'] })).toEqual({
      step: 'review',
    });
  });

  it('429 rate_limited on the review: says when to try again, never "check your connection"', async () => {
    mockApi(
      routes(submission(), {
        'POST /submissions/sub-1/review': () => ({
          status: 429,
          body: { error: { code: 'rate_limited' } },
          headers: { 'retry-after': '45' },
        }),
      }),
    );
    const { tab } = fakeWindowOpen();
    const { user } = renderStep('review');
    await user.click(await screen.findByRole('checkbox'));
    const before = Date.now();
    await user.click(screen.getByRole('button', { name: /confirm review/i }));
    await waitFor(() => expect(tab.close).toHaveBeenCalled());
    const alert = (await screen.findByText(/too many tries in a short time/i)).closest(
      '[role="alert"]',
    ) as HTMLElement;
    // The time it frees up, as a clock time: now plus the server's retry-after.
    const at = [clockTime(before + 45_000), clockTime(Date.now() + 45_000)];
    expect(at.some((t) => alert.textContent?.includes(t))).toBe(true);
    expect(alert).toHaveTextContent(/nothing was opened/i);
    expect(alert).toHaveTextContent(/your draft is saved/i);
    expect(screen.queryByText(/check your connection/i)).toBeNull();
  });
});

describe("#196: a stored value that fails today's checks is flagged on the review, not refused", () => {
  const stored = {
    firstName: 'Jane\u202EExample',
    linkedinUrl: 'https://user:pw@jane.example.com/',
    email: 'jane@example.com',
  };

  it('each failing field carries a warning that it will not be filled; a passing one does not', async () => {
    mockApi(routes(submission({ fields: stored })));
    renderStep('review');
    const section = (await screen.findByRole('heading', { name: 'Your details' })).closest(
      'section',
    ) as HTMLElement;
    const warnings = within(section).getAllByText(
      /This will not be filled until you correct it: it no longer passes Opportun's checks\./,
    );
    expect(warnings).toHaveLength(2);
    // The confirm is not blocked by it.
    expect(screen.getByRole('checkbox')).toBeEnabled();
    expect(screen.getByRole('button', { name: /confirm review/i })).toBeEnabled();
  });

  it('no warning when every field passes', async () => {
    mockApi(routes(submission()));
    renderStep('review');
    await screen.findByRole('heading', { name: 'Your details' });
    expect(screen.queryByText(/will not be filled until you correct it/i)).toBeNull();
  });

  it('Review again still works for that row: it sends the stored fields back unchanged', async () => {
    const reviewed = submission({
      status: 'reviewed',
      reviewExpiresAt: NOW - MIN,
      fields: stored,
    });
    const api = mockApi(
      routes(reviewed, {
        'PATCH /submissions/sub-1': (c: ApiCall) => ({
          status: 200,
          body: { ...reviewed, ...(c.body as object), status: 'draft', reviewExpiresAt: null },
        }),
      }),
    );
    const { user } = renderStep('review');
    await user.click(await screen.findByRole('button', { name: 'Review again' }));
    await waitFor(() => expect(calls(api.calls, 'PATCH', '/submissions/sub-1')).toHaveLength(1));
    const [again] = calls(api.calls, 'PATCH', '/submissions/sub-1');
    expect((again?.body as { fields: unknown }).fields).toEqual(stored);
  });
});

describe('#198: a 429 on the handoff says when to try again (tl on #194)', () => {
  it('a valid review whose handoff is rate limited: the clock time from retry-after, never "check your connection"', async () => {
    const api = mockApi(
      routes(submission({ status: 'reviewed', reviewExpiresAt: NOW + 30 * MIN }), {
        'POST /submissions/sub-1/handoff': () => ({
          status: 429,
          body: { error: { code: 'rate_limited' } },
          headers: { 'retry-after': '90' },
        }),
      }),
    );
    const { tab } = fakeWindowOpen();
    const { user } = renderStep('review');
    const before = Date.now();
    await user.click(await screen.findByRole('button', { name: 'Open boards.greenhouse.io' }));
    await waitFor(() => expect(tab.close).toHaveBeenCalled());
    // Only the handoff ran: the review was still valid.
    expect(calls(api.calls, 'POST', '/submissions/sub-1/review')).toHaveLength(0);
    expect(calls(api.calls, 'POST', '/submissions/sub-1/handoff')).toHaveLength(1);
    const alert = (await screen.findByText(/too many tries in a short time/i)).closest(
      '[role="alert"]',
    ) as HTMLElement;
    const at = [clockTime(before + 90_000), clockTime(Date.now() + 90_000)];
    expect(at.some((t) => alert.textContent?.includes(t))).toBe(true);
    expect(alert).not.toHaveTextContent(/in a minute/i);
    expect(screen.queryByText(/check your connection/i)).toBeNull();
  });
});

// #401 (slice 2 of tl's note, issuecomment-6794002888): the details step opens filled with what
// Opportun holds, says where each value came from, and saves a value to the profile only when
// the user ticks it. Every name, address and company here is made up.
describe('#401: the details step, filled from the profile, the account and the last application', () => {
  const PROFILE = {
    userId: 'u1',
    fullName: 'Jane Doe',
    headline: null,
    email: null,
    phone: null,
    location: null,
    workAuth: null,
    links: [],
    applicationDetails: {},
    updatedAt: NOW,
  };
  const REVIEWED_AT = new Date(2026, 9, 3).getTime();
  const PREFILL = {
    values: [
      { key: 'fullName', value: 'Jane Doe', source: { kind: 'profile' } },
      { key: 'email', value: 'jane@example.com', source: { kind: 'account' } },
      {
        key: 'phone',
        value: '+1 555 0100',
        source: {
          kind: 'application',
          submissionId: '01a1caeb-0000-7000-8000-000000000001',
          opportunityId: '01a1caeb-0000-7000-8000-000000000002',
          companyName: 'Globex',
          reviewedAt: REVIEWED_AT,
        },
      },
    ],
    leftOut: [],
  };
  const filled = submission({
    fields: { fullName: 'Jane Doe', email: 'jane@example.com', phone: '+1 555 0100' },
  });

  function withDetails(sub: SubmissionView, extra: Record<string, unknown> = {}) {
    return routes(sub, {
      'GET /profile': PROFILE,
      'GET /profile/application-details': PREFILL,
      'PATCH /submissions/sub-1': (c: ApiCall) => ({
        status: 200,
        body: { ...sub, ...(c.body as object), status: 'draft' },
      }),
      ...extra,
    });
  }

  const fieldBox = (label: string) => screen.getByLabelText(label).parentElement as HTMLElement;

  it('says where each value came from, and which ones the profile does not hold', async () => {
    const api = mockApi(withDetails(filled));
    renderStep('details');
    expect(await screen.findByText('From your profile')).toBeInTheDocument();
    expect(within(fieldBox('Full name')).getByText('From your profile')).toBeInTheDocument();
    expect(within(fieldBox('Email')).getByText('From your account')).toBeInTheDocument();
    expect(
      within(fieldBox('Phone')).getByText(
        `From your application to Globex, ${formatDate(REVIEWED_AT)}`,
      ),
    ).toBeInTheDocument();
    // The account's email and the application's phone are not in the profile: a tick each,
    // off by default. The full name is the profile's own: no tick.
    expect(within(fieldBox('Email')).getByText('Not in your profile')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Save to my profile: Email' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Save to my profile: Phone' })).not.toBeChecked();
    expect(screen.queryByRole('checkbox', { name: /: Full name$/ })).toBeNull();
    expect(screen.getByText(/unless you tick Save to my profile/)).toBeInTheDocument();
    expect(calls(api.calls, 'GET', '/profile/application-details')[0]?.search).toBe(
      '?excluding=sub-1',
    );
  });

  it('an edit stays on this application: it differs from the profile, and saves nothing unticked', async () => {
    const api = mockApi(withDetails(filled));
    const { user, router } = renderStep('details');
    const name = await screen.findByLabelText('Full name');
    await screen.findByText('From your profile');
    await user.clear(name);
    await user.type(name, 'Jane Q. Doe');
    expect(within(fieldBox('Full name')).queryByText('From your profile')).toBeNull();
    expect(
      within(fieldBox('Full name')).getByText('Differs from your profile'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next: Review' }));
    await waitFor(() => expect(router.state.location.search).toEqual({ step: 'review' }));
    const [edit] = calls(api.calls, 'PATCH', '/submissions/sub-1');
    expect(edit?.body).toMatchObject({ fields: { fullName: 'Jane Q. Doe' } });
    expect(edit?.body).not.toHaveProperty('saveToProfile');
  });

  it('Next sends the draft and the ticked names in one request', async () => {
    const api = mockApi(withDetails(filled));
    const { user, router } = renderStep('details');
    const name = await screen.findByLabelText('Full name');
    await screen.findByText('From your profile');
    await user.clear(name);
    await user.type(name, 'Jane Q. Doe');
    await user.click(screen.getByRole('checkbox', { name: 'Save to my profile: Full name' }));
    await user.click(screen.getByRole('checkbox', { name: 'Save to my profile: Phone' }));
    await user.click(screen.getByRole('button', { name: 'Next: Review' }));
    await waitFor(() => expect(router.state.location.search).toEqual({ step: 'review' }));
    const edits = calls(api.calls, 'PATCH', '/submissions/sub-1');
    expect(edits).toHaveLength(1);
    expect(edits[0]?.body).toMatchObject({
      fields: { fullName: 'Jane Q. Doe', email: 'jane@example.com', phone: '+1 555 0100' },
      saveToProfile: ['fullName', 'phone'],
    });
  });

  it('a tick alone is a change: an unedited reviewed attempt with a tick is sent', async () => {
    const reviewed = submission({ ...filled, status: 'reviewed', reviewExpiresAt: NOW + 30 * MIN });
    const api = mockApi(withDetails(reviewed));
    const { user } = renderStep('details');
    await user.click(await screen.findByRole('checkbox', { name: 'Save to my profile: Email' }));
    await user.click(screen.getByRole('button', { name: 'Next: Review' }));
    await waitFor(() => expect(calls(api.calls, 'PATCH', '/submissions/sub-1')).toHaveLength(1));
    expect(calls(api.calls, 'PATCH', '/submissions/sub-1')[0]?.body).toMatchObject({
      saveToProfile: ['email'],
    });
  });

  it('an emptied field the profile holds offers to remove it, and sends it without the value', async () => {
    const api = mockApi(withDetails(filled));
    const { user, router } = renderStep('details');
    const name = await screen.findByLabelText('Full name');
    await screen.findByText('From your profile');
    await user.clear(name);
    await user.click(screen.getByRole('checkbox', { name: 'Remove from my profile: Full name' }));
    await user.click(screen.getByRole('button', { name: 'Next: Review' }));
    await waitFor(() => expect(router.state.location.search).toEqual({ step: 'review' }));
    const body = calls(api.calls, 'PATCH', '/submissions/sub-1')[0]?.body as {
      fields: Record<string, string>;
      saveToProfile: string[];
    };
    expect(body.saveToProfile).toEqual(['fullName']);
    expect(body.fields).not.toHaveProperty('fullName');
  });

  it('an empty profile and nothing held: empty inputs, no source lines, no ticks', async () => {
    mockApi(
      withDetails(submission({ fields: {} }), {
        'GET /profile': { ...PROFILE, fullName: null },
        'GET /profile/application-details': { values: [], leftOut: [] },
      }),
    );
    renderStep('details');
    expect(await screen.findByLabelText('First name')).toHaveValue('');
    expect(screen.getByLabelText('Email')).toHaveValue('');
    await waitFor(() => expect(screen.queryByText(/^From your/)).toBeNull());
    expect(screen.queryByRole('checkbox', { name: /my profile/ })).toBeNull();
  });

  it('names a value Opportun holds but did not fill in, because it fails the checks', async () => {
    mockApi(
      withDetails(submission({ fields: { fullName: 'Jane Doe' } }), {
        'GET /profile/application-details': {
          values: [PREFILL.values[0]],
          leftOut: [{ key: 'phone', source: { kind: 'profile' } }],
        },
      }),
    );
    renderStep('details');
    const notice = await screen.findByRole('status', { name: /not filled in/i });
    expect(notice).toHaveTextContent(
      'Not filled in, because the value Opportun holds does not pass the checks: Phone (from your profile). Enter them if you need them.',
    );
  });

  it('start again keeps the expired attempt values and fills the rest from the server', async () => {
    const expired = submission({
      id: 'sub-old',
      status: 'abandoned',
      failureReason: 'review_expired',
      fields: { email: 'old@example.com', fullName: 'Jane Doe', linkedinUrl: 'linkedin.com/x' },
      answers: [],
    });
    // The server filled the new draft from the profile (#411): a phone and an email.
    const fresh = submission({
      id: 'sub-2',
      fields: { phone: '+1 555 0100', email: 'jane@example.com' },
      answers: [],
    });
    const api = mockApi({
      ...routes(null),
      'GET /opportunities/opp-1/submissions': { items: [expired], total: 1 },
      'POST /opportunities/opp-1/submissions': () => ({ status: 201, body: fresh }),
      'PATCH /submissions/sub-2': (c: ApiCall) => ({
        status: 200,
        body: { ...fresh, ...(c.body as object) },
      }),
    });
    const { user, router } = renderStep('resume');
    await user.click(await screen.findByRole('button', { name: 'Next: Details' }));
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ step: 'details', cleared: ['linkedinUrl'] }),
    );
    const [copy] = calls(api.calls, 'PATCH', '/submissions/sub-2');
    expect((copy?.body as { fields: unknown }).fields).toEqual({
      phone: '+1 555 0100',
      email: 'old@example.com',
      fullName: 'Jane Doe',
    });
  });
});
