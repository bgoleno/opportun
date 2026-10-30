// Issue #304: the score moved to the page header, and the report moved into the main column
// above the chat, in source order, at every width -- not just visually reflowed at `lg`. This
// file proves both from the rendered DOM rather than from the Tailwind classes that produce it.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import { rk, type MatchReportView, type Resume, type TailoringSession } from './api';
import { ResumeWorkspace } from './ResumeWorkspace';

const RESUME: Resume = {
  id: 'r-1',
  kind: 'tailored',
  opportunityId: 'opp-1',
  title: 'Tailored Resume',
  store: 'google_doc',
  docRef: 'doc-1',
  url: null,
  parentResumeId: 'r-base',
  status: 'draft',
  submittedAt: null,
  submittedTo: null,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
};

const REPORT: MatchReportView = {
  report: {
    score: 81,
    missingKeywords: [],
    weakAreas: [],
    summary: 'Strong backend match.',
  },
  scoredAt: Date.parse('2026-10-01T00:00:00Z'),
  stale: false,
};

const SESSION: TailoringSession = {
  id: 's-1',
  resumeId: 'r-1',
  acceptedAt: null,
  createdAt: 1,
  messages: [],
};

const DOC_TEXT = 'Tailored Resume\n\n- Shipped the billing platform rewrite';

function boot(report: MatchReportView | null = REPORT, resume: Resume = RESUME) {
  return mockApi({
    'GET /resumes/r-1': resume,
    'GET /resumes/r-1/match': report,
    'POST /resumes/r-1/tailoring': SESSION,
    'GET /resumes/r-1/text': { text: DOC_TEXT },
  });
}

