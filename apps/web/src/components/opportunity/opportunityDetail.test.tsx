import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { OpportunityView, TimelineItem } from '@/lib/opportunities';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import { OpportunityDetail } from './OpportunityDetail';

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

const OPP = {
  id: 'opp-1',
  userId: 'u1',
  companyId: 'c1',
  companyName: 'Acme',
  companyDomain: null,
  title: 'Staff PM',
  stage: 'applied',
  sourceKind: 'manual',
  priority: 2,
  sortOrder: 0,
  postingUrl: 'https://acme.example/jobs/1',
  location: 'Remote',
  descriptionMd: '## The team\n\nYou will **own** the roadmap.\n\n<script>alert(1)</script>',
  possibleDuplicates: [],
  descriptionIsUserWritten: false,
  hasCapturedPage: false,
  createdAt: NOW - 10 * DAY,
  updatedAt: NOW - DAY,
} as OpportunityView;

const TIMELINE: TimelineItem[] = [
  {
    kind: 'activity',
    id: 'act-1',
    opportunityId: 'opp-1',
    opportunityTitle: 'Staff PM',
    occurredAt: NOW - DAY,
    activityKind: 'interview',
    title: 'Hiring manager screen',
    bodyMd: 'Went well',
    participants: ['Jane Doe'],
    externalUrl: null,
  },
  {
    kind: 'stage',
    id: 'st-1',
    opportunityId: 'opp-1',
    opportunityTitle: 'Staff PM',
    occurredAt: NOW - 2 * DAY,
    fromStage: 'interested',
    toStage: 'applied',
    note: 'Referred by Sam',
  },
  {
    kind: 'communication',
    id: 'comm-1',
    opportunityId: 'opp-1',
    opportunityTitle: 'Staff PM',
    occurredAt: NOW - 3 * DAY,
    channel: 'gmail',
    from: 'Riley <riley@acme.example>',
    subject: 'Next steps with Acme',
    snippet: 'Can you do Tuesday?',
    classification: 'scheduling',
  },
];

const LINKED_MESSAGE = {
  id: 'comm-1',
  channel: 'gmail',
  threadKey: 't1',
  from: 'Riley <riley@acme.example>',
  to: ['me@example.com'],
  subject: 'Next steps with Acme',
  snippet: 'Can you do Tuesday?',
  sentAt: NOW - 3 * DAY,
  classification: 'scheduling',
  outreachKind: null,
  mismatchReason: null,
  confidence: 0.9,
  opportunityId: 'opp-1',
  opportunityTitle: 'Staff PM',
  companyName: 'Acme',
  opportunityStage: 'applied',
  needsReview: false,
  proposedTransition: null,
  createdAt: NOW - 3 * DAY,
};

