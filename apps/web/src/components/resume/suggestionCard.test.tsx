import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import { SuggestionCard } from './SuggestionCard';

const EDIT = {
  find: 'Built the billing platform in Go',
  replace: 'Built the Go billing platform on Kubernetes',
  rationale: 'Mirrors the posting',
};

describe('SuggestionCard', () => {
  it('renders the find text as a deletion and the replacement as an insertion', async () => {
    mockApi({});
    renderWithProviders(<SuggestionCard resumeId="r1" sessionId="s1" edit={EDIT} />);
    const del = await screen.findByRole('deletion');
    const ins = screen.getByRole('insertion');
    expect(del).toHaveTextContent(EDIT.find, { normalizeWhitespace: false });
    expect(ins).toHaveTextContent(EDIT.replace, { normalizeWhitespace: false });
    // Changed words are marked inside each side; shared words are not.
    expect(screen.getAllByTestId('diff-removed').map((n) => n.textContent)).toEqual(['in Go']);
    expect(screen.getAllByTestId('diff-added').map((n) => n.textContent)).toEqual([
      'Go ',
      'on Kubernetes',
    ]);
    expect(screen.getByText('Mirrors the posting')).toBeInTheDocument();
  });

  it('Apply sends exactly that edit to the apply endpoint, then shows it as applied', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'POST /tailoring/s1/suggestions/apply': { results: [{ index: 0, outcome: 'applied' }] },
    });
    renderWithProviders(<SuggestionCard resumeId="r1" sessionId="s1" edit={EDIT} />);
    await user.click(await screen.findByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(screen.getByText('Applied')).toBeInTheDocument());
    const applies = calls.filter((c) => c.path === '/tailoring/s1/suggestions/apply');
    expect(applies).toEqual([
      {
        method: 'POST',
        path: '/tailoring/s1/suggestions/apply',
        search: '',
        body: { edits: [{ find: EDIT.find, replace: EDIT.replace }] },
      },
    ]);
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
  });

  it('reports, not a checkmark, when another applied edit already consumed this one (#146)', async () => {
    const user = userEvent.setup();
    mockApi({
      'POST /tailoring/s1/suggestions/apply': {
        results: [{ index: 0, outcome: 'already_consumed' }],
      },
    });
    renderWithProviders(<SuggestionCard resumeId="r1" sessionId="s1" edit={EDIT} />);
    await user.click(await screen.findByRole('button', { name: 'Apply' }));
    expect(
      await screen.findByText('Already changed by another edit you applied'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Applied')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
  });

  it('keeps Apply available and reports the reason when the text is no longer there', async () => {
    const user = userEvent.setup();
    mockApi({
      'POST /tailoring/s1/suggestions/apply': () => ({
        status: 409,
        body: { error: { code: 'edit_target_missing', index: 0 } },
      }),
    });
    renderWithProviders(<SuggestionCard resumeId="r1" sessionId="s1" edit={EDIT} />);
    await user.click(await screen.findByRole('button', { name: 'Apply' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/no longer in the document/i);
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
  });
});
