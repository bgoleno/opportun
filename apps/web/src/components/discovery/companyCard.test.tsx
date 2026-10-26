import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MergeDialog } from '@/components/opportunity/MergeDialog';
import type { OpportunityView } from '@/lib/opportunities';
import { mockApi, renderWithProviders } from '@/test/render';
import { CompaniesManager } from './CompaniesManager';
import { atsLabel, type CompanyView } from './companiesApi';
import { SuggestionCard } from './CompanyCard';

const NOW = Date.now();

function company(over: Partial<CompanyView> & { id: string; name: string }): CompanyView {
  return {
    userId: 'u1',
    status: 'suggested',
    suggestionRationale: 'Similar to companies in your pipeline.',
    atsKind: null,
    atsRef: null,
    atsVerifiedAt: null,
    careersUrl: null,
    atsDetectPending: false,
    needsCareersUrl: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

const HOSTILE = '<script>window.__pwned = true</script><img src=x onerror="window.__pwned=1">';

describe('SuggestionCard', () => {
  it('renders a hostile name and rationale inert, as text', () => {
    const c = company({
      id: 'c-h',
      name: 'Evil <b>Corp</b>',
      suggestionRationale: `**bold** [x](javascript:alert(1)) ${HOSTILE}`,
    });
    const { container } = render(
      <ul>
        <SuggestionCard company={c} onAccept={vi.fn()} onDeny={vi.fn()} />
      </ul>,
    );
    expect(container.querySelector('script, img, b, strong, a')).toBeNull();
    expect((window as unknown as { __pwned?: unknown }).__pwned).toBeUndefined();
    expect(container).toHaveTextContent('Evil <b>Corp</b>');
    expect(container).toHaveTextContent(`**bold** [x](javascript:alert(1)) ${HOSTILE}`);
  });
});

describe('CompaniesManager', () => {
  const ACME = company({ id: 'c-1', name: 'Acme' });
  const GLOBEX = company({ id: 'c-2', name: 'Globex' });
  const INITECH = company({
    id: 'c-3',
    name: 'Initech',
    status: 'followed',
    atsKind: 'ats_greenhouse',
    atsRef: 'initech',
    atsVerifiedAt: NOW,
  });
  const HOOLI = company({
    id: 'c-4',
    name: 'Hooli',
    status: 'followed',
    atsKind: 'none',
    atsVerifiedAt: NOW,
    needsCareersUrl: true,
  });

  /** Keyed only by method+path (mockApi ignores the query string), so `useFollowedCompanies`
   *  and `useDeniedCompanies` would otherwise collide on the same handler: reads `status`
   *  itself, matching how the real route actually differs by it. */
  function companiesByStatus(call: { search: string }) {
    const status = new URLSearchParams(call.search).get('status');
    return status === 'denied' ? { items: [], total: 0 } : { items: [INITECH, HOOLI], total: 2 };
  }

  function routes(extra: Record<string, unknown> = {}) {
    return mockApi({
      'GET /companies/suggestions': { items: [ACME, GLOBEX], total: 2 },
      'GET /companies': companiesByStatus,
      'GET /discovery/sources': { items: [], total: 0 },
      ...extra,
    });
  }

  it('Follow calls the accept endpoint and drops the suggestion', async () => {
    const user = userEvent.setup();
    let accepted = false;
    const { calls } = routes({
      'GET /companies/suggestions': () => ({
        items: accepted ? [GLOBEX] : [ACME, GLOBEX],
        total: 2,
      }),
      'POST /companies/c-1/accept': () => {
        accepted = true;
        return { status: 200, body: { ...ACME, status: 'followed' } };
      },
    });
    renderWithProviders(<CompaniesManager />);
    await user.click(await screen.findByRole('button', { name: 'Follow Acme' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path === '/companies/c-1/accept')).toBe(
        true,
      ),
    );
    const list = screen.getByRole('list', { name: 'Suggested companies' });
    expect(within(list).queryByText('Acme')).toBeNull();
    expect(calls.some((c) => c.path.endsWith('/deny'))).toBe(false);
  });

  it('Deny calls the deny endpoint', async () => {
    const user = userEvent.setup();
    const { calls } = routes({ 'POST /companies/c-2/deny': { ...GLOBEX, status: 'denied' } });
    renderWithProviders(<CompaniesManager />);
    await user.click(await screen.findByRole('button', { name: 'Deny Globex' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path === '/companies/c-2/deny')).toBe(true),
    );
    expect(calls.some((c) => c.path.endsWith('/accept'))).toBe(false);
  });

  it('a 409 not_suggested restores the suggestion and explains', async () => {
    const user = userEvent.setup();
    routes({
      'POST /companies/c-1/accept': () => ({
        status: 409,
        body: { error: { code: 'not_suggested', message: 'not a suggestion' } },
      }),
    });
    renderWithProviders(<CompaniesManager />);
    await user.click(await screen.findByRole('button', { name: 'Follow Acme' }));
    expect(
      await screen.findByText('That company is no longer a pending suggestion.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Follow Acme' })).toBeInTheDocument();
  });

  it('shows ATS status, and Detect now calls detect-ats', async () => {
    const user = userEvent.setup();
    const { calls } = routes({
      'POST /companies/c-3/detect-ats': () => ({ status: 202, body: { jobId: 'j1' } }),
    });
    renderWithProviders(<CompaniesManager />);
    const row = await screen.findByRole('listitem', { name: 'Initech' });
    expect(row).toHaveTextContent('Greenhouse: initech');
    expect(
      within(screen.getByRole('listitem', { name: 'Hooli' })).getByText(/No board found/),
    ).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Detect board for Initech' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path === '/companies/c-3/detect-ats')).toBe(
        true,
      ),
    );
  });

  it('the needs-careers-URL prompt patches the company, then queues detection', async () => {
    const user = userEvent.setup();
    const { calls } = routes({
      'PATCH /companies/c-4': { ...HOOLI, careersUrl: 'https://hooli.example/jobs' },
      'POST /companies/c-4/detect-ats': () => ({ status: 202, body: { jobId: 'j2' } }),
    });
    renderWithProviders(<CompaniesManager />);
    const row = await screen.findByRole('listitem', { name: 'Hooli' });
    const input = within(row).getByLabelText('Careers URL');
    await user.type(input, 'javascript:alert(1)');
    await user.click(within(row).getByRole('button', { name: 'Save' }));
    expect(within(row).getByRole('alert')).toHaveTextContent('Enter an http or https URL.');
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);

    await user.clear(input);
    await user.type(input, 'https://hooli.example/jobs');
    await user.click(within(row).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const writes = calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);
      expect(writes).toEqual(['PATCH /companies/c-4', 'POST /companies/c-4/detect-ats']);
    });
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      careersUrl: 'https://hooli.example/jobs',
    });
  });

  it('a failed detection after a saved careers URL is still reported', async () => {
    const user = userEvent.setup();
    let saved = false;
    const SAVED = {
      ...HOOLI,
      careersUrl: 'https://hooli.example/jobs',
      needsCareersUrl: false,
    };
    routes({
      'GET /companies': (call: { search: string }) => {
        const status = new URLSearchParams(call.search).get('status');
        return status === 'denied'
          ? { items: [], total: 0 }
          : { items: [INITECH, saved ? SAVED : HOOLI], total: 2 };
      },
      'PATCH /companies/c-4': () => {
        saved = true;
        // A handler result with a status key is read as {status, body}: wrap the company.
        return { status: 200, body: SAVED };
      },
      'POST /companies/c-4/detect-ats': () => ({
        status: 500,
        body: { error: { code: 'internal', message: 'Detection is unavailable.' } },
      }),
    });
    renderWithProviders(<CompaniesManager />);
    const row = await screen.findByRole('listitem', { name: 'Hooli' });
    await user.type(within(row).getByLabelText('Careers URL'), 'https://hooli.example/jobs');
    await user.click(within(row).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Careers URL saved, detection not queued')).toBeInTheDocument();
    expect(
      screen.getByText('Detection is unavailable. Use Detect now to retry.'),
    ).toBeInTheDocument();
    // The URL stayed saved: the refetched row drops the prompt and links the careers page.
    const after = screen.getByRole('listitem', { name: 'Hooli' });
    await waitFor(() => expect(within(after).queryByLabelText('Careers URL')).toBeNull());
    expect(within(after).getByRole('link', { name: 'Careers' })).toHaveAttribute(
      'href',
      'https://hooli.example/jobs',
    );
  });

  describe('denying a company directly (issue #199)', () => {
    const ORACLE = company({ id: 'c-oracle', name: 'Oracle', status: 'denied' });

    it('denies a company by name, says how many pending results from it are already queued', async () => {
      const user = userEvent.setup();
      const posts: unknown[] = [];
      routes({
        'POST /companies': (call: { body: unknown }) => {
          posts.push(call.body);
          return { status: 201, body: ORACLE };
        },
        'GET /companies/c-oracle/pending-count': { count: 3 },
      });
      renderWithProviders(<CompaniesManager />);
      await user.type(await screen.findByLabelText('Company name'), 'Oracle');
      await user.click(screen.getByRole('button', { name: 'Deny' }));
      await waitFor(() => expect(posts).toEqual([{ name: 'Oracle', status: 'denied' }]));
      expect(
        await screen.findByText(
          'Oracle. 3 pending results from Oracle are still in your review queue -- they stay until you dismiss them yourself.',
        ),
      ).toBeInTheDocument();
    });

    it('says nothing extra when nothing is already pending from the denied company', async () => {
      const user = userEvent.setup();
      routes({
        'POST /companies': () => ({ status: 201, body: ORACLE }),
        'GET /companies/c-oracle/pending-count': { count: 0 },
      });
      renderWithProviders(<CompaniesManager />);
      await user.type(await screen.findByLabelText('Company name'), 'Oracle');
      await user.click(screen.getByRole('button', { name: 'Deny' }));
      const toasts = await screen.findAllByText('Oracle');
      expect(toasts.length).toBeGreaterThan(0);
      expect(screen.queryByText(/pending results from Oracle/)).not.toBeInTheDocument();
    });

    it('lists denied companies with an Undo that reverses the denial', async () => {
      const user = userEvent.setup();
      let status: string = 'denied';
      const { calls } = routes({
        'GET /companies': (call: { search: string }) => {
          const q = new URLSearchParams(call.search).get('status');
          if (q === 'denied')
            return {
              items: status === 'denied' ? [ORACLE] : [],
              total: status === 'denied' ? 1 : 0,
            };
          return { items: [INITECH, HOOLI], total: 2 };
        },
        'PATCH /companies/c-oracle': () => {
          status = 'none';
          return { ...ORACLE, status: 'none' };
        },
      });
      renderWithProviders(<CompaniesManager />);
      const row = await screen.findByRole('listitem', { name: 'Oracle' });
      await user.click(within(row).getByRole('button', { name: 'Undo denying Oracle' }));
      await waitFor(() =>
        expect(calls.find((c) => c.path === '/companies/c-oracle')?.body).toEqual({
          status: 'none',
        }),
      );
      await waitFor(() =>
        expect(screen.getByText('You have not denied any companies.')).toBeInTheDocument(),
      );
    });
  });
});

