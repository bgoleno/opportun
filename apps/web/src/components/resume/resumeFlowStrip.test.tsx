// The next-step strip on a tailored resume's own page (https://github.com/bgoleno/opportun/issues/447,
// slice 3 of #400), with tl's rulings (https://github.com/bgoleno/opportun/issues/447#issuecomment-6842084292):
// one test per state the strip can show, then its actions, the shared Score again, and the quiet
// "Change status".
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { SubmissionView } from '@/components/apply/api';
import { formatDate, type OpportunityView } from '@/lib/opportunities';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import type { MatchReportView, Resume, ResumeSend } from './api';
import { ResumeWorkspace } from './ResumeWorkspace';

const NOW = Date.now();
const DEST = 'https://boards.greenhouse.io/examplecorp/jobs/1000001';

const OPP = {
  id: 'opp-1',
  companyName: 'Acme',
  title: 'Staff PM',
  stage: 'preparing',
  postingUrl: DEST,
  postingState: 'confirmed',
  atsJobRef: { kind: 'ats_greenhouse', org: 'examplecorp', externalId: '1000001', url: DEST },
} as unknown as OpportunityView;

const BASE: Resume = {
  id: 'base',
  kind: 'base',
  opportunityId: null,
  title: 'Jane base',
  store: 'google_doc',
  docRef: 'doc-base',
  url: 'https://docs.google.com/document/d/base/edit',
  parentResumeId: null,
  status: 'final',
  submittedAt: null,
  submittedTo: null,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
};

const copy = (over: Partial<Resume> = {}): Resume => ({
  ...BASE,
  id: 'copy',
  kind: 'tailored',
  opportunityId: 'opp-1',
  title: 'Acme tailored',
  docRef: 'doc-copy',
  url: 'https://docs.google.com/document/d/copy/edit',
  parentResumeId: 'base',
  status: 'draft',
  createdAt: 5,
  ...over,
});

const SEND: ResumeSend = {
  id: 'send-1',
  opportunityId: 'opp-1',
  opportunityTitle: 'Staff PM',
  companyName: 'Acme',
  resumeId: 'copy',
  resumeTitle: 'Acme tailored',
  resumeKind: 'tailored',
  sentAt: NOW,
  sentVia: 'Indeed',
  submissionId: null,
  createdAt: NOW,
};

const REPORT: MatchReportView = {
  report: { score: 78, missingKeywords: [], weakAreas: [], summary: 'Good fit.' },
  scoredAt: NOW,
  stale: false,
};

const attempt = (over: Partial<SubmissionView>): SubmissionView =>
  ({
    id: 'sub-1',
    opportunityId: 'opp-1',
    resumeId: 'copy',
    resumeTitle: 'Acme tailored',
    atsKind: 'ats_greenhouse',
    status: 'draft',
    submittedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }) as SubmissionView;

interface Setup {
  /** The page's resume; one of `resumes`, or not (an archived copy). */
  page?: Resume;
  resumes?: Resume[];
  sends?: ResumeSend[];
  /** null: assisted apply is off here (the route answers 404). */
  attempts?: SubmissionView[] | null;
  opp?: Partial<OpportunityView> | null;
  extra?: Record<string, unknown>;
}

/** The resume page, with every list the strip reads answered as the server would. */
function setup({
  page = copy(),
  resumes = [BASE, page],
  sends = [],
  attempts = [],
  opp = {},
  extra = {},
}: Setup = {}) {
  const api = mockApi({
    [`GET /resumes/${page.id}`]: page,
    [`GET /resumes/${page.id}/match`]: REPORT,
    'GET /resumes': (call: ApiCall) => {
      const items = call.search.includes('opportunityId')
        ? resumes.filter((r) => r.opportunityId === 'opp-1')
        : call.search.includes('kind=base')
          ? resumes.filter((r) => r.kind === 'base')
          : resumes;
      return { items, total: items.length };
    },
    ...(opp === null ? {} : { 'GET /opportunities/opp-1': { ...OPP, ...opp } }),
    'GET /opportunities/opp-1/resume-sends': { items: sends },
    ...(attempts === null
      ? {}
      : {
          'GET /opportunities/opp-1/submissions': { items: attempts, total: attempts.length },
        }),
    ...extra,
  });
  const user = userEvent.setup();
  renderWithProviders(<ResumeWorkspace id={page.id} />);
  return { api, user };
}

const strip = () => screen.findByRole('region', { name: 'Next step for this resume' });

