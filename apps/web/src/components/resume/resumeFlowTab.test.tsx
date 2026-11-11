// The resume flow on the Resume tab (https://github.com/bgoleno/opportun/issues/440, slice 2 of
// #400): one test per row of tl's table, A to H, that the right step is current and the primary
// action is the table's; then the base-as-is branch, focus and the live region, the disclosure,
// and tl's rulings on #440 (https://github.com/bgoleno/opportun/issues/440#issuecomment-6805280758).
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { SubmissionView } from '@/components/apply/api';
import { formatDate, type OpportunityView } from '@/lib/opportunities';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import type { Resume, ResumeSend } from './api';
import { OpportunityResumeTab } from './OpportunityResumeTab';

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
  url: null,
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
  resumeId: 'base',
  resumeTitle: 'Jane base',
  resumeKind: 'base',
  sentAt: NOW,
  sentVia: 'Indeed',
  submissionId: null,
  createdAt: NOW,
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
  resumes?: Resume[];
  sends?: ResumeSend[];
  /** null: assisted apply is off here (the routes answer 404). */
  attempts?: SubmissionView[] | null;
  opp?: Partial<OpportunityView>;
  extra?: Record<string, unknown>;
}

/** The tab, with every list it reads answered from `resumes`, as the server would. */
function setup({ resumes = [], sends = [], attempts = [], opp = {}, extra = {} }: Setup) {
  const api = mockApi({
    'GET /resumes': (call: ApiCall) => {
      const items = call.search.includes('opportunityId')
        ? resumes.filter((r) => r.opportunityId === 'opp-1')
        : call.search.includes('kind=base')
          ? resumes.filter((r) => r.kind === 'base')
          : resumes;
      return { items, total: items.length };
    },
    'GET /opportunities/opp-1/resume-sends': { items: sends },
    ...(attempts === null
      ? {}
      : {
          'GET /opportunities/opp-1/submissions': { items: attempts, total: attempts.length },
        }),
    'GET /integrations/google': { connected: true, scopes: [] },
    'GET /settings/document-store': { store: 'google' },
    ...extra,
  });
  const user = userEvent.setup();
  renderWithProviders(<OpportunityResumeTab opp={{ ...OPP, ...opp } as OpportunityView} />);
  return { api, user };
}

const flow = () => screen.findByRole('region', { name: 'Resume for this application' });

/** The step marked current in the flow, or null when none is (state H). */
function currentStep(region: HTMLElement): string | null {
  const steps = within(region).getByRole('list', { name: 'Resume steps' });
  return steps.querySelector('[aria-current="step"]')?.textContent ?? null;
}

/** The flow's one filled button: its accessible name. Fails if there is not exactly one. */
function primary(region: HTMLElement): HTMLElement {
  const filled = region.querySelectorAll<HTMLElement>(
    '[data-slot="button"][data-variant="default"]',
  );
  expect(filled).toHaveLength(1);
  return filled[0]!;
}

/** The flow's sentence for the state: its heading. */
const said = (region: HTMLElement) => within(region).getByRole('heading', { level: 3 });