describe('MergeDialog', () => {
  const THIS = {
    id: 'opp-1',
    userId: 'u1',
    companyId: 'c1',
    companyName: 'Acme',
    title: 'Staff PM',
    stage: 'applied',
    sourceKind: 'manual',
    priority: 2,
    createdAt: NOW,
    updatedAt: NOW,
  } as OpportunityView;
  const OTHER = {
    ...THIS,
    id: 'opp-2',
    title: 'Staff Product Manager',
    stage: 'in_process',
  } as OpportunityView;

  it('merges this opportunity into the chosen one and opens the kept opportunity', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /opportunities': { items: [THIS, OTHER], total: 2 },
      'POST /opportunities/opp-2/merge': OTHER,
    });
    const { router } = renderWithProviders(<MergeDialog opp={THIS} open onOpenChange={vi.fn()} />, {
      path: '/opportunities/opp-1',
    });
    const picker = await screen.findByRole('list', { name: 'Matching opportunities' });
    // The open opportunity is never offered as its own merge target.
    await within(picker).findByText('Staff Product Manager at Acme');
    expect(within(picker).queryByText('Staff PM at Acme')).toBeNull();
    await user.click(within(picker).getByRole('button', { name: /Staff Product Manager at Acme/ }));

    const dialog = screen.getByRole('dialog', { name: 'Merge these opportunities?' });
    expect(dialog).toHaveTextContent('Merged away (deleted)Staff PM at Acme');
    expect(dialog).toHaveTextContent('KeptStaff Product Manager at Acme');
    await user.click(within(dialog).getByRole('button', { name: 'Merge' }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST');
      expect(post?.path).toBe('/opportunities/opp-2/merge');
      expect(post?.body).toEqual({ otherId: 'opp-1' });
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/opportunities/opp-2'));
  });

  it('a 422 from the server is shown as a toast and nothing navigates', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /opportunities': { items: [OTHER], total: 1 },
      'POST /opportunities/opp-2/merge': () => ({
        status: 422,
        body: { error: { code: 'merge_self' } },
      }),
    });
    const { router } = renderWithProviders(<MergeDialog opp={THIS} open onOpenChange={vi.fn()} />, {
      path: '/opportunities/opp-1',
    });
    await user.click(await screen.findByRole('button', { name: /Staff Product Manager at Acme/ }));
    await user.click(screen.getByRole('button', { name: 'Merge' }));
    expect(
      await screen.findByText('An opportunity cannot be merged into itself.'),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/opportunities/opp-1');
  });
});

describe('atsLabel', () => {
  it('names a detected Workday board like the other providers', () => {
    expect(atsLabel('ats_workday')).toBe('Workday');
    expect(atsLabel('ats_lever')).toBe('Lever');
  });
});
