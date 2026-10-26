import type { OpportunityStage } from '@opportun/core';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import type { OpportunityView } from '@/lib/opportunities';
import { mockApi, renderWithProviders } from '@/test/render';
import { Pipeline, type PipelineSearch } from './Pipeline';

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

function opp(
  id: string,
  companyName: string,
  title: string,
  stage: OpportunityStage,
  priority: number,
  updatedAt: number,
  sortOrder = 0,
): OpportunityView {
  return {
    id,
    userId: 'u1',
    companyId: `c-${id}`,
    companyName,
    companyDomain: null,
    title,
    stage,
    sourceKind: 'manual',
    priority,
    sortOrder,
    possibleDuplicates: [],
    descriptionIsUserWritten: false,
    hasCapturedPage: false,
    createdAt: NOW,
    updatedAt,
  } as OpportunityView;
}

const FIXTURE = [
  opp('opp-1', 'Globex', 'Principal Engineer', 'applied', 2, NOW - 3 * DAY, 20),
  {
    ...opp('opp-2', 'Acme', 'Staff PM', 'discovered', 1, NOW - DAY, 0),
    sourceKind: 'communication',
  },
  opp('opp-3', 'Initech', 'Director', 'in_process', 3, NOW - 2 * DAY, 10),
] satisfies OpportunityView[];

let latest: PipelineSearch = {};
function Harness({ initial }: { initial: PipelineSearch }) {
  const [search, setSearch] = useState<PipelineSearch>(initial);
  latest = search;
  return (
    <Pipeline
      search={search}
      onSearchChange={(p) =>
        setSearch((s) => {
          latest = { ...s, ...p };
          return latest;
        })
      }
    />
  );
}

async function renderTable(initial: PipelineSearch = { view: 'table' }) {
  mockApi({
    'GET /opportunities': { items: FIXTURE, total: FIXTURE.length },
    'GET /dashboard': {
      stageCounts: {},
      dueNextSteps: [
        {
          id: 's1',
          userId: 'u1',
          opportunityId: 'opp-3',
          action: 'Onsite',
          dueAt: NOW + DAY,
          doneAt: null,
          owner: null,
          createdAt: NOW,
          updatedAt: NOW,
          opportunityTitle: 'Director',
          companyName: 'Initech',
        },
      ],
      recentActivity: [],
      needsTriage: { communications: 0 },
    },
  });
  const user = userEvent.setup();
  renderWithProviders(<Harness initial={initial} />, { path: '/pipeline' });
  await screen.findByRole('table');
  await screen.findByText('Globex');
  return { user };
}

function companies() {
  const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
  return rows.map((r) => within(r).getAllByRole('cell')[0]?.textContent);
}

describe('Pipeline table', () => {
  it('lists every column and defaults to most recently updated first', async () => {
    await renderTable();
    const headers = within(screen.getByRole('table'))
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).toEqual([
      'Company',
      'Title',
      'Stage',
      'Source',
      'Updated',
      'Priority',
      'Next step due',
      'Order',
    ]);
    expect(companies()).toEqual(['Acme', 'Initech', 'Globex']);
    const initech = screen.getByRole('row', { name: /Initech/ });
    expect(within(initech).getAllByRole('cell')[6]?.textContent).not.toBe('');
  });

  it('names where each opportunity came from, same label the detail panel uses (#201)', async () => {
    await renderTable();
    const acme = screen.getByRole('row', { name: /Acme/ });
    expect(within(acme).getAllByRole('cell')[3]?.textContent).toBe('From a message');
    const globex = screen.getByRole('row', { name: /Globex/ });
    expect(within(globex).getAllByRole('cell')[3]?.textContent).toBe('Added manually');
  });

  it('sorts by a column header and keeps the sort in the URL params', async () => {
    const { user } = await renderTable();
    await user.click(screen.getByRole('button', { name: 'Sort by Company' }));
    expect(latest).toMatchObject({ sort: 'company', dir: 'asc' });
    expect(companies()).toEqual(['Acme', 'Globex', 'Initech']);
    await user.click(screen.getByRole('button', { name: 'Sort by Company' }));
    expect(latest).toMatchObject({ sort: 'company', dir: 'desc' });
    expect(companies()).toEqual(['Initech', 'Globex', 'Acme']);
    await user.click(screen.getByRole('button', { name: 'Sort by Priority' }));
    expect(companies()).toEqual(['Acme', 'Globex', 'Initech']);
  });

  it('sorts by the board’s own manual order, issue #240', async () => {
    const { user } = await renderTable();
    // Fixture sortOrder: opp-2 Acme=0, opp-3 Initech=10, opp-1 Globex=20.
    await user.click(screen.getByRole('button', { name: 'Sort by Order' }));
    expect(latest).toMatchObject({ sort: 'order', dir: 'asc' });
    expect(companies()).toEqual(['Acme', 'Initech', 'Globex']);
  });

  it('filters by text and by stage from the URL params', async () => {
    const { user } = await renderTable({ view: 'table', stage: 'applied' });
    expect(companies()).toEqual(['Globex']);
    await user.selectOptions(screen.getByLabelText('Stage filter'), '');
    expect(latest.stage).toBeUndefined();
    expect(companies()).toHaveLength(3);
    await user.type(screen.getByRole('searchbox', { name: 'Filter opportunities' }), 'staff');
    expect(latest.q).toBe('staff');
    expect(companies()).toEqual(['Acme']);
  });

  it('applies j/k selection to table rows', async () => {
    const { user } = await renderTable();
    await user.keyboard('jj');
    const current = screen
      .getAllByRole('row')
      .filter((r) => r.getAttribute('aria-current') === 'true');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent('Initech');
  });
});