function currentStep(region: HTMLElement): string | null {
  const steps = within(region).getByRole('list', { name: 'Resume steps' });
  return steps.querySelector('[aria-current="step"]')?.textContent ?? null;
}

/** The strip's filled actions (buttons and links styled as the default button). */
const filled = (region: HTMLElement) =>
  region.querySelectorAll<HTMLElement>('[data-slot="button"][data-variant="default"]');

function primary(region: HTMLElement): HTMLElement {
  const all = filled(region);
  expect(all).toHaveLength(1);
  return all[0]!;
}

const said = (region: HTMLElement) => within(region).getByRole('heading', { level: 2 });

describe('the resume page strip: one test per state (#447)', () => {
  it('C: a Draft copy: step 2 Tailor, "Mark as final", and Score again beside it', async () => {
    setup();
    const region = await strip();
    await waitFor(() =>
      expect(said(region)).toHaveTextContent('Tailor "Acme tailored" for this role.'),
    );
    expect(within(region).getByText('For Staff PM at Acme')).toBeInTheDocument();
    expect(currentStep(region)).toMatch(/^2 Tailor/);
    expect(primary(region)).toHaveAccessibleName('Mark as final');
    expect(within(region).getByRole('button', { name: 'Score again' })).toBeInTheDocument();
  });

  it('D: a copy In review: step 3 Finish, "Mark as final"', async () => {
    setup({ page: copy({ status: 'in_review' }) });
    const region = await strip();
    await waitFor(() => expect(said(region)).toHaveTextContent('Finished tailoring?'));
    expect(currentStep(region)).toMatch(/^3 Finish/);
    expect(primary(region)).toHaveAccessibleName('Mark as final');
  });

  it('E: Final, assisted apply can start: "Apply on Greenhouse" to the apply flow', async () => {
    setup({ page: copy({ status: 'final' }) });
    const region = await strip();
    await waitFor(() => expect(said(region)).toHaveTextContent('Ready to apply.'));
    expect(currentStep(region)).toMatch(/^4 Apply/);
    expect(primary(region)).toHaveAccessibleName('Apply on Greenhouse');
    expect(primary(region)).toHaveAttribute('href', '/opportunities/opp-1/apply?step=resume');
  });

  it('F: Final, but assisted apply cannot start: the reason, and no apply link', async () => {
    setup({
      page: copy({ status: 'final' }),
      opp: { postingState: 'needs_review' } as Partial<OpportunityView>,
    });
    const region = await strip();
    await waitFor(() =>
      expect(said(region)).toHaveTextContent(
        "This opportunity's posting needs review. Confirm it on the Details tab first.",
      ),
    );
    expect(currentStep(region)).toMatch(/^4 Apply/);
    expect(primary(region)).toHaveAccessibleName('Back to the opportunity');
    expect(primary(region)).toHaveAttribute('href', '/opportunities/opp-1?tab=resume');
    expect(within(region).queryByText(/Apply on/)).toBeNull();
  });

  it('F: Final with assisted apply off: "Ready to send.", back to the opportunity', async () => {
    setup({ page: copy({ status: 'final' }), attempts: null });
    const region = await strip();
    await waitFor(() => expect(said(region)).toHaveTextContent('Ready to send.'));
    expect(primary(region)).toHaveAccessibleName('Back to the opportunity');
    expect(within(region).queryByText(/Apply on/)).toBeNull();
  });

  it('G: an attempt in progress: where it is, back to the opportunity', async () => {
    setup({ page: copy({ status: 'final' }), attempts: [attempt({ status: 'draft' })] });
    const region = await strip();
    await waitFor(() =>
      expect(said(region)).toHaveTextContent('Your application is saved as a draft.'),
    );
    expect(currentStep(region)).toMatch(/^4 Apply/);
    expect(primary(region)).toHaveAccessibleName('Back to the opportunity');
  });

  it('H: a send recorded: every step done, no filled button, a quiet way back', async () => {
    setup({ page: copy({ status: 'final' }), sends: [SEND] });
    const region = await strip();
    await waitFor(() =>
      expect(said(region)).toHaveTextContent(
        `Sent: Acme tailored via Indeed on ${formatDate(NOW)}.`,
      ),
    );
    expect(currentStep(region)).toBeNull();
    expect(filled(region)).toHaveLength(0);
    expect(within(region).getByRole('link', { name: 'Back to the opportunity' })).toHaveAttribute(
      'href',
      '/opportunities/opp-1?tab=resume',
    );
  });

  it("a copy that is not the flow's resume: no steps and no action, the line names the one it follows", async () => {
    const older = copy({ id: 'older', title: 'Acme first try', createdAt: 2 });
    setup({ page: older, resumes: [BASE, older, copy({ createdAt: 9 })] });
    const region = await strip();
    const link = await within(region).findByRole('link', { name: 'Acme tailored' });
    expect(link).toHaveAttribute('href', '/resumes/copy');
    expect(region).toHaveTextContent(
      "Acme tailored is the resume this opportunity's flow follows.",
    );
    expect(within(region).queryByRole('list', { name: 'Resume steps' })).toBeNull();
    expect(within(region).queryAllByRole('button')).toHaveLength(0);
  });

  it('an archived copy with no other: the line links the opportunity', async () => {
    const archived = copy({ archivedAt: NOW });
    setup({ page: archived, resumes: [BASE, archived] });
    const region = await strip();
    const link = await within(region).findByRole('link', { name: 'the opportunity' });
    expect(link).toHaveAttribute('href', '/opportunities/opp-1?tab=resume');
    expect(within(region).queryByRole('list', { name: 'Resume steps' })).toBeNull();
  });

  it('an opportunity that cannot be read: no strip, and the page as it is today', async () => {
    setup({ opp: null });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Acme tailored' }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'View opportunity' })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('region', { name: 'Next step for this resume' })).toBeNull();
  });

  it("a base resume's page: no strip, and the Status select as it is", async () => {
    setup({ page: BASE, resumes: [BASE] });
    expect(await screen.findByLabelText('Status')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Next step for this resume' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change status' })).toBeNull();
  });
});