describe('the Resume tab flow: one test per row of the table (#440)', () => {
  it('A: no base resume: step 1 Base, "Register a base resume"', async () => {
    const { user } = setup({});
    const region = await flow();
    await waitFor(() => expect(said(region)).toHaveTextContent('Add a base resume to start.'));
    expect(currentStep(region)).toMatch(/^1 Base/);
    expect(primary(region)).toHaveAccessibleName('Register a base resume');
    await user.click(primary(region));
    expect(await within(region).findByLabelText('Google Doc link')).toBeInTheDocument();
  });

  it('B: a base and nothing here: step 1 Base, "Create tailored copy" from the chosen base', async () => {
    const { api, user } = setup({
      resumes: [BASE],
      extra: { 'POST /resumes': { status: 201, body: copy() } },
    });
    const region = await flow();
    await waitFor(() => expect(said(region)).toHaveTextContent('Choose the resume to start from.'));
    expect(currentStep(region)).toMatch(/^1 Base/);
    expect(within(region).getByLabelText('Base resume')).toHaveValue('base');
    expect(primary(region)).toHaveAccessibleName('Create tailored copy');
    await user.click(primary(region));
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'POST' && c.path === '/resumes')?.body).toEqual({
        baseResumeId: 'base',
        opportunityId: 'opp-1',
      }),
    );
  });

  it('C: a Draft copy: step 2 Tailor, "Open and tailor" to its page', async () => {
    setup({ resumes: [BASE, copy({ status: 'draft' })] });
    const region = await flow();
    await waitFor(() =>
      expect(said(region)).toHaveTextContent('Tailor "Acme tailored" for this role.'),
    );
    expect(currentStep(region)).toMatch(/^2 Tailor/);
    expect(primary(region)).toHaveAccessibleName('Open and tailor');
    expect(primary(region)).toHaveAttribute('href', '/resumes/copy');
    expect(
      within(region).getByRole('button', { name: 'It needs no changes: mark as final' }),
    ).toBeInTheDocument();
  });

  it('D: a copy In review: step 3 Finish, "Mark as final", with the match score', async () => {
    const scoredAt = NOW - 86_400_000;
    setup({
      resumes: [BASE, copy({ status: 'in_review' })],
      extra: {
        'GET /resumes/copy/match': {
          report: { score: 78, missingKeywords: [], weakAreas: [], summary: '' },
          scoredAt,
          stale: false,
        },
      },
    });
    const region = await flow();
    await waitFor(() => expect(said(region)).toHaveTextContent('Finished tailoring?'));
    expect(currentStep(region)).toMatch(/^3 Finish/);
    expect(primary(region)).toHaveAccessibleName('Mark as final');
    expect(
      await within(region).findByText(`Match 78, ${formatDate(scoredAt)}`),
    ).toBeInTheDocument();
    expect(within(region).getByRole('button', { name: 'Score again' })).toBeInTheDocument();
    expect(within(region).getByRole('link', { name: 'Keep tailoring' })).toHaveAttribute(
      'href',
      '/resumes/copy',
    );
  });

  it('E: Final, and assisted apply can start: step 4 Apply, "Apply on Greenhouse"', async () => {
    setup({ resumes: [BASE, copy({ status: 'final' })] });
    const region = await flow();
    await waitFor(() => expect(said(region)).toHaveTextContent('Ready to apply.'));
    expect(currentStep(region)).toMatch(/^4 Apply/);
    expect(primary(region)).toHaveAccessibleName('Apply on Greenhouse');
    expect(primary(region)).toHaveAttribute('href', '/opportunities/opp-1/apply?step=resume');
    expect(
      within(region).getByRole('button', { name: 'Record that you sent it yourself' }),
    ).toBeInTheDocument();
  });

  it('F: Final, but assisted apply cannot start: the panel\'s reason, and "Record that you sent it"', async () => {
    const { user } = setup({
      resumes: [BASE, copy({ status: 'final' })],
      opp: { postingState: 'needs_review' } as Partial<OpportunityView>,
    });
    const region = await flow();
    await waitFor(() =>
      expect(said(region)).toHaveTextContent(
        "This opportunity's posting needs review. Confirm it on the Details tab first.",
      ),
    );
    expect(currentStep(region)).toMatch(/^4 Apply/);
    expect(primary(region)).toHaveAccessibleName('Record that you sent it');
    expect(within(region).getByRole('link', { name: 'Open the Details tab' })).toHaveAttribute(
      'href',
      '/opportunities/opp-1?tab=details',
    );
    await user.click(primary(region));
    expect(await within(region).findByLabelText('Sent via')).toBeInTheDocument();
  });

  it('G: an attempt in progress: step 4 Apply, "Continue your application" at its step', async () => {
    setup({
      resumes: [BASE, copy({ status: 'final' })],
      attempts: [attempt({ status: 'reviewed' })],
    });
    const region = await flow();
    await waitFor(() =>
      expect(said(region)).toHaveTextContent(
        'Your review is saved. Nothing has been sent anywhere.',
      ),
    );
    expect(currentStep(region)).toMatch(/^4 Apply/);
    expect(primary(region)).toHaveAccessibleName('Continue your application');
    expect(primary(region)).toHaveAttribute('href', '/opportunities/opp-1/apply?step=review');
  });

  it('H: a send recorded: every step done, no filled button, and "Tailor again" from the base', async () => {
    setup({ resumes: [BASE], sends: [SEND] });
    const region = await flow();
    await waitFor(() =>
      expect(said(region)).toHaveTextContent(`Sent: Jane base via Indeed on ${formatDate(NOW)}.`),
    );
    expect(currentStep(region)).toBeNull();
    const steps = within(region).getByRole('list', { name: 'Resume steps' });
    expect(within(steps).getAllByText('(completed)')).toHaveLength(4);
    expect(region.querySelectorAll('[data-slot="button"][data-variant="default"]')).toHaveLength(0);
    expect(
      within(region).getByRole('button', { name: 'Tailor again for this opportunity' }),
    ).toBeInTheDocument();
    expect(within(region).getByText('Starts a new copy of Jane base.')).toBeInTheDocument();
  });
});

