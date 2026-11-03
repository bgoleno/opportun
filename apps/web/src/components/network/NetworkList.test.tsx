import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import { NetworkList } from './NetworkList';
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
    'GET /network': (call: ApiCall) => paged(new URLSearchParams(call.search)),
  });
}

// The tests about the default page show its full 200 rows ("Showing a-b" counts the rows). The
// keyboard and search tests page through the same directory 5 rows at a time (the list's
// pageSize, https://github.com/bgoleno/opportun/issues/161): their claims are about which page
// a key or a search lands on, and re-rendering 154 to 200 rows per step was most of their time. What made them slow was not the render (about 0.1 s
// for the 1,660 nodes of a page) but whole-document role queries over it
// (https://github.com/bgoleno/opportun/issues/161): `getByRole('row', { name })` computes the
// accessible name of all 201 rows, about 0.25 s on an idle worker per call, and every
// `getByRole('button')` checks the role of every node. A full gate run slows that CPU work
// 10x or more. So a row is found by its contact's name, and a pager button inside the pager.
/** The table row that shows this contact, or null. */
function contactRow(name: string): HTMLElement | null {
  return screen.queryByText(name)?.closest('tr') ?? null;
}
/** A button of the pager, looked up inside the pager rather than across the page. */
function pagerButton(name: string): HTMLElement {
  return within(screen.getByRole('navigation', { name: 'Network pages' })).getByRole('button', {
    name,
  });
}

describe('NetworkList pagination (issue #207)', () => {
  it('shows the first page with its position and a page count, not stuck at 200', async () => {
    bootContacts();
    renderWithProviders(<NetworkList />);
    expect(await screen.findByText(/Showing 1–200 of 1754\./)).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 9')).toBeInTheDocument();
    expect(contactRow('Contact 0000')).not.toBeNull();
    expect(contactRow('Contact 0200')).toBeNull();
  });

  it('pages forward and back with the on-screen controls', async () => {
    const user = userEvent.setup();
    bootContacts();
    renderWithProviders(<NetworkList />);
    await screen.findByText(/Showing 1–200 of 1754\./);

    await user.click(pagerButton('Next page'));
    expect(await screen.findByText(/Showing 201–400 of 1754\./)).toBeInTheDocument();
    expect(contactRow('Contact 0200')).not.toBeNull();
    expect(contactRow('Contact 0000')).toBeNull();

    await user.click(pagerButton('Previous page'));
    expect(await screen.findByText(/Showing 1–200 of 1754\./)).toBeInTheDocument();
  });

  it('jumps to the last page, which holds the remainder, not a full 200', async () => {
    const user = userEvent.setup();
    bootContacts();
    renderWithProviders(<NetworkList />);
    await screen.findByText(/Showing 1–200 of 1754\./);

    await user.click(pagerButton('Last page'));
    // 1754 = 8 full pages of 200 (1600) + 154 on the 9th.
    expect(await screen.findByText(/Showing 1601–1754 of 1754\./)).toBeInTheDocument();
    expect(screen.getByText('Page 9 of 9')).toBeInTheDocument();
    expect(pagerButton('Next page')).toBeDisabled();
    expect(pagerButton('Last page')).toBeDisabled();

    await user.click(pagerButton('First page'));
    expect(await screen.findByText(/Showing 1–200 of 1754\./)).toBeInTheDocument();
    expect(pagerButton('Previous page')).toBeDisabled();
    expect(pagerButton('First page')).toBeDisabled();
  });

  it('pages with the keyboard: n, p, Home and End', async () => {
    const user = userEvent.setup();
    const { calls } = bootContacts();
    renderWithProviders(<NetworkList pageSize={5} />);
    await screen.findByText(/Showing 1–5 of 1754\./);
    // Focus must be outside the search input, or useHotkeys ignores the keystroke (never
    // steals a key while typing).
    await user.click(screen.getByRole('table', { name: 'Network' }));

    await user.keyboard('n');
    expect(await screen.findByText(/Showing 6–10 of 1754\./)).toBeInTheDocument();

    // 1754 = 350 full pages of 5 (1750) + 4 on the 351st.
    await user.keyboard('{End}');
    expect(await screen.findByText(/Showing 1751–1754 of 1754\./)).toBeInTheDocument();

    await user.keyboard('p');
    expect(await screen.findByText(/Showing 1746–1750 of 1754\./)).toBeInTheDocument();

    await user.keyboard('{Home}');
    expect(await screen.findByText(/Showing 1–5 of 1754\./)).toBeInTheDocument();
    // Every page was asked for at the list's page size.
    expect(new Set(calls.map((c) => new URLSearchParams(c.search).get('limit')))).toEqual(
      new Set(['5']),
    );
  });

  it('does not page past either end', async () => {
    bootContacts();
    renderWithProviders(<NetworkList />);
    await screen.findByText(/Showing 1–200 of 1754\./);
    expect(pagerButton('Previous page')).toBeDisabled();
    expect(pagerButton('First page')).toBeDisabled();
  });

  it('shows no pager at all when everything fits on one page', async () => {
    const { calls } = mockApi({
      'GET /network': { items: [contact(0), contact(1)], total: 2 },
    });
    renderWithProviders(<NetworkList />);
    await screen.findByText(/Showing 1–2 of 2\./);
    expect(screen.queryByRole('navigation', { name: 'Network pages' })).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('a search resets to the first page, not wherever paging left off', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /network': (call: ApiCall) => paged(new URLSearchParams(call.search)),
    });
    renderWithProviders(<NetworkList pageSize={5} />);
    await screen.findByText(/Showing 1–5 of 1754\./);

    await user.click(pagerButton('Last page'));
    await screen.findByText(/Showing 1751–1754 of 1754\./);

    await user.type(screen.getByLabelText('Search your network'), 'Contact 0005');
    // Exactly one match ("Contact 0005"), so the reset lands on a real first page, not an
    // empty one left over from the old query's last page.
    expect(await screen.findByText(/Showing 1–1 of 1\./)).toBeInTheDocument();
    expect(contactRow('Contact 0005')).not.toBeNull();

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
      'GET /network': (call: ApiCall) => {
        const search = new URLSearchParams(call.search);
        const q = search.get('q');
        const offset = Number(search.get('offset') ?? '0');
        const rows = q === null ? ALL : matches;
        return { items: rows.slice(offset, offset + PAGE_SIZE), total: rows.length };
      },
    });
    renderWithProviders(<NetworkList />);
    await screen.findByText(/Showing 1–200 of 1754\./);
    await user.type(screen.getByLabelText('Search your network'), '0');
    await screen.findByText((text) => text.includes(`of ${matches.length}.`));

    await user.click(pagerButton('Next page'));
    await waitFor(() => {
      const last = calls.at(-1)!;
      expect(new URLSearchParams(last.search).get('offset')).toBe('200');
    });
    expect(new URLSearchParams(calls.at(-1)!.search).get('q')).toBe('0');
  });
});