// tl's review of #490 at fe9b1f4, blocking 1: after a send, "Tailor again" makes a new copy. The
// flow stays H with that copy as `again`, and its own page is where its next step happens.
describe('the resume page strip: the copy "Tailor again" made (#447)', () => {
  const sent = copy({ status: 'final' });
  const again = (status: Resume['status']) =>
    copy({ id: 'again', title: 'Acme second try', status, createdAt: 9 });

  it('a Draft copy made after a send: its own step and "Mark as final", not the old send', async () => {
    const page = again('draft');
    setup({ page, resumes: [BASE, sent, page], sends: [SEND] });
    const region = await strip();
    await waitFor(() =>
      expect(said(region)).toHaveTextContent('Tailor "Acme second try" for this role.'),
    );
    expect(currentStep(region)).toMatch(/^2 Tailor/);
    expect(primary(region)).toHaveAccessibleName('Mark as final');
    expect(within(region).getByRole('button', { name: 'Score again' })).toBeInTheDocument();
    expect(region).not.toHaveTextContent(/^Sent:/);
  });

  it('In review: step 3 and "Mark as final"', async () => {
    const page = again('in_review');
    setup({ page, resumes: [BASE, sent, page], sends: [SEND] });
    const region = await strip();
    await waitFor(() => expect(said(region)).toHaveTextContent('Finished tailoring?'));
    expect(currentStep(region)).toMatch(/^3 Finish/);
    expect(primary(region)).toHaveAccessibleName('Mark as final');
  });

  it('a Final copy made after a send: "Back to the opportunity" is filled, where its send is recorded', async () => {
    const page = again('final');
    setup({ page, resumes: [BASE, sent, page], sends: [SEND] });
    const region = await strip();
    await waitFor(() => expect(said(region)).toHaveTextContent('Ready to send.'));
    expect(currentStep(region)).toMatch(/^4 Apply/);
    expect(primary(region)).toHaveAccessibleName('Back to the opportunity');
    expect(primary(region)).toHaveAttribute('href', '/opportunities/opp-1?tab=resume');
  });

  it("the sent copy's own page is no longer the one the flow follows", async () => {
    const page = again('draft');
    setup({ page: sent, resumes: [BASE, sent, page], sends: [SEND] });
    const region = await strip();
    expect(await within(region).findByRole('link', { name: 'Acme second try' })).toHaveAttribute(
      'href',
      '/resumes/again',
    );
  });
});