const STEP = {
  id: 'step-1',
  userId: 'u1',
  opportunityId: 'opp-1',
  action: 'Send portfolio',
  dueAt: NOW + DAY,
  doneAt: null,
  owner: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const BASE_RESUME = {
  id: 'base-1',
  kind: 'base',
  opportunityId: null,
  title: 'Jane Base',
  store: 'google_doc',
  docRef: 'BaseDoc_0123456789',
  url: 'https://docs.google.com/document/d/BaseDoc_0123456789/edit',
  parentResumeId: null,
  status: 'draft',
  submittedAt: null,
  submittedTo: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function setup(
  oppOverride: Partial<OpportunityView> = {},
  extraRoutes: Record<string, unknown> = {},
) {
  const opp = { ...OPP, ...oppOverride };
  const api = mockApi({
    'GET /opportunities/opp-1': opp,
    'PATCH /opportunities/opp-1': (c: ApiCall) => ({ ...opp, ...(c.body as object) }),
    'GET /opportunities/opp-1/timeline': { items: TIMELINE, total: 3 },
    'GET /communications': { items: [LINKED_MESSAGE], total: 1 },
    'POST /opportunities/opp-1/activities': (c: ApiCall) => ({
      status: 201,
      body: { id: 'act-2', ...(c.body as object) },
    }),
    'GET /opportunities/opp-1/next-steps': { items: [STEP], total: 1 },
    'POST /opportunities/opp-1/next-steps': (c: ApiCall) => ({
      status: 201,
      body: { ...STEP, id: 'step-2', ...(c.body as object) },
    }),
    'PATCH /next-steps/step-1': { ...STEP, doneAt: NOW },
    'GET /resumes': (c: ApiCall) => ({
      items: c.search.includes('kind=base') ? [BASE_RESUME] : [],
      total: c.search.includes('kind=base') ? 1 : 0,
    }),
    'GET /integrations/google': { connected: true, scopes: [], clientConfigured: true },
    'POST /resumes': () => ({
      status: 201,
      body: { ...BASE_RESUME, id: 'tailored-1', kind: 'tailored', opportunityId: 'opp-1' },
    }),
    'GET /opportunities/opp-1/attachments': {
      items: [
        {
          id: 'att-1',
          userId: 'u1',
          opportunityId: 'opp-1',
          filename: 'offer-letter.pdf',
          mime: 'application/pdf',
          bytes: 2048,
          sha256: 'x',
          createdAt: NOW,
        },
      ],
      total: 1,
    },
    'POST /opportunities/opp-1/attachments': {
      status: 201,
      body: { id: 'att-2', filename: 'notes.txt', bytes: 5, mime: 'text/plain', createdAt: NOW },
    },
    ...extraRoutes,
  });
  const user = userEvent.setup();
  renderWithProviders(<OpportunityDetail id="opp-1" />, { path: '/opportunities/opp-1' });
  return { api, user };
}

const posts = (calls: ApiCall[], path: string) =>
  calls.filter((c) => c.method !== 'GET' && c.path === path);

describe('OpportunityDetail', () => {
  it('shows the possible-duplicate banner when the opportunity is flagged (#9)', async () => {
    setup(
      { possibleDuplicates: ['opp-2'] },
      { 'GET /opportunities/opp-2': { ...OPP, id: 'opp-2', title: 'Staff PM (dup)' } },
    );
    expect(await screen.findByText(/possible duplicate/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Staff PM \(dup\)/ })).toBeInTheDocument();
  });

  it('#138: "More actions" shows a tooltip on hover, without the hover breaking the menu', async () => {
    setup();
    const button = await screen.findByRole('button', { name: 'More actions' });
    await userEvent.hover(button);
    expect(await screen.findByText('More actions')).toBeInTheDocument();
    await userEvent.click(button);
    expect(await screen.findByRole('menu')).toBeInTheDocument();
  });

  it('shows the header with company, title, priority and stage', async () => {
    const { api, user } = setup();
    expect(await screen.findByRole('heading', { level: 1, name: 'Staff PM' })).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stage: Applied' })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Priority'), '1');
    await waitFor(() => expect(posts(api.calls, '/opportunities/opp-1')).toHaveLength(1));
    expect(posts(api.calls, '/opportunities/opp-1')[0]?.body).toEqual({ priority: 1 });
  });

  it('links the company name to its homepage once a domain is resolved (issue #239)', async () => {
    setup({ companyDomain: 'acme.example' });
    const link = await screen.findByRole('link', { name: /Acme/ });
    expect(link).toHaveAttribute('href', 'https://acme.example/');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('renders the company name as plain text, not a link, while no domain is resolved', async () => {
    setup();
    expect(await screen.findByText('Acme')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Acme/ })).not.toBeInTheDocument();
  });

  it('renders the timeline with activities and stage changes', async () => {
    setup();
    const timeline = await screen.findByRole('list', { name: 'Timeline' });
    await within(timeline).findByText('Hiring manager screen');
    const entries = within(timeline).getAllByRole('listitem');
    expect(entries[0]).toHaveTextContent('Interview');
    expect(entries[0]).toHaveTextContent('Jane Doe');
    expect(entries[1]).toHaveTextContent('Interested to Applied');
    expect(entries[1]).toHaveTextContent('Referred by Sam');
  });

  it('adds a meeting from the composer', async () => {
    const { api, user } = setup();
    const composer = await screen.findByRole('form', { name: 'Add to timeline' });
    await user.selectOptions(within(composer).getByLabelText('Type'), 'meeting');
    await user.type(within(composer).getByLabelText('Title'), 'Coffee chat');
    await user.type(within(composer).getByLabelText('Details'), 'Talked about the team');
    await user.type(within(composer).getByLabelText('Participants'), 'Jane Doe, Sam Lee');
    await user.click(within(composer).getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(posts(api.calls, '/opportunities/opp-1/activities')).toHaveLength(1),
    );
    expect(posts(api.calls, '/opportunities/opp-1/activities')[0]?.body).toEqual({
      kind: 'meeting',
      title: 'Coffee chat',
      bodyMd: 'Talked about the team',
      participants: ['Jane Doe', 'Sam Lee'],
    });
  });

  it('requires a URL for a link entry', async () => {
    const { api, user } = setup();
    const composer = await screen.findByRole('form', { name: 'Add to timeline' });
    await user.selectOptions(within(composer).getByLabelText('Type'), 'link');
    await user.type(within(composer).getByLabelText('Title'), 'Team blog');
    await user.click(within(composer).getByRole('button', { name: 'Add' }));
    expect(await within(composer).findByText('Enter an http or https URL')).toBeInTheDocument();
    await user.type(within(composer).getByLabelText('URL'), 'https://acme.example/blog');
    await user.click(within(composer).getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(posts(api.calls, '/opportunities/opp-1/activities')).toHaveLength(1),
    );
    expect(posts(api.calls, '/opportunities/opp-1/activities')[0]?.body).toMatchObject({
      kind: 'link',
      title: 'Team blog',
      externalUrl: 'https://acme.example/blog',
    });
  });

  it('lists, completes and adds next steps', async () => {
    const { api, user } = setup();
    const panel = await screen.findByRole('region', { name: 'Next steps' });
    await user.click(await within(panel).findByRole('checkbox', { name: 'Done: Send portfolio' }));
    await waitFor(() => expect(posts(api.calls, '/next-steps/step-1')).toHaveLength(1));
    expect(posts(api.calls, '/next-steps/step-1')[0]?.body).toEqual({ done: true });

    await user.type(within(panel).getByLabelText('Next step'), 'Follow up with recruiter');
    await user.type(within(panel).getByLabelText('Due date'), '2026-10-20');
    await user.click(within(panel).getByRole('button', { name: 'Add step' }));
    await waitFor(() =>
      expect(posts(api.calls, '/opportunities/opp-1/next-steps')).toHaveLength(1),
    );
    const body = posts(api.calls, '/opportunities/opp-1/next-steps')[0]?.body as {
      action: string;
      dueAt: number;
    };
    expect(body.action).toBe('Follow up with recruiter');
    const due = new Date(body.dueAt);
    expect([due.getFullYear(), due.getMonth(), due.getDate()]).toEqual([2026, 9, 20]);
  });

  it('shows details with safe markdown, the posting link and attachments', async () => {
    const { api, user } = setup();
    await user.click(await screen.findByRole('tab', { name: 'Details' }));
    const details = await screen.findByRole('tabpanel', { name: 'Details' });
    expect(within(details).getByRole('heading', { name: 'The team' })).toBeInTheDocument();
    expect(within(details).getByText('own').tagName).toBe('STRONG');
    expect(details.querySelector('script')).toBeNull();
    expect(within(details).getByRole('link', { name: /acme\.example\/jobs\/1/ })).toHaveAttribute(
      'href',
      'https://acme.example/jobs/1',
    );

    const download = await within(details).findByRole('link', { name: /offer-letter\.pdf/ });
    expect(download).toHaveAttribute('href', '/api/v1/attachments/att-1');

    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    await user.upload(within(details).getByLabelText('Upload a file'), file);
    await waitFor(() =>
      expect(posts(api.calls, '/opportunities/opp-1/attachments')).toHaveLength(1),
    );
    const sent = posts(api.calls, '/opportunities/opp-1/attachments')[0]?.body;
    expect(sent).toBeInstanceOf(FormData);
    expect((sent as FormData).get('file')).toBeInstanceOf(File);
  });

  it('refuses files over 20 MB before uploading', async () => {
    const { api, user } = setup();
    await user.click(await screen.findByRole('tab', { name: 'Details' }));
    const details = await screen.findByRole('tabpanel', { name: 'Details' });
    const big = new File(['x'], 'huge.bin');
    Object.defineProperty(big, 'size', { value: 20 * 1024 * 1024 + 1 });
    await user.upload(within(details).getByLabelText('Upload a file'), big);
    expect(await within(details).findByText('Files must be 20 MB or smaller.')).toBeInTheDocument();
    expect(posts(api.calls, '/opportunities/opp-1/attachments')).toHaveLength(0);
  });

  it('Resume tab lists tailored copies and creates one from a base resume', async () => {
    const { user, api } = setup();
    await user.click(await screen.findByRole('tab', { name: 'Resume' }));
    const panel = await screen.findByRole('tabpanel', { name: 'Resume' });
    expect(await within(panel).findByText('No tailored resume yet.')).toBeInTheDocument();
    expect(within(panel).getByLabelText('Base resume')).toHaveDisplayValue('Jane Base');
    await user.click(within(panel).getByRole('button', { name: 'Create tailored copy' }));
    await waitFor(() =>
      expect(posts(api.calls, '/resumes').map((c) => c.body)).toEqual([
        { baseResumeId: 'base-1', opportunityId: 'opp-1' },
      ]),
    );
  });

  it('lists linked messages on the Communications tab and merges them into the timeline', async () => {
    const { user, api } = setup();
    const timeline = await screen.findByRole('list', { name: 'Timeline' });
    expect(await within(timeline).findByText('Next steps with Acme')).toBeInTheDocument();
    expect(within(timeline).getByText('From Riley <riley@acme.example>')).toBeInTheDocument();
    await user.click(await screen.findByRole('tab', { name: 'Communications' }));
    const panel = await screen.findByRole('tabpanel', { name: 'Communications' });
    expect(
      await within(panel).findByRole('listitem', { name: 'Next steps with Acme' }),
    ).toBeInTheDocument();
    const listCall = api.calls.find((c) => c.path === '/communications');
    expect(listCall?.search).toContain('opportunityId=opp-1');
  });
});
