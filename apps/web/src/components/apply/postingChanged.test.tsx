// The posting changed while an application was being started, and the server refused it
// (https://github.com/bgoleno/opportun/issues/913): the page says so in words for that, with the
// posting there is now on it.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import type { OpportunityView } from '@/lib/opportunities';
import { mockApi, renderWithProviders } from '@/test/render';
import { ApplyPage } from './ApplyPage';

const NOW = Date.UTC(2026, 10, 23);
const SENTENCE =
  "This opportunity's posting changed while you were starting the application. Check the posting, then start again.";
const opp = (externalId: string) =>
  ({
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
    postingUrl: `https://boards.greenhouse.io/examplecorp/jobs/${externalId}`,
    location: 'Remote',
    descriptionMd: null,
    possibleDuplicates: [],
    descriptionIsUserWritten: false,
    hasCapturedPage: false,
    lastActivityAt: null,
    postingState: 'confirmed',
    atsJobRef: {
      kind: 'ats_greenhouse',
      org: 'examplecorp',
      externalId,
      url: `https://boards.greenhouse.io/examplecorp/jobs/${externalId}`,
    },
    createdAt: NOW,
    updatedAt: NOW,
  }) as unknown as OpportunityView;
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

/** The opportunity is on 1000001 until a start is refused, and on 2000002 from then on. */
function page(refusal: { code: string; message?: string }, readTakes = 0) {
  let refused = false;
  let reread = false;
  const { calls } = mockApi({
    'GET /opportunities/opp-1': async () => {
      const now = opp(refused ? '2000002' : '1000001');
      if (refused) await new Promise((r) => setTimeout(r, readTakes));
      if (refused) reread = true;
      return now;
    },
    'GET /resumes': { items: [RESUME], total: 1 },
    'GET /opportunities/opp-1/submissions': { items: [], total: 0 },
    'POST /opportunities/opp-1/submissions': () => {
      refused = true;
      return { status: 409, body: { error: refusal } };
    },
  });
  renderWithProviders(<ApplyPage opportunityId="opp-1" step="resume" />, {
    path: '/opportunities/opp-1/apply?step=resume',
  });
  return { calls, reread: () => reread };
}
const posts = (calls: { method: string; body: unknown }[]) =>
  calls.filter((c) => c.method === 'POST').map((c) => c.body);

it('says so, with the posting there is now on the page by then', async () => {
  const user = userEvent.setup();
  const { reread } = page({ code: 'posting_changed', message: SENTENCE }, 100);
  await user.click(await screen.findByRole('button', { name: 'Next: Details' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(SENTENCE);
  expect(reread()).toBe(true);
  await waitFor(() => expect(document.body).toHaveTextContent('2000002'));
  expect(document.body).not.toHaveTextContent('1000001');
  expect(document.body).not.toHaveTextContent(/another tab or window/);
});

it('says so when the answer has no sentence of its own', async () => {
  const user = userEvent.setup();
  page({ code: 'posting_changed' });
  await user.click(await screen.findByRole('button', { name: 'Next: Details' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(SENTENCE);
});

it('the attempts are read again too, and Next asks again with the same key', async () => {
  const user = userEvent.setup();
  const { calls } = page({ code: 'posting_changed', message: SENTENCE });
  await user.click(await screen.findByRole('button', { name: 'Next: Details' }));
  await screen.findByRole('alert');
  const reads = calls.filter(
    (c) => c.method === 'GET' && c.path === '/opportunities/opp-1/submissions',
  );
  expect(reads.length).toBeGreaterThan(1);
  await user.click(screen.getByRole('button', { name: 'Next: Details' }));
  await waitFor(() => expect(posts(calls)).toHaveLength(2));
  expect(posts(calls)[1]).toEqual(posts(calls)[0]);
});

it('control: another refusal is said as before, and the opportunity is not read again for it', async () => {
  const user = userEvent.setup();
  const { calls } = page({ code: 'resume_not_final' });
  await user.click(await screen.findByRole('button', { name: 'Next: Details' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Choose a finished resume: one marked Final.',
  );
  expect(calls.filter((c) => c.method === 'GET' && c.path === '/opportunities/opp-1')).toHaveLength(
    1,
  );
});
