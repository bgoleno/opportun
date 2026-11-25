// An application whose opportunity was merged into this one
// (https://github.com/bgoleno/opportun/issues/1057): the user is told, what still holds works, and it
// can be reviewed again. Against a stubbed API.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MergeDialog } from '@/components/opportunity/MergeDialog';
import type { OpportunityView } from '@/lib/opportunities';
import { formatDateTime } from '@/lib/opportunities';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import { ApplyPage } from './ApplyPage';
import { ApplyPanel } from './ApplyPanel';
import { ak, type SubmissionView } from './api';
import { postingMoved } from './parts';

const NOW = Date.UTC(2026, 10, 25, 12);
const HOUR = 60 * 60 * 1000;
const DEST = 'https://boards.greenhouse.io/examplecorp/jobs/1002';
const REF = { kind: 'ats_greenhouse', org: 'examplecorp', externalId: '1002', url: DEST };

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
  atsJobRef: REF,
  createdAt: NOW,
  updatedAt: NOW,
} as unknown as OpportunityView;

function submission(over: Partial<SubmissionView> = {}): SubmissionView {
  return {
    id: 'sub-1',
    opportunityId: 'opp-1',
    resumeId: 'res-1',
    atsKind: 'ats_greenhouse',
    atsRef: 'examplecorp',
    atsExternalId: '1002',
    destinationUrl: DEST,
    status: 'handed_off',
    idempotencyKey: 'k1',
    resumeSha256: 'f00dfeed'.repeat(8),
    resumeTitle: 'Jane Final',
    resumeStore: 'google_doc',
    fields: { fullName: 'Jane Doe', email: 'jane@example.com' },
    answers: [],
    reviewExpiresAt: null,
    reviewedAt: NOW - 3 * HOUR,
    handedOffAt: NOW - 2 * HOUR,
    prefillReadAt: null,
    submittedAt: null,
    confirmedAt: null,
    confirmationKind: null,
    failureReason: null,
    reapplyOf: null,
    reapplyReason: null,
    postingChangedAt: null,
    mergedAt: null,
    reviewLapsed: false,
    submittedActivityId: null,
    createdAt: NOW,
    updatedAt: NOW,
    reviewDigest: 'a'.repeat(64),
    snapshotState: 'ready',
    snapshotError: null,
    resumeAttachmentId: 'att-snap',
    ...over,
  } as SubmissionView;
}
/** Opened on the employer's site, and then its opportunity merged into this one. */
const lapsed = (over: Partial<SubmissionView> = {}) =>
  submission({ mergedAt: NOW - HOUR, reviewLapsed: true, ...over });
/** The same, reviewed again: a draft that was opened once. */
const draftAgain = (over: Partial<SubmissionView> = {}) =>
  submission({ status: 'draft', mergedAt: NOW - HOUR, ...over });

/** The extension could fill this form, were the review good. */
const CAN_FILL = { items: [{ scopes: ['apply:assist'], revokedAt: null }] };

function routes(sub: SubmissionView, extra: Record<string, unknown> = {}) {
  return {
    'GET /opportunities/opp-1': OPP,
    'GET /resumes': { items: [], total: 0 },
    'GET /device-tokens': CAN_FILL,
    'GET /opportunities/opp-1/submissions': { items: [sub], total: 1 },
    ...extra,
  };
}

function renderStep(step: 'details' | 'review' | 'open') {
  const user = userEvent.setup();
  const out = renderWithProviders(<ApplyPage opportunityId="opp-1" step={step} />, {
    path: `/opportunities/opp-1/apply?step=${step}`,
  });
  return { user, ...out };
}
const posts = (all: ApiCall[]) =>
  all.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);

const AFTER_OPENED =
  'Its opportunity was merged into this one after you opened it. The extension no longer fills it, as what you reviewed was for the merged one. It still goes to boards.greenhouse.io, REQ 1002.';