describe('the Resume tab flow: tl on #440', () => {
  it('ruling 2: a Final copy with assisted apply off says "Ready to send.", with no reason and no Apply', async () => {
    setup({ resumes: [BASE, copy({ status: 'final' })], attempts: null });
    const region = await flow();
    await waitFor(() => expect(said(region)).toHaveTextContent('Ready to send.'));
    expect(currentStep(region)).toMatch(/^4 Apply/);
    expect(primary(region)).toHaveAccessibleName('Record that you sent it');
    expect(screen.queryByText(/Apply on/)).toBeNull();
    expect(screen.queryByText(/Details tab/)).toBeNull();
  });

  it('ruling 5: the embedded Greenhouse reason links to the Timeline tab, where Find posting is', async () => {
    setup({
      resumes: [BASE, copy({ status: 'final' })],
      opp: {
        atsJobRef: null,
        postingUrl: 'https://careers.acme.example/jobs?gh_jid=8136554',
      } as Partial<OpportunityView>,
    });
    const region = await flow();
    const link = await within(region).findByRole('link', {
      name: 'Find posting on the Timeline tab',
    });
    expect(link).toHaveAttribute('href', '/opportunities/opp-1');
  });

  it('ruling 5: a stage reason has no link', async () => {
    setup({
      resumes: [BASE, copy({ status: 'final' })],
      opp: { stage: 'in_process' } as Partial<OpportunityView>,
    });
    const region = await flow();
    await waitFor(() => expect(said(region)).toHaveTextContent(/This opportunity is In process/));
    expect(within(region).queryAllByRole('link')).toHaveLength(0);
  });

  it('ruling 6: H with a Draft copy made since names it: "Continue tailoring" it', async () => {
    setup({ resumes: [BASE, copy({ status: 'draft' })], sends: [SEND] });
    const region = await flow();
    const link = await within(region).findByRole('link', {
      name: 'Continue tailoring Acme tailored',
    });
    expect(link).toHaveAttribute('href', '/resumes/copy');
    expect(
      within(region).queryByRole('button', { name: 'Tailor again for this opportunity' }),
    ).toBeNull();
    expect(region.querySelectorAll('[data-slot="button"][data-variant="default"]')).toHaveLength(0);
  });

  it('ruling 6: H with a Final copy made since: "Record that you sent" it', async () => {
    setup({ resumes: [BASE, copy({ status: 'final' })], sends: [SEND] });
    const region = await flow();
    expect(
      await within(region).findByRole('button', { name: 'Record that you sent Acme tailored' }),
    ).toBeInTheDocument();
    expect(region.querySelectorAll('[data-slot="button"][data-variant="default"]')).toHaveLength(0);
  });
});

