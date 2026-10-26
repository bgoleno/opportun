import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import { ContactList } from './ContactList';
import type { Contact } from './api';

const TOTAL = 1754;
const PAGE_SIZE = 200;

function contact(i: number): Contact {
  return {
    id: `contact-${i}`,
    name: `Contact ${String(i).padStart(4, '0')}`,
    emails: [],
    linkedinUrl: null,
    currentCompanyId: null,
    currentCompanyName: null,
    history: [],
    strength: null,
    notes: null,
    source: 'manual',
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

/** A full synthetic directory, so the handler can slice by whatever offset/limit/q a
 *  request actually asks for, the same way the real server would. */
const ALL = Array.from({ length: TOTAL }, (_, i) => contact(i));

function paged(search: URLSearchParams) {
  const limit = Number(search.get('limit') ?? '200');
  const offset = Number(search.get('offset') ?? '0');
  const q = search.get('q');
  const filtered = q === null ? ALL : ALL.filter((c) => c.name.includes(q));
  return { items: filtered.slice(offset, offset + limit), total: filtered.length };
}

function bootContacts() {
  return mockApi({
    'GET /contacts': (call: ApiCall) => paged(new URLSearchParams(call.search)),
  });
}

describe('ContactList pagination (issue #207)', () => {
  it('shows the first page with its position and a page count, not stuck at 200', async () => {
    bootContacts();
    renderWithProviders(<ContactList />);
    expect(await screen.findByText(/Showing 1–200 of 1754\./)).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 9')).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /Contact 0000/ })).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: /Contact 0200/ })).toBeNull();
  });

  it('pages forward and back with the on-screen controls', async () => {
    const user = userEvent.setup();
    bootContacts();
    renderWithProviders(<ContactList />);
    await screen.findByText(/Showing 1–200 of 1754\./);

    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText(/Showing 201–400 of 1754\./)).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /Contact 0200/ })).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: /Contact 0000/ })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(await screen.findByText(/Showing 1–200 of 1754\./)).toBeInTheDocument();
  });

  it('jumps to the last page, which holds the remainder, not a full 200', async () => {
    const user = userEvent.setup();
    bootContacts();
    renderWithProviders(<ContactList />);
    await screen.findByText(/Showing 1–200 of 1754\./);

    await user.click(screen.getByRole('button', { name: 'Last page' }));
    // 1754 = 8 full pages of 200 (1600) + 154 on the 9th.
    expect(await screen.findByText(/Showing 1601–1754 of 1754\./)).toBeInTheDocument();
    expect(screen.getByText('Page 9 of 9')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Last page' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'First page' }));
    expect(await screen.findByText(/Showing 1–200 of 1754\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'First page' })).toBeDisabled();
  });

  it('pages with the keyboard: n, p, Home and End', async () => {
    const user = userEvent.setup();
    bootContacts();
    renderWithProviders(<ContactList />);
    await screen.findByText(/Showing 1–200 of 1754\./);
    // Focus must be outside the search input, or useHotkeys ignores the keystroke (never
    // steals a key while typing).
    await user.click(screen.getByRole('table', { name: 'Contacts' }));

    await user.keyboard('n');
    expect(await screen.findByText(/Showing 201–400 of 1754\./)).toBeInTheDocument();

    await user.keyboard('{End}');
    expect(await screen.findByText(/Showing 1601–1754 of 1754\./)).toBeInTheDocument();

    await user.keyboard('p');
    expect(await screen.findByText(/Showing 1401–1600 of 1754\./)).toBeInTheDocument();

    await user.keyboard('{Home}');
    expect(await screen.findByText(/Showing 1–200 of 1754\./)).toBeInTheDocument();
  });

  it('does not page past either end', async () => {
    bootContacts();
    renderWithProviders(<ContactList />);
    await screen.findByText(/Showing 1–200 of 1754\./);
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'First page' })).toBeDisabled();
  });

  it('shows no pager at all when everything fits on one page', async () => {
    const { calls } = mockApi({
      'GET /contacts': { items: [contact(0), contact(1)], total: 2 },
    });
    renderWithProviders(<ContactList />);
    await screen.findByText(/Showing 1–2 of 2\./);
    expect(screen.queryByRole('navigation', { name: 'Contacts pages' })).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('a search resets to the first page, not wherever paging left off', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /contacts': (call: ApiCall) => paged(new URLSearchParams(call.search)),
    });
    renderWithProviders(<ContactList />);
    await screen.findByText(/Showing 1–200 of 1754\./);

    await user.click(screen.getByRole('button', { name: 'Last page' }));
    await screen.findByText(/Showing 1601–1754 of 1754\./);

    await user.type(screen.getByLabelText('Search contacts'), 'Contact 0005');
    // Exactly one match ("Contact 0005"), so the reset lands on a real first page, not an
    // empty one left over from the old query's last page.
    expect(await screen.findByText(/Showing 1–1 of 1\./)).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /Contact 0005/ })).toBeInTheDocument();

    // The request that actually won the race carried the new query, not a page number
    // computed against the old one's total.
    const last = calls.at(-1)!;
    expect(new URLSearchParams(last.search).get('q')).toBe('Contact 0005');
    expect(new URLSearchParams(last.search).get('offset')).toBe('0');
  });

  it('keeps the current query when paging through its own results', async () => {
    const user = userEvent.setup();
    const matches = Array.from({ length: 250 }, (_, i) => contact(i)).filter((c) =>
      c.name.includes('0'),
    );
    const { calls } = mockApi({
      'GET /contacts': (call: ApiCall) => {
        const search = new URLSearchParams(call.search);
        const q = search.get('q');
        const offset = Number(search.get('offset') ?? '0');
        const rows = q === null ? ALL : matches;
        return { items: rows.slice(offset, offset + PAGE_SIZE), total: rows.length };
      },
    });
    renderWithProviders(<ContactList />);
    await screen.findByText(/Showing 1–200 of 1754\./);
    await user.type(screen.getByLabelText('Search contacts'), '0');
    await screen.findByText((text) => text.includes(`of ${matches.length}.`));

    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => {
      const last = calls.at(-1)!;
      expect(new URLSearchParams(last.search).get('offset')).toBe('200');
    });
    expect(new URLSearchParams(calls.at(-1)!.search).get('q')).toBe('0');
  });
});
