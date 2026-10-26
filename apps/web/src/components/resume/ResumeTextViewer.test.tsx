// The document viewer (issue #321): the demo's flagship feature (score a resume, chat about
// it, re-score) had no surface showing the document itself. Read-only by design: editing is
// what the tailoring chat and applyEdits are for.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import { ResumeTextViewer, ResumeTextViewerView } from './ResumeTextViewer';

const TEXT = 'Avery Chen\nSenior Engineer\n\n- Shipped the billing platform rewrite';
/** getByText's default normalizer collapses newlines to spaces; this text is tested exactly
 *  as rendered (whitespace-pre-wrap means the blank line and the bullet are the point). */
const exact = { normalizer: (s: string) => s };

describe('ResumeTextViewerView', () => {
  it('shows a loading state before the text resolves', () => {
    render(<ResumeTextViewerView text={undefined} error={null} />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByText(/Avery Chen/)).toBeNull();
  });

  it('shows a server error', () => {
    render(<ResumeTextViewerView text={undefined} error={new Error('boom')} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('renders the document text, expanded by default, preserving blank lines and bullets', () => {
    render(<ResumeTextViewerView text={TEXT} error={null} />);
    // Rendered as one block (whitespace-pre-wrap), not split into separate elements per line:
    // a single query for the whole text proves blank lines and the bullet survived untouched.
    expect(screen.getByText(TEXT, exact)).toBeInTheDocument();
  });

  it('collapses and reopens on request', async () => {
    const user = userEvent.setup();
    render(<ResumeTextViewerView text={TEXT} error={null} />);
    expect(screen.getByText(TEXT, exact)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /hide document/i }));
    expect(screen.queryByText(TEXT, exact)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /show document/i }));
    expect(screen.getByText(TEXT, exact)).toBeInTheDocument();
  });

  it('is empty does not crash: an empty document is a resolved state, not a loading one', () => {
    render(<ResumeTextViewerView text="" error={null} />);
    expect(screen.queryByText('Loading...')).toBeNull();
    expect(screen.getByRole('button', { name: /hide document/i })).toBeInTheDocument();
  });
});

describe('ResumeTextViewer (container)', () => {
  it('fetches and shows the stored text on mount', async () => {
    mockApi({ 'GET /resumes/r-1/text': { text: TEXT } });
    renderWithProviders(<ResumeTextViewer resumeId="r-1" />);
    expect(await screen.findByText(TEXT, exact)).toBeInTheDocument();
  });
});
