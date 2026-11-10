// The discovery budget in Settings > AI (#214): the setting, its default, today's spend against
// it, and the postings waiting for it.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import { DiscoveryBudgetCard, DiscoveryBudgetLine } from './DiscoveryBudget';

const BUDGET = { dailyUsd: 1, spentTodayUsd: 0.42, waiting: 12, perTaskDailyUsd: 5 };

describe('DiscoveryBudgetLine', () => {
  it("says today's spend against the budget, and how many postings wait", async () => {
    mockApi({ 'GET /ai/discovery-budget': BUDGET });
    renderWithProviders(<DiscoveryBudgetLine />);
    expect(await screen.findByTestId('discovery-budget-usage')).toHaveTextContent(
      'Discovery budget today: $0.42 of $1.00 spent. 12 postings waiting for budget.',
    );
  });

  it('one posting, or none, reads plainly', async () => {
    mockApi({ 'GET /ai/discovery-budget': { ...BUDGET, spentTodayUsd: 0, waiting: 1 } });
    renderWithProviders(<DiscoveryBudgetLine />);
    expect(await screen.findByTestId('discovery-budget-usage')).toHaveTextContent(
      '$0.00 of $1.00 spent. 1 posting waiting for budget.',
    );
  });
});

describe('DiscoveryBudgetCard', () => {
  it('names everything it covers (#219)', async () => {
    mockApi({
      'GET /ai/discovery-budget': { dailyUsd: 1, spentTodayUsd: 0, waiting: 0, perTaskDailyUsd: 5 },
    });
    renderWithProviders(<DiscoveryBudgetCard />);
    expect(
      await screen.findByText(
        /Covers ranking discovered postings, suggesting industries, tagging companies and suggesting companies\./,
      ),
    ).toBeInTheDocument();
  });

  it('shows the budget, says none is dropped, and names the hard stop', async () => {
    mockApi({ 'GET /ai/discovery-budget': BUDGET });
    renderWithProviders(<DiscoveryBudgetCard />);
    expect(await screen.findByLabelText('Dollars a day')).toHaveValue('1.00');
    expect(screen.getByText(/None is dropped/)).toHaveTextContent(
      'The $5.00 per task per day stays as a hard stop behind it.',
    );
  });

  it('saves a new amount', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /ai/discovery-budget': BUDGET,
      'PUT /ai/discovery-budget': { ...BUDGET, dailyUsd: 2.5 },
    });
    renderWithProviders(<DiscoveryBudgetCard />);
    const input = await screen.findByLabelText('Dollars a day');
    await user.clear(input);
    await user.type(input, '2.5');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ dailyUsd: 2.5 }),
    );
  });

  for (const bad of ['', '0', '-1', 'lots', '10001']) {
    it(`refuses ${JSON.stringify(bad)} without calling the server`, async () => {
      const user = userEvent.setup();
      const { calls } = mockApi({ 'GET /ai/discovery-budget': BUDGET });
      renderWithProviders(<DiscoveryBudgetCard />);
      const input = await screen.findByLabelText('Dollars a day');
      await user.clear(input);
      if (bad !== '') await user.type(input, bad);
      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Enter an amount from $0.01 to $10,000.00.',
      );
      expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    });
  }

  it('says why when the server refuses', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /ai/discovery-budget': BUDGET,
      'PUT /ai/discovery-budget': () => ({
        status: 400,
        body: { error: { code: 'invalid', message: 'not a budget' } },
      }),
    });
    renderWithProviders(<DiscoveryBudgetCard />);
    await screen.findByLabelText('Dollars a day');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  // #218: not oldest first any more, and the order can make a poorer posting wait.
  it('says the best matches go first, and that a poorer one can keep waiting', async () => {
    mockApi({
      'GET /ai/discovery-budget': {
        dailyUsd: 1,
        spentTodayUsd: 0,
        waiting: 0,
        perTaskDailyUsd: 5,
      },
    });
    renderWithProviders(<DiscoveryBudgetCard />);
    expect(await screen.findByText(/the best matches first, then the oldest/)).toBeInTheDocument();
    const words = screen.getByText(/the best matches first, then the oldest/);
    expect(words).toHaveTextContent(
      'while better new postings keep arriving a poorer older one can keep waiting',
    );
    expect(words).not.toHaveTextContent(/oldest first|nothing is skipped/);
  });
});