describe('the Resume tab flow: actions, focus and the live region (#440)', () => {
  it('Mark as final: the status changes, focus moves to the new state, and it is announced', async () => {
    let status: Resume['status'] = 'in_review';
    const { api, user } = setup({
      resumes: [],
      extra: {
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
          // Wrapped: a resume's own `status` would read as the HTTP status.
          return { status: 200, body: copy({ status }) };
        },
      },
    });
    const region = await flow();
    await waitFor(() => expect(primary(region)).toHaveAccessibleName('Mark as final'));
    await user.click(primary(region));
    await waitFor(() => expect(said(region)).toHaveTextContent('Ready to apply.'));
    expect(api.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ status: 'final' });
    expect(said(region)).toHaveFocus();
    expect(within(region).getByRole('status')).toHaveTextContent('Marked final. Next: apply.');
  });

  it('a refused status change says why in the flow', async () => {
    const { user } = setup({
      resumes: [BASE, copy({ status: 'in_review' })],
      extra: {
        'PATCH /resumes/copy': () => ({
          status: 409,
          body: { error: { code: 'conflict', message: 'This resume changed elsewhere.' } },
        }),
      },
    });
    const region = await flow();
    await waitFor(() => expect(primary(region)).toHaveAccessibleName('Mark as final'));
    await user.click(primary(region));
    expect(await within(region).findByRole('alert')).toBeInTheDocument();
    expect(said(region)).toHaveTextContent('Finished tailoring?');
  });

  it('the base-as-is branch: Mark the base as final, then Apply or record it; leaving returns to B', async () => {
    let baseStatus: Resume['status'] = 'in_review';
    const { api, user } = setup({
      extra: {
        'GET /resumes': () => ({ items: [{ ...BASE, status: baseStatus }], total: 1 }),
        'PATCH /resumes/base': (call: ApiCall) => {
          baseStatus = (call.body as { status: Resume['status'] }).status;
          return { status: 200, body: { ...BASE, status: baseStatus } };
        },
      },
    });
    const region = await flow();
    await user.click(
      await within(region).findByRole('button', { name: 'Send a base resume as it is' }),
    );
    expect(currentStep(region)).toMatch(/^3 Finish/);
    expect(primary(region)).toHaveAccessibleName('Mark Jane base as final');
    expect(
      within(region).getByText('This marks Jane base as final everywhere it is used.'),
    ).toBeInTheDocument();
    await user.click(primary(region));
    await waitFor(() => expect(primary(region)).toHaveAccessibleName('Apply on Greenhouse'));
    expect(api.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ status: 'final' });
    expect(currentStep(region)).toMatch(/^4 Apply/);
    expect(said(region)).toHaveFocus();
    expect(within(region).getByRole('status')).toHaveTextContent('Marked final. Next: apply.');
    expect(
      within(region).getByRole('button', { name: 'Record that you sent it yourself' }),
    ).toBeInTheDocument();
    await user.click(within(region).getByRole('button', { name: 'Tailor a copy instead' }));
    expect(said(region)).toHaveTextContent('Choose the resume to start from.');
    expect(primary(region)).toHaveAccessibleName('Create tailored copy');
  });
});

