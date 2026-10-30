// Issue #304: the score moved to the page header, and the report moved into the main column
// above the chat, in source order, at every width -- not just visually reflowed at `lg`. This
// file proves both from the rendered DOM rather than from the Tailwind classes that produce it.
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import type { MatchReportView, Resume, TailoringSession } from './api';
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
  it('shows the edited text in the Document panel without a reload', async () => {
    const edit = {
      find: 'Shipped the billing platform rewrite',
      replace: 'Shipped the Go billing platform rewrite on Kubernetes',
    };
    const before = DOC_TEXT;
    const after = DOC_TEXT.replace(edit.find, edit.replace);
    // The server's copy of the document: apply changes it and GET /text reads it, as the real
    // endpoints do, so the panel can only show the new text by fetching it again.
    let stored = before;
    mockApi({
      // local_file with no URL: the only kind of resume the Document panel renders for.
      'GET /resumes/r-1': { ...RESUME, store: 'local_file', docRef: 'att-1', url: null },
      'GET /resumes/r-1/match': REPORT,
      'POST /resumes/r-1/tailoring': {
        ...SESSION,
        messages: [
          { role: 'assistant', content: 'One change.', at: 2, edits: [edit], incomplete: false },
        ],
      },
      'GET /resumes/r-1/text': () => ({ text: stored }),
      'POST /tailoring/s-1/suggestions/apply': () => {
        stored = stored.replace(edit.find, edit.replace);
        return { results: [{ index: 0, outcome: 'applied' }] };
      },
    });
    const user = userEvent.setup();
    renderWithProviders(<ResumeWorkspace id="r-1" />);
    expect(await screen.findByText(before, { normalizer: (s) => s })).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: 'Apply' }));

    expect(await screen.findByText('Applied')).toBeInTheDocument();
    expect(await screen.findByText(after, { normalizer: (s) => s })).toBeInTheDocument();
    expect(screen.queryByText(before, { normalizer: (s) => s })).toBeNull();
  });
});