const NO_LONGER = 'Your review no longer holds. The extension no longer fills it.';
const MERGED_DRAFT =
  'Its opportunity was merged into this one. Check everything, then review it again.';
const OPENED_ONCE = `You opened this application on ${formatDateTime(NOW - 2 * HOUR)}. If you submitted it then, don't send it again.`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('opened, and then merged: "Finish on the application site"', () => {
  it('says what happened, where it goes and what can be done; nothing that is not so', async () => {
    mockApi(routes(lapsed({ prefillReadAt: NOW - 2 * HOUR })));
    renderStep('open');
    const notice = await screen.findByText(/merged into this one after you opened it/);
    expect(notice.closest('[role="status"]')).toHaveTextContent(
      `${AFTER_OPENED} If you submitted it, press I submitted it. If not, finish the form with the details below, or review it again to have it filled.`,
    );
    expect(document.body).not.toHaveTextContent(/fills in what you reviewed/);
    expect(document.body).not.toHaveTextContent(/press Fill in this application/);
    expect(document.body).not.toHaveTextContent(/can fill this form for you/);
    expect(document.body).not.toHaveTextContent(/Not filled by the extension yet/);
    // What holds without a review.
    expect(screen.getByText('Fill in the form, copying from your details below.')).toBeVisible();
    expect(screen.getByText('jane@example.com')).toBeVisible();
    expect(screen.getByRole('button', { name: 'I submitted it' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'I did not submit it' })).toBeEnabled();
  });

  it('stale for another cause: no merge is named', async () => {
    mockApi(routes(submission({ reviewLapsed: true })));
    renderStep('open');
    const notice = await screen.findByText(/Your review no longer holds/);
    expect(notice.closest('[role="status"]')).toHaveTextContent(
      `${NO_LONGER} It still goes to boards.greenhouse.io, REQ 1002.`,
    );
    expect(document.body).not.toHaveTextContent(/merged/);
  });

  it('merged, then reviewed and opened again, and stale later: no merge is named', async () => {
    mockApi(routes(lapsed({ reviewedAt: NOW })));
    renderStep('open');
    expect(await screen.findByText(/Your review no longer holds/)).toBeVisible();
    expect(document.body).not.toHaveTextContent(/merged/);
  });

  it('its review holding, merged or not: as it was', async () => {
    mockApi(routes(submission({ mergedAt: NOW - 4 * HOUR })));
    renderStep('open');
    expect(await screen.findByText(/It fills in what you reviewed/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Review it again' })).toBeNull();
    expect(document.body).not.toHaveTextContent(/merged|no longer holds/);
  });
});

describe('"Review it again"', () => {
  it.each(['open', 'review'] as const)(
    'on the %s step: asks first, then goes to the review',
    async (step) => {
      const { calls } = mockApi(
        routes(lapsed(), { 'POST /submissions/sub-1/review-again': draftAgain() }),
      );
      const { user, router } = renderStep(step);
      await user.click(await screen.findByRole('button', { name: 'Review it again' }));
      const dialog = await screen.findByRole('dialog', { name: 'Review this application again?' });
      expect(dialog).toHaveTextContent(
        'If you have already submitted it, press I submitted it instead.',
      );
      expect(posts(calls)).toEqual([]);
      await user.click(within(dialog).getByRole('button', { name: 'Review it again' }));
      await waitFor(() => expect(router.state.location.search).toMatchObject({ step: 'review' }));
      expect(router.state.location.pathname).toBe('/opportunities/opp-1/apply');
      // It posts no review itself (sec).
      expect(posts(calls)).toEqual(['POST /submissions/sub-1/review-again']);
      expect(calls.find((c) => c.path.endsWith('review-again'))?.body).toEqual({});
    },
  );

  it('from the panel too', async () => {
    const { calls } = mockApi(
      routes(lapsed(), { 'POST /submissions/sub-1/review-again': draftAgain() }),
    );
    const user = userEvent.setup();
    const { router } = renderWithProviders(<ApplyPanel opp={OPP} />);
    await user.click(await screen.findByRole('button', { name: 'Review it again' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review this application again?' });
    await user.click(within(dialog).getByRole('button', { name: 'Review it again' }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ step: 'review' }));
    expect(posts(calls)).toEqual(['POST /submissions/sub-1/review-again']);
  });

  it('left unpressed, nothing is sent', async () => {
    const { calls } = mockApi(routes(lapsed()));
    const { user } = renderStep('open');
    await user.click(await screen.findByRole('button', { name: 'Review it again' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review this application again?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(posts(calls)).toEqual([]);
  });

  it('refused, as it was recorded in another tab: said in words, and read again', async () => {
    const { calls } = mockApi(
      routes(lapsed(), {
        'POST /submissions/sub-1/review-again': () => ({
          status: 409,
          body: { error: { code: 'invalid_transition', from: 'submitted', to: 'draft' } },
        }),
      }),
    );
    const { user } = renderStep('open');
    await user.click(await screen.findByRole('button', { name: 'Review it again' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review this application again?' });
    const reads = () =>
      calls.filter((c) => c.method === 'GET' && c.path.endsWith('/submissions')).length;
    const before = reads();
    await user.click(within(dialog).getByRole('button', { name: 'Review it again' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).not.toHaveTextContent(/invalid_transition|Request failed/);
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });

  it('the review step of one opened, its review holding: as it was', async () => {
    mockApi(routes(submission()));
    renderStep('review');
    expect(await screen.findByRole('link', { name: 'See what to do next' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Review it again' })).toBeNull();
  });

  it('the review step of a lapsed one does not lead back to the step that leads to it', async () => {
    mockApi(routes(lapsed()));
    renderStep('review');
    expect(await screen.findByText(/merged into this one after you opened it/)).toBeVisible();
    expect(document.body).not.toHaveTextContent(/See what to do next/);
    expect(screen.getByRole('link', { name: 'Finish on the application site' })).toHaveAttribute(
      'href',
      expect.stringContaining('step=open'),
    );
  });
});

describe('the panel', () => {
  it('a lapsed one: what happened, and where to say what became of it', async () => {
    mockApi(routes(lapsed()));
    renderWithProviders(<ApplyPanel opp={OPP} />);
    const notice = await screen.findByText(/merged into this one after you opened it/);
    expect(notice.closest('[role="status"]')).toHaveTextContent(
      `${AFTER_OPENED} If you submitted it, say so in Instructions. If not, finish the form there, or review it again to have it filled.`,
    );
    expect(screen.getByRole('link', { name: 'Instructions' })).toBeVisible();
    // What is said of a draft is not.
    expect(document.body).not.toHaveTextContent(/Check everything|You opened this application/);
  });

  it('a draft whose opportunity was merged: until it is reviewed', async () => {
    mockApi(routes(draftAgain({ handedOffAt: null })));
    renderWithProviders(<ApplyPanel opp={OPP} />);
    const notice = await screen.findByText(/Its opportunity was merged into this one/);
    expect(notice.closest('[role="status"]')).toHaveTextContent(MERGED_DRAFT);
    expect(document.body).not.toHaveTextContent(/You opened this application/);
  });

  it('a draft never reviewed counts as merged', async () => {
    mockApi(routes(draftAgain({ handedOffAt: null, reviewedAt: null })));
    renderWithProviders(<ApplyPanel opp={OPP} />);
    expect(await screen.findByText(/Its opportunity was merged into this one/)).toBeVisible();
  });

  it('a draft that was opened once says when, and not to send it twice', async () => {
    mockApi(routes(draftAgain()));
    renderWithProviders(<ApplyPanel opp={OPP} />);
    expect(await screen.findByText(OPENED_ONCE)).toBeVisible();
  });

  it('reviewed again: it was opened once still, and "nothing has been sent" is not said', async () => {
    mockApi(
      routes(
        submission({
          status: 'reviewed',
          mergedAt: NOW - HOUR,
          reviewedAt: NOW,
          reviewExpiresAt: Date.now() + HOUR,
        }),
      ),
    );
    renderWithProviders(<ApplyPanel opp={OPP} />);
    expect(await screen.findByText(OPENED_ONCE)).toBeVisible();
    expect(screen.getByText('Your review is saved.')).toBeVisible();
    expect(document.body).not.toHaveTextContent(/Nothing has been sent|merged/);
  });

  it('control: reviewed, and not opened before', async () => {
    mockApi(
      routes(
        submission({
          status: 'reviewed',
          handedOffAt: null,
          reviewExpiresAt: Date.now() + HOUR,
        }),
      ),
    );
    renderWithProviders(<ApplyPanel opp={OPP} />);
    expect(
      await screen.findByText('Your review is saved. Nothing has been sent anywhere.'),
    ).toBeVisible();
  });

  it.each([
    ['opened before', NOW - 2 * HOUR],
    ['not opened before', null],
  ])('its last review expired, %s', async (_, handedOffAt) => {
    mockApi(
      routes(submission({ status: 'abandoned', failureReason: 'review_expired', handedOffAt })),
    );
    renderWithProviders(<ApplyPanel opp={OPP} />);
    const said = await screen.findByText(/Your last review expired/);
    expect(said).toHaveTextContent('Starting again keeps your details and answers.');
    if (handedOffAt === null) {
      expect(said).toHaveTextContent('Your last review expired before the form was opened.');
    } else {
      expect(said).toHaveTextContent(`Your last review expired. ${OPENED_ONCE}`);
      expect(said).not.toHaveTextContent(/before the form was opened/);
    }
  });

  it('a draft reviewed since, a reviewed one, and one never merged say nothing of it', async () => {
    for (const sub of [
      draftAgain({ handedOffAt: null, reviewedAt: NOW }),
      submission({
        status: 'reviewed',
        handedOffAt: null,
        mergedAt: NOW - HOUR,
        reviewedAt: NOW,
        reviewExpiresAt: Date.now() + HOUR,
      }),
      submission({ status: 'draft', handedOffAt: null }),
    ]) {
      mockApi(routes(sub));
      const { unmount } = renderWithProviders(<ApplyPanel opp={OPP} />);
      expect(await screen.findByRole('link', { name: /Continue/ })).toBeVisible();
      expect(document.body).not.toHaveTextContent(/merged|You opened this application/);
      unmount();
    }
  });
});

describe('the review step of a draft that was merged, or opened once', () => {
  it('says both', async () => {
    mockApi(routes(draftAgain()));
    renderStep('review');
    const notice = await screen.findByText(/Its opportunity was merged into this one/);
    expect(notice.closest('[role="status"]')).toHaveTextContent(MERGED_DRAFT);
    expect(screen.getByText(OPENED_ONCE)).toBeVisible();
  });

  it('reviewed again, the button that opens the form has the warning above it', async () => {
    mockApi(
      routes(
        submission({
          status: 'reviewed',
          mergedAt: NOW - HOUR,
          reviewedAt: NOW,
          reviewExpiresAt: Date.now() + HOUR,
        }),
      ),
    );
    renderStep('review');
    expect(await screen.findByRole('button', { name: /^Open boards/ })).toBeVisible();
    expect(screen.getByText(OPENED_ONCE)).toBeVisible();
  });

  it.each([
    ['opened before', NOW - 2 * HOUR],
    ['not opened before', null],
  ])('its review expired and it was closed, %s', async (_, handedOffAt) => {
    mockApi(
      routes(submission({ status: 'abandoned', failureReason: 'review_expired', handedOffAt })),
    );
    renderStep('review');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Your review expired and this application was closed.');
    if (handedOffAt === null) expect(alert).toHaveTextContent('Nothing was submitted.');
    else {
      expect(alert).toHaveTextContent(OPENED_ONCE);
      expect(alert).not.toHaveTextContent(/Nothing was submitted/);
    }
  });

  it('refused, as it was recorded in another tab: it is said to be submitted (qa on #1072)', async () => {
    let now = lapsed();
    mockApi({
      ...routes(now),
      'GET /opportunities/opp-1/submissions': () => ({ items: [now], total: 1 }),
      'POST /submissions/sub-1/review-again': () => {
        now = submission({ status: 'submitted', submittedAt: NOW - HOUR });
        return { status: 409, body: { error: { code: 'invalid_transition' } } };
      },
    });
    const { user } = renderStep('open');
    await user.click(await screen.findByRole('button', { name: 'Review it again' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review this application again?' });
    await user.click(within(dialog).getByRole('button', { name: 'Review it again' }));
    expect(
      await screen.findByText(/This application is recorded as submitted on/),
    ).toHaveTextContent(formatDateTime(NOW - HOUR));
    expect(screen.getByRole('link', { name: 'See this application' })).toHaveAttribute(
      'href',
      '/opportunities/opp-1/applications/sub-1',
    );
    expect(document.body).not.toHaveTextContent(/has not started yet/);
  });

  it('control: one that was cancelled, and none', async () => {
    mockApi(routes(submission({ status: 'abandoned', failureReason: 'cancelled_by_user' })));
    renderStep('open');
    expect(await screen.findByText(/has not started yet/)).toBeVisible();
  });

  it('neither, for a draft that was neither', async () => {
    mockApi(routes(submission({ status: 'draft', handedOffAt: null })));
    renderStep('review');
    expect(await screen.findByRole('checkbox')).toBeVisible();
    expect(document.body).not.toHaveTextContent(/merged|You opened this application/);
  });
});

describe('the posting-changed notice names another job, and only another', () => {
  const at = (over: Partial<OpportunityView>) => ({ ...OPP, ...over });
  const careers = (id: string) => `https://www.examplecorp.example/jobs?gh_jid=${id}`;
  it.each([
    ['the same job, confirmed', { atsJobRef: REF, postingUrl: DEST }, {}, false],
    ['another, confirmed', { atsJobRef: { ...REF, externalId: '9' } }, {}, true],
    ['the same link, not confirmed', { atsJobRef: null, postingUrl: DEST }, {}, false],
    ['the same job on a careers page', { atsJobRef: null, postingUrl: careers('1002') }, {}, false],
    ['another on a careers page', { atsJobRef: null, postingUrl: careers('9') }, {}, true],
    [
      'another link, not confirmed',
      { atsJobRef: null, postingUrl: DEST.replace('1002', '9') },
      {},
      true,
    ],
    ['no link', { atsJobRef: null, postingUrl: null }, {}, true],
    ['a link no site reads', { atsJobRef: null, postingUrl: 'https://a.example/1' }, {}, true],
    ['no link, merged into it', { atsJobRef: null, postingUrl: null }, { mergedAt: NOW }, false],
    [
      'no link, merged into it and reviewed since',
      { atsJobRef: null, postingUrl: null },
      { mergedAt: NOW, reviewedAt: NOW + 1 },
      false,
    ],
    [
      'no link, its posting changed before it was merged into it',
      { atsJobRef: null, postingUrl: null },
      { mergedAt: NOW, postingChangedAt: NOW - 1 },
      false,
    ],
    [
      'no link, its posting changed at the merge',
      { atsJobRef: null, postingUrl: null },
      { mergedAt: NOW, postingChangedAt: NOW },
      true,
    ],
    [
      'no link, its posting changed after it, and it was reviewed since',
      { atsJobRef: null, postingUrl: null },
      { mergedAt: NOW, postingChangedAt: NOW + 1, reviewedAt: NOW + 2 },
      true,
    ],
    [
      'another, merged into it',
      { atsJobRef: { ...REF, externalId: '9' } },
      { mergedAt: NOW },
      true,
    ],
  ] as [string, Partial<OpportunityView>, Partial<SubmissionView>, boolean][])(
    '%s',
    (_, opp, live, expected) => {
      expect(postingMoved(submission(live), at(opp))).toBe(expected);
    },
  );

  it('an unconfirmed link of another job is named by its job', async () => {
    const opp = at({ atsJobRef: null, postingUrl: DEST.replace('1002', '2002') });
    mockApi(routes(submission({ status: 'draft' }), { 'GET /opportunities/opp-1': opp }));
    renderWithProviders(<ApplyPanel opp={opp} />);
    const notice = await screen.findByText(/The posting changed after you started/);
    expect(notice.closest('[role="status"]')).toHaveTextContent(
      'The posting is now boards.greenhouse.io, REQ 2002.',
    );
  });
});

describe('the merge dialog says what becomes of the application', () => {
  const TARGET = { ...OPP, id: 'opp-2', title: 'Staff Product Manager' } as OpportunityView;
  async function confirmStep(items: SubmissionView[] | null) {
    mockApi({
      'GET /opportunities': { items: [TARGET], total: 1 },
      'GET /opportunities/opp-1/submissions':
        items === null
          ? () => ({ status: 404, body: { error: { code: 'feature_unavailable' } } })
          : { items, total: items.length },
    });
    const user = userEvent.setup();
    const { queryClient } = renderWithProviders(
      <MergeDialog opp={OPP} open onOpenChange={vi.fn()} />,
    );
    await user.click(await screen.findByRole('button', { name: /Staff Product Manager/ }));
    // Its applications are read, and drawn: what is not said then is not said.
    await waitFor(() =>
      expect(queryClient.getQueryState(ak.submissions('opp-1'))?.status).toBe('success'),
    );
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    return await screen.findByRole('dialog', { name: 'Merge these opportunities?' });
  }
  const MOVES =
    'The activities, next steps, messages, resumes and files of the merged opportunity move to the kept one, which keeps the more advanced stage. This cannot be undone.';
  const MOVES_IT =
    'The activities, next steps, messages, resumes and files of the merged opportunity, and its application, move to the kept one, which keeps the more advanced stage. This cannot be undone.';
  const REVIEW = 'Its application to Greenhouse moves too, and has to be reviewed again.';
  const OPEN =
    'Its application is open on boards.greenhouse.io. It moves too, but the extension will no longer fill it: finish it and record it first, or review it again afterwards.';

  it.each([
    ['draft', [submission({ status: 'draft' })], [MOVES, REVIEW], [OPEN]],
    ['reviewed', [submission({ status: 'reviewed' })], [MOVES, REVIEW], [OPEN]],
    ['open on the employer’s site', [submission()], [MOVES, OPEN], [REVIEW]],
    ['submitted', [submission({ status: 'submitted' })], [MOVES_IT], [REVIEW, OPEN]],
    ['none', [], [MOVES], [REVIEW, OPEN]],
    ['assisted apply off', null, [MOVES], [REVIEW, OPEN]],
  ] as [string, SubmissionView[] | null, string[], string[]][])(
    '%s',
    async (_, items, said, unsaid) => {
      const dialog = await confirmStep(items);
      for (const text of said) await waitFor(() => expect(dialog).toHaveTextContent(text));
      for (const text of unsaid) expect(dialog).not.toHaveTextContent(text);
      expect(within(dialog).getByRole('button', { name: 'Merge' })).toBeEnabled();
    },
  );
});

describe('a merge, where the kept one was looked at a moment before', () => {
  it('its applications are read again: the one that moved there is shown', async () => {
    const TARGET = { ...OPP, id: 'opp-2', title: 'Staff Product Manager' } as OpportunityView;
    mockApi({
      'GET /opportunities': { items: [TARGET], total: 1 },
      'GET /opportunities/opp-1/submissions': { items: [submission()], total: 1 },
      'GET /opportunities/opp-2/submissions': {
        items: [lapsed({ opportunityId: 'opp-2' })],
        total: 1,
      },
      'POST /opportunities/opp-2/merge': TARGET,
    });
    const user = userEvent.setup();
    const { queryClient } = renderWithProviders(
      <MergeDialog opp={OPP} open onOpenChange={vi.fn()} />,
    );
    queryClient.setQueryData(ak.submissions('opp-2'), { items: [], total: 0 });
    await user.click(await screen.findByRole('button', { name: /Staff Product Manager/ }));
    await user.click(await screen.findByRole('button', { name: 'Merge' }));
    await waitFor(() =>
      expect(queryClient.getQueryState(ak.submissions('opp-2'))?.isInvalidated).toBe(true),
    );
  });
});

// The page of the merged-away opportunity, left open in another tab (qa on #1057).
describe('the tab left on the merged one', () => {
  const GONE = () => ({ status: 404, body: { error: { code: 'not_found' } } });
  /** The page is read, and then its opportunity is merged into opp-2. */
  function merged(
    before: SubmissionView,
    after: SubmissionView | null,
    extra: Record<string, unknown> = {},
  ) {
    let gone = false;
    const { calls } = mockApi({
      ...routes(before),
      'GET /opportunities/opp-1': () => (gone ? GONE() : OPP),
      'GET /opportunities/opp-1/submissions': () => (gone ? GONE() : { items: [before], total: 1 }),
      'GET /submissions/sub-1': () => (after === null ? GONE() : after),
      ...Object.fromEntries(
        Object.entries(extra).map(([k, v]) => [
          k,
          () => {
            gone = true;
            return v;
          },
        ]),
      ),
    });
    return { calls, merge: () => (gone = true) };
  }
  const moved = (over: Partial<SubmissionView> = {}) => lapsed({ opportunityId: 'opp-2', ...over });

  it('"I submitted it" is recorded, and it goes to the opportunity it is on', async () => {
    merged(submission(), null, {
      'POST /submissions/sub-1/attest': moved({ status: 'submitted', reviewLapsed: false }),
    });
    const { user, router } = renderStep('open');
    await user.click(await screen.findByRole('button', { name: 'I submitted it' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /record|submitted/i }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/opportunities/opp-2'));
    expect(document.body).not.toHaveTextContent(/Not found/);
  });

  it('recorded there while it looks where it went: it stays where the record took it', async () => {
    let answer: () => void = () => undefined;
    const looked = new Promise<void>((resolve) => {
      answer = resolve;
    });
    let gone = false;
    const { calls } = mockApi({
      ...routes(submission()),
      'GET /opportunities/opp-1': () => (gone ? GONE() : OPP),
      'GET /opportunities/opp-1/submissions': () =>
        gone ? GONE() : { items: [submission()], total: 1 },
      'GET /submissions/sub-1': async () => {
        await looked;
        return moved();
      },
      'POST /submissions/sub-1/attest': () => {
        gone = true;
        return moved({ status: 'submitted', reviewLapsed: false });
      },
    });
    const { user, router } = renderStep('open');
    await user.click(await screen.findByRole('button', { name: 'I submitted it' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /record|submitted/i }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/opportunities/opp-2'));
    expect(calls.some((c) => c.path === '/submissions/sub-1')).toBe(true);
    answer();
    await new Promise((done) => setTimeout(done, 200));
    expect(router.state.location.pathname).toBe('/opportunities/opp-2');
  });

  it('"I did not submit it": the same', async () => {
    merged(submission(), null, {
      'POST /submissions/sub-1/cancel': moved({ status: 'abandoned', reviewLapsed: false }),
    });
    const { user, router } = renderStep('open');
    await user.click(await screen.findByRole('button', { name: 'I did not submit it' }));
    await user.click(await screen.findByRole('button', { name: 'Stop application' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/opportunities/opp-2'));
  });

  it.each(['open', 'review', 'details'] as const)(
    'read again: to the same step (%s) of the one it is on, in place of this one',
    async (step) => {
      const before =
        step === 'open' ? submission() : submission({ status: 'draft', handedOffAt: null });
      const { calls, merge } = merged(before, moved({ status: before.status }));
      const { router, queryClient } = renderStep(step);
      await screen.findByRole('heading', { level: 1 });
      const length = router.history.length;
      merge();
      await queryClient.invalidateQueries();
      await waitFor(() =>
        expect(router.state.location.pathname).toBe('/opportunities/opp-2/apply'),
      );
      expect(router.state.location.search).toMatchObject({ step });
      expect(router.history.length).toBe(length);
      expect(posts(calls)).toEqual([]);
      expect(document.body).not.toHaveTextContent(
        /not available here|could not be loaded|Not found/,
      );
    },
  );

  it('the hand-off refused for it: to the review of the one it is on, and no tab is left', async () => {
    const tab = { opener: window, location: { href: 'about:blank' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    const reviewed = submission({
      status: 'reviewed',
      handedOffAt: null,
      reviewExpiresAt: Date.now() + HOUR,
    });
    merged(reviewed, moved({ status: 'draft', handedOffAt: null, reviewLapsed: false }), {
      'POST /submissions/sub-1/handoff': {
        status: 409,
        body: { error: { code: 'invalid_transition', from: 'draft', to: 'handed_off' } },
      },
    });
    const { user, router } = renderStep('review');
    await user.click(await screen.findByRole('button', { name: /^Open boards/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/opportunities/opp-2/apply'));
    expect(router.state.location.search).toMatchObject({ step: 'review' });
    expect(tab.close).toHaveBeenCalled();
    expect(tab.location.href).toBe('about:blank');
  });

  it('the application gone too: as before', async () => {
    const { merge } = merged(submission(), null);
    const { router, queryClient } = renderStep('open');
    await screen.findByRole('heading', { level: 1 });
    merge();
    await queryClient.invalidateQueries();
    expect(
      await screen.findByText(/could not be loaded|Assisted apply is not available here/),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/opportunities/opp-1/apply');
  });

  it('loaded afresh, it holds no application: as before, and none is asked for', async () => {
    const { calls, merge } = merged(submission(), moved());
    merge();
    const { router } = renderStep('open');
    expect(await screen.findByText('This opportunity could not be loaded.')).toBeVisible();
    expect(router.state.location.pathname).toBe('/opportunities/opp-1/apply');
    expect(calls.some((c) => c.path === '/submissions/sub-1')).toBe(false);
  });

  it('another opportunity’s page, not there, does not go where the one before it went', async () => {
    const { calls } = merged(submission(), moved());
    const user = userEvent.setup();
    function Pages() {
      const [id, setId] = useState('opp-1');
      return (
        <>
          <button type="button" onClick={() => setId('opp-9')}>
            Another
          </button>
          <ApplyPage opportunityId={id} step="open" />
        </>
      );
    }
    const { router } = renderWithProviders(<Pages />, {
      path: '/opportunities/opp-1/apply?step=open',
    });
    await screen.findByRole('heading', { level: 1 });
    await user.click(screen.getByRole('button', { name: 'Another' }));
    expect(await screen.findByText('This opportunity could not be loaded.')).toBeVisible();
    expect(router.state.location.pathname).toBe('/opportunities/opp-1/apply');
    expect(calls.some((c) => c.path === '/submissions/sub-1')).toBe(false);
  });

  it('an opportunity that cannot be read for another cause is not left', async () => {
    let down = false;
    const { calls } = mockApi({
      ...routes(submission()),
      'GET /opportunities/opp-1': () =>
        down ? { status: 500, body: { error: { code: 'internal' } } } : OPP,
      'GET /submissions/sub-1': moved(),
    });
    const { router, queryClient } = renderStep('open');
    await screen.findByRole('heading', { level: 1 });
    down = true;
    await queryClient.invalidateQueries();
    // Were it to look, it would by now.
    await new Promise((done) => setTimeout(done, 200));
    expect(calls.some((c) => c.path === '/submissions/sub-1')).toBe(false);
    expect(router.state.location.pathname).toBe('/opportunities/opp-1/apply');
  });
});