describe('the Resume tab flow: every action here moves focus and says where it led (#440)', () => {
  it('recording a send in E leads to H: focus on it, and "Recorded as sent."', async () => {
    let sends: ResumeSend[] = [];
    const final = copy({ status: 'final' });
    const { user } = setup({
      resumes: [BASE, final],
      extra: {
        'GET /opportunities/opp-1/resume-sends': () => ({ items: sends }),
        'POST /opportunities/opp-1/resume-sends': () => {
          sends = [
            { ...SEND, resumeId: 'copy', resumeTitle: 'Acme tailored', resumeKind: 'tailored' },
          ];
          return { status: 201, body: sends[0] };
        },
      },
    });
    const region = await flow();
    await user.click(
      await within(region).findByRole('button', { name: 'Record that you sent it yourself' }),
    );
    await user.type(within(region).getByLabelText('Sent via'), 'Email');
    await user.click(within(region).getByRole('button', { name: 'Record as sent' }));
    await waitFor(() => expect(said(region)).toHaveTextContent(/^Sent: Acme tailored/));
    expect(said(region)).toHaveFocus();
    expect(within(region).getByRole('status')).toHaveTextContent(
      'Recorded as sent. Nothing more to do here.',
    );
  });

  it('registering a base in A leads to B: focus on it, and "Base resume registered."', async () => {
    let resumes: Resume[] = [];
    const { user } = setup({
      extra: {
        'GET /resumes': () => ({ items: resumes, total: resumes.length }),
        'POST /resumes': () => {
          resumes = [BASE];
          return { status: 201, body: BASE };
        },
      },
    });
    const region = await flow();
    await user.click(await within(region).findByRole('button', { name: 'Register a base resume' }));
    await user.type(
      within(region).getByLabelText('Google Doc link'),
      'https://docs.google.com/document/d/Base/edit',
    );
    await user.click(within(region).getByRole('button', { name: 'Register' }));
    await waitFor(() => expect(said(region)).toHaveTextContent('Choose the resume to start from.'));
    expect(said(region)).toHaveFocus();
    expect(within(region).getByRole('status')).toHaveTextContent(
      'Base resume registered. Next: create a tailored copy.',
    );
  });
});

describe('the Resume tab flow: the base-as-is branch when assisted apply cannot start', () => {
  it("says the panel's reason, records the send as the primary action, and links where the reason says", async () => {
    setup({ resumes: [BASE], opp: { postingState: 'needs_review' } as Partial<OpportunityView> });
    const region = await flow();
    const user = userEvent.setup();
    await user.click(
      await within(region).findByRole('button', { name: 'Send a base resume as it is' }),
    );
    expect(said(region)).toHaveTextContent(
      "This opportunity's posting needs review. Confirm it on the Details tab first.",
    );
    expect(currentStep(region)).toMatch(/^4 Apply/);
    expect(primary(region)).toHaveAccessibleName('Record that you sent it');
    expect(within(region).getByRole('link', { name: 'Open the Details tab' })).toHaveAttribute(
      'href',
      '/opportunities/opp-1?tab=details',
    );
  });
});

describe('the Resume tab: the cards around the flow (#440)', () => {
  it('"Other ways to add a resume" is open at step 1, closed from step 2 on', async () => {
    setup({ resumes: [BASE] });
    const other = (await screen.findByText('Other ways to add a resume')).closest('details');
    expect(other).not.toBeNull();
    await waitFor(() => expect(other!.open).toBe(true));
  });

  it('closed at step 2, and its buttons are outline: the flow has the one filled button', async () => {
    setup({ resumes: [BASE, copy({ status: 'draft' })] });
    const region = await flow();
    await waitFor(() => expect(currentStep(region)).toMatch(/^2 Tailor/));
    const other = screen.getByText('Other ways to add a resume').closest('details')!;
    expect(other.open).toBe(false);
    expect(other.querySelectorAll('[data-slot="button"][data-variant="default"]')).toHaveLength(0);
  });

  it('A\'s quiet action opens "Other ways to add a resume" and moves focus there', async () => {
    const { user } = setup({});
    const region = await flow();
    await user.click(
      await within(region).findByRole('button', {
        name: 'Attach a resume you already tailored',
      }),
    );
    const other = screen.getByText('Other ways to add a resume').closest('details')!;
    expect(other.open).toBe(true);
    expect(screen.getByText('Other ways to add a resume')).toHaveFocus();
  });

  it('at phone width the steps read "Step 2 of 4: Tailor"', async () => {
    setup({ resumes: [BASE, copy({ status: 'draft' })] });
    const region = await flow();
    expect(await within(region).findByText('Step 2 of 4: Tailor')).toBeInTheDocument();
  });
});