describe('the resume page strip: actions (#447)', () => {
  it('Mark as final: focus moves to the new sentence, it is announced, and the toast shows though a list answers late', async () => {
    let status: Resume['status'] = 'in_review';
    const { api, user } = setup({
      page: copy({ status: 'in_review' }),
      extra: {
        'GET /resumes/copy': () => ({ status: 200, body: copy({ status }) }),
        'GET /resumes': async (call: ApiCall) => {
          const mine = call.search.includes('opportunityId');
          if (status === 'final' && mine) await new Promise((r) => setTimeout(r, 50));
          const items = call.search.includes('kind=base')
            ? [BASE]
            : mine
              ? [copy({ status })]
              : [BASE, copy({ status })];
          return { items, total: items.length };
        },
        'PATCH /resumes/copy': (call: ApiCall) => {
          status = (call.body as { status: Resume['status'] }).status;
          return { status: 200, body: copy({ status }) };
        },
      },
    });
    const region = await strip();
    await waitFor(() => expect(primary(region)).toHaveAccessibleName('Mark as final'));
    await user.click(primary(region));
    await waitFor(() => expect(said(region)).toHaveTextContent('Ready to apply.'));
    expect(api.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ status: 'final' });
    expect(said(region)).toHaveFocus();
    expect(within(region).getByRole('status')).toHaveTextContent('Marked final. Next: apply.');
    expect(await screen.findByText('Marked final')).toBeInTheDocument();
  });

  it('a refused Mark as final says why in the strip', async () => {
    const { user } = setup({
      page: copy({ status: 'in_review' }),
      extra: {
        'PATCH /resumes/copy': () => ({
          status: 409,
          body: { error: { code: 'conflict', message: 'This resume changed elsewhere.' } },
        }),
      },
    });
    const region = await strip();
    await waitFor(() => expect(primary(region)).toHaveAccessibleName('Mark as final'));
    await user.click(primary(region));
    expect(await within(region).findByRole('alert')).toBeInTheDocument();
    expect(said(region)).toHaveTextContent('Finished tailoring?');
  });

  it('a list that failed to load shows the error, with no step and no action', async () => {
    setup({
      extra: {
        'GET /opportunities/opp-1/resume-sends': () => ({
          status: 500,
          body: { error: { code: 'internal', message: 'Server down' } },
        }),
      },
    });
    const region = await strip();
    expect(await within(region).findByRole('alert')).toBeInTheDocument();
    expect(within(region).queryByRole('list', { name: 'Resume steps' })).toBeNull();
    expect(filled(region)).toHaveLength(0);
  });

  // tl's ruling 3: the strip's Score again and the match report's share one pending state, so
  // one click on each cannot send two scoring requests (each an AI call).
  it("Score again in the strip disables the report's own, and one scoring request is sent", async () => {
    let answer: () => void = () => undefined;
    const { api, user } = setup({
      extra: {
        'POST /resumes/copy/match': () =>
          new Promise((resolve) => {
            answer = () => resolve(REPORT);
          }),
      },
    });
    const region = await strip();
    const report = (await screen.findByRole('heading', { name: 'Match report' })).closest(
      '[data-slot="card"]',
    ) as HTMLElement;
    await waitFor(() =>
      expect(within(report).getByRole('button', { name: 'Score again' })).toBeEnabled(),
    );
    await user.click(within(region).getByRole('button', { name: 'Score again' }));
    await waitFor(() =>
      expect(within(report).getByRole('button', { name: 'Scoring...' })).toBeDisabled(),
    );
    expect(within(region).getByRole('button', { name: 'Scoring...' })).toBeDisabled();
    await user.click(within(report).getByRole('button', { name: 'Scoring...' }));
    expect(
      api.calls.filter((c) => c.method === 'POST' && c.path === '/resumes/copy/match'),
    ).toHaveLength(1);
    await act(async () => answer());
  });

  // #517: the other way round. The match report's Score again disables the strip's, so a click
  // on each still sends one scoring request (each an AI call).
  it("Score again in the report disables the strip's own, and one scoring request is sent", async () => {
    let answer: () => void = () => undefined;
    const { api, user } = setup({
      extra: {
        'POST /resumes/copy/match': () =>
          new Promise((resolve) => {
            answer = () => resolve(REPORT);
          }),
      },
    });
    const region = await strip();
    const report = (await screen.findByRole('heading', { name: 'Match report' })).closest(
      '[data-slot="card"]',
    ) as HTMLElement;
    await waitFor(() =>
      expect(within(region).getByRole('button', { name: 'Score again' })).toBeEnabled(),
    );
    await waitFor(() =>
      expect(within(report).getByRole('button', { name: 'Score again' })).toBeEnabled(),
    );
    await user.click(within(report).getByRole('button', { name: 'Score again' }));
    await waitFor(() =>
      expect(within(region).getByRole('button', { name: 'Scoring...' })).toBeDisabled(),
    );
    await user.click(within(region).getByRole('button', { name: 'Scoring...' }));
    expect(
      api.calls.filter((c) => c.method === 'POST' && c.path === '/resumes/copy/match'),
    ).toHaveLength(1);
    await act(async () => answer());
  });
});