describe('ResumeWorkspace (issue #304)', () => {
  it('shows the score beside the title, not in a side column', async () => {
    boot();
    renderWithProviders(<ResumeWorkspace id="r-1" />);
    expect(await screen.findByRole('heading', { name: 'Tailored Resume' })).toBeInTheDocument();
    // "81" is unambiguous: the full report (open by default) encodes the same score in its
    // meter, not as a second copy of the digits (issue #304's own point about not repeating
    // the glanceable number next to the reading material it also now has its own home for).
    expect(await screen.findByText('81')).toBeInTheDocument();
  });

  it('shows no score widget before one exists', async () => {
    boot(null);
    renderWithProviders(<ResumeWorkspace id="r-1" />);
    await screen.findByRole('heading', { name: 'Tailored Resume' });
    expect(screen.queryByText(/\/ 100/)).toBeNull();
  });

  it('places the match report before the chat in the document, regardless of viewport', async () => {
    boot();
    renderWithProviders(<ResumeWorkspace id="r-1" />);
    const report = await screen.findByRole('heading', { name: 'Match report' });
    const chat = await screen.findByRole('heading', { name: 'Tailoring chat' });
    expect(report.compareDocumentPosition(chat) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('ResumeWorkspace (issue #321): the document viewer', () => {
  it('shows the document, before the match report, when the resume has no external URL', async () => {
    boot(REPORT, { ...RESUME, url: null });
    renderWithProviders(<ResumeWorkspace id="r-1" />);
    const doc = await screen.findByRole('heading', { name: 'Document' });
    expect(await screen.findByText(DOC_TEXT, { normalizer: (s) => s })).toBeInTheDocument();
    const report = await screen.findByRole('heading', { name: 'Match report' });
    expect(doc.compareDocumentPosition(report) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows no document viewer when the resume already has an external URL to view it', async () => {
    boot(REPORT, { ...RESUME, url: 'https://docs.google.com/document/d/doc-1/edit' });
    renderWithProviders(<ResumeWorkspace id="r-1" />);
    await screen.findByRole('heading', { name: 'Match report' });
    expect(screen.queryByRole('heading', { name: 'Document' })).toBeNull();
  });
});

// https://github.com/bgoleno/opportun/issues/8
describe('ResumeWorkspace: applying a suggested edit', () => {
  const EDIT = {
    find: 'Shipped the billing platform rewrite',
    replace: 'Shipped the Go billing platform rewrite on Kubernetes',
  };
  const EDITED = DOC_TEXT.replace(EDIT.find, EDIT.replace);
  const APPLIED = { results: [{ index: 0, outcome: 'applied' }] };
  const exact = { normalizer: (s: string) => s };

  interface FakeServer {
    text: string;
    docRef: string;
  }

  /**
   * A stateful stand-in for the server: the apply route runs `onApply` against it, and
   * GET /resumes/r-1 and GET /text read it, as the real endpoints do, so the page can only show
   * a change by fetching it again. `extra` overrides routes that need to behave differently.
   */
  function bootApply(
    onApply: (server: FakeServer) => unknown,
    extra: (server: FakeServer) => Record<string, unknown> = () => ({}),
  ) {
    const server: FakeServer = { text: DOC_TEXT, docRef: 'att-1' };
    const api = mockApi({
      // No external URL, so the Document panel renders: ResumeWorkspace's condition, whatever
      // the store. local_file is used because its apply also writes a new docRef to the row.
      // Wrapped: a bare row would be read by mockApi as {status, body}, since a row has its own
      // `status` field.
      'GET /resumes/r-1': () => ({
        status: 200,
        body: { ...RESUME, store: 'local_file', docRef: server.docRef, url: null },
      }),
      'GET /resumes/r-1/match': REPORT,
      'POST /resumes/r-1/tailoring': {
        ...SESSION,
        messages: [
          { role: 'assistant', content: 'One change.', at: 2, edits: [EDIT], incomplete: false },
        ],
      },
      'GET /resumes/r-1/text': () => ({ text: server.text }),
      'POST /tailoring/s-1/suggestions/apply': () => onApply(server),
      ...extra(server),
    });
    return { server, ...api };
  }

  /** What the server writes for an edit it applies to a local_file resume. */
  function write(server: FakeServer) {
    server.text = server.text.replace(EDIT.find, EDIT.replace);
    server.docRef = 'att-2';
  }

  function gets(calls: ApiCall[], path: string) {
    return calls.filter((c) => c.method === 'GET' && c.path === path).length;
  }

  async function open() {
    const rendered = renderWithProviders(<ResumeWorkspace id="r-1" />);
    expect(await screen.findByText(DOC_TEXT, exact)).toBeInTheDocument();
    return rendered;
  }

  async function clickApply() {
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Apply' }));
  }

  it('shows the edited text in the Document panel without a reload', async () => {
    bootApply((server) => {
      write(server);
      return APPLIED;
    });
    await open();
    await clickApply();

    expect(await screen.findByText('Applied')).toBeInTheDocument();
    expect(await screen.findByText(EDITED, exact)).toBeInTheDocument();
    expect(screen.queryByText(DOC_TEXT, exact)).toBeNull();
  });

  it('refreshes the cached resume row and resume lists, which the apply also changed', async () => {
    bootApply((server) => {
      write(server);
      return APPLIED;
    });
    const { queryClient } = await open();
    // A list cached by an earlier page, still holding the row as it was before the apply.
    queryClient.setQueryData(rk.list({}), {
      items: [{ ...RESUME, store: 'local_file', docRef: 'att-1', url: null }],
      total: 1,
    });
    await clickApply();

    expect(await screen.findByText(EDITED, exact)).toBeInTheDocument();
    // The old ref names an attachment the server has just deleted.
    await waitFor(() =>
      expect(queryClient.getQueryData<Resume>(rk.resume('r-1'))?.docRef).toBe('att-2'),
    );
    expect(queryClient.getQueryState(rk.list({}))?.isInvalidated).toBe(true);
  });

  it('does not refetch the match report, which an apply cannot change (see useApplyEdit)', async () => {
    const { calls } = bootApply((server) => {
      write(server);
      return APPLIED;
    });
    await open();
    await clickApply();

    // The text was refetched by the same invalidation that would have reached the report, so
    // a report refetch would have been sent by now.
    expect(await screen.findByText(EDITED, exact)).toBeInTheDocument();
    expect(gets(calls, '/resumes/r-1/match')).toBe(1);
  });

  it('shows Applied without waiting for the document to be read again', async () => {
    let reads = 0;
    bootApply(
      (server) => {
        write(server);
        return APPLIED;
      },
      // The re-read never answers. api() has no timeout, so this is what a hung read looks
      // like; the edit is written all the same, and the card must say so.
      (server) => ({
        'GET /resumes/r-1/text': () =>
          ++reads === 1 ? { text: server.text } : new Promise(() => undefined),
      }),
    );
    await open();
    await clickApply();

    expect(await screen.findByText('Applied')).toBeInTheDocument();
    expect(reads).toBe(2);
  });

  it('refreshes the document after a failed apply, since the server may have written it first', async () => {
    // For example audit() throwing after updateResumeDocRef: a 500 for an edit that is in.
    bootApply((server) => {
      write(server);
      return { status: 500, body: { error: { code: 'internal' } } };
    });
    await open();
    await clickApply();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(await screen.findByText(EDITED, exact)).toBeInTheDocument();
    expect(screen.queryByText('Applied')).toBeNull();
  });

  it('refreshes the document when the edit is no longer in it, so the panel shows why', async () => {
    const elsewhere = DOC_TEXT.replace(EDIT.find, 'Rewrote billing by hand');
    bootApply((server) => {
      // Changed by something else after the page last read it, before this apply arrived.
      server.text = elsewhere;
      return { status: 409, body: { error: { code: 'edit_target_missing', index: 0 } } };
    });
    await open();
    await clickApply();

    expect(await screen.findByRole('alert')).toHaveTextContent(/no longer in the document/i);
    expect(await screen.findByText(elsewhere, exact)).toBeInTheDocument();
  });

  it('fetches nothing after an already_consumed result, since that apply wrote nothing', async () => {
    const { calls } = bootApply(() => ({ results: [{ index: 0, outcome: 'already_consumed' }] }));
    await open();
    await clickApply();

    expect(
      await screen.findByText('Already changed by another edit you applied'),
    ).toBeInTheDocument();
    expect(gets(calls, '/resumes/r-1/text')).toBe(1);
    expect(gets(calls, '/resumes/r-1')).toBe(1);
  });

  it('says the outcome is unknown, and refreshes the document, when the server reports none', async () => {
    bootApply((server) => {
      write(server);
      return { results: [] };
    });
    await open();
    await clickApply();

    expect(await screen.findByRole('alert')).toHaveTextContent(/did not say whether/i);
    expect(await screen.findByText(EDITED, exact)).toBeInTheDocument();
  });
});