describe('the resume page: "Change status" (#447)', () => {
  it('is a quiet button that opens the Status select in place, with focus on it', async () => {
    const { user } = setup();
    const toggle = await screen.findByRole('button', { name: 'Change status' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Status')).toBeNull();
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Status')).toHaveFocus();
  });

  it('keeps every status: Submitted still asks where it went', async () => {
    const { api, user } = setup({
      extra: {
        'PATCH /resumes/copy': (call: ApiCall) => ({
          status: 200,
          body: copy({ ...(call.body as Partial<Resume>) }),
        }),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Change status' }));
    await user.selectOptions(screen.getByLabelText('Status'), 'submitted');
    await user.type(screen.getByLabelText('Submitted to'), 'Acme careers');
    await user.click(screen.getByRole('button', { name: 'Mark submitted' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'PATCH')?.body).toEqual({
        status: 'submitted',
        submittedTo: 'Acme careers',
      }),
    );
  });
});

// https://github.com/bgoleno/opportun/issues/596: finished steps link to what they made, except
// where that is the page you are on.
describe('the resume page strip: finished steps as links (#596)', () => {
  it("on a Final copy's own page, Base links to its base, and Tailor and Finish stay plain", async () => {
    setup({ page: copy({ status: 'final' }) });
    const region = await strip();
    await waitFor(() => expect(currentStep(region)).toMatch(/^4 Apply/));
    const list = within(region).getByRole('list', { name: 'Resume steps' });
    expect(
      within(list).getByRole('link', { name: '1 Base (completed): Jane base' }),
    ).toHaveAttribute('href', '/resumes/base');
    expect(within(list).getAllByRole('link')).toHaveLength(1);
  });

  // qa on #609: the base was sent as it is, then "Tailor again" made this copy and it was marked
  // Final. The strip shows the copy's own steps, so they describe the copy, not the send: Finish is
  // this page (plain), not a link to the base.
  it('on the page of a copy "Tailor again" made after the base was sent, only Base is a link', async () => {
    setup({
      page: copy({ status: 'final' }),
      sends: [{ ...SEND, resumeId: 'base', resumeTitle: 'Jane base', resumeKind: 'base' }],
    });
    const region = await strip();
    await waitFor(() => expect(currentStep(region)).toMatch(/^4 Apply/));
    const list = within(region).getByRole('list', { name: 'Resume steps' });
    expect(
      within(list)
        .getAllByRole('link')
        .map((l) => l.getAttribute('href')),
    ).toEqual(['/resumes/base']);
    expect(
      within(list)
        .getByText(/^3 Finish/)
        .closest('a'),
    ).toBeNull();
  });

  // The strip uses the tab's live region (flowAnnouncer.test.tsx has the repeat and the clearing):
  // a message is a node of its own, not text set into the region.
  it('its live region says a message as a node of its own', async () => {
    let status: Resume['status'] = 'in_review';
    const page = copy({ status });
    const { user } = setup({
      page,
      extra: {
        // Wrapped: a resume's own `status` would read as the HTTP status.
        [`GET /resumes/${page.id}`]: () => ({ status: 200, body: copy({ status }) }),
        'GET /resumes': (call: ApiCall) => {
          const items = call.search.includes('kind=base')
            ? [BASE]
            : call.search.includes('opportunityId')
              ? [copy({ status })]
              : [BASE, copy({ status })];
          return { items, total: items.length };
        },
        'PATCH /resumes/copy': (call: ApiCall) => {
          status = (call.body as { status: Resume['status'] }).status;
          return { status: 200, body: copy({ status }) };
        },
      },
    });
    const region = await strip();
    const live = within(region).getByRole('status');
    await waitFor(() => expect(primary(region)).toHaveAccessibleName('Mark as final'));
    await user.click(primary(region));
    await waitFor(() => expect(live).toHaveTextContent('Marked final. Next: apply.'));
    const first = live.firstElementChild;
    expect(first).not.toBeNull();
  });
});
