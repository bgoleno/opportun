import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import { UsageTable } from './UsageTable';

const row = (taskKey: string, estimated: boolean, estCostUsd: number) => ({
  day: '2026-10-15',
  taskKey,
  runs: 1,
  errors: 0,
  inputTokens: 1000,
  outputTokens: 100,
  estCostUsd,
  estimated,
});

const zero = {
  runs: 0,
  errors: 0,
  inputTokens: 0,
  outputTokens: 0,
  estCostUsd: 0,
  estimated: false,
};
const model = (name: string, runs: number, estCostUsd: number, provider = 'anthropic') => ({
  provider,
  model: name,
  ...zero,
  runs,
  inputTokens: 1000 * runs,
  outputTokens: 100 * runs,
  estCostUsd,
});

// Made-up figures, in the shape GET /ai/usage returns (#341): every feature and every task, zero
// where nothing ran (the server fills the zeros; the table must show them, not hide them).
const FEATURES = [
  {
    feature: 'mail',
    label: 'Mail',
    ...zero,
    runs: 3,
    errors: 1,
    inputTokens: 3000,
    outputTokens: 300,
    estCostUsd: 0.03,
    tasks: [
      { taskKey: 'comms.triage', ...zero, models: [] },
      {
        taskKey: 'comms.classify',
        ...zero,
        runs: 3,
        errors: 1,
        inputTokens: 3000,
        outputTokens: 300,
        estCostUsd: 0.03,
        models: [model('claude-haiku-5-5', 2, 0.01), model('claude-sonnet-5-5', 1, 0.02)],
      },
    ],
  },
  {
    feature: 'matching',
    label: 'Matching',
    ...zero,
    runs: 1,
    inputTokens: 1000,
    outputTokens: 100,
    estCostUsd: 0.5,
    tasks: [
      {
        taskKey: 'resume.match',
        ...zero,
        runs: 1,
        inputTokens: 1000,
        outputTokens: 100,
        estCostUsd: 0.5,
        models: [model('claude-opus-5-5', 1, 0.5)],
      },
    ],
  },
  {
    feature: 'discovery',
    label: 'Discovery',
    ...zero,
    tasks: [
      { taskKey: 'discovery.rank', ...zero, models: [] },
      { taskKey: 'discovery.company_tags', ...zero, models: [] },
    ],
  },
];

const allZero = FEATURES.map((f) => ({
  ...f,
  ...zero,
  tasks: f.tasks.map((t) => ({ ...t, ...zero, models: [] })),
}));

const cells = (r: HTMLElement) =>
  within(r)
    .getAllByRole('cell')
    .map((c) => c.textContent);

describe('UsageTable', () => {
  it('marks fallback-priced costs as estimated, including the total', async () => {
    mockApi({
      'GET /ai/usage': {
        days: 30,
        items: [row('comms.classify', false, 0.0002), row('capture.extract', true, 0.048)],
        totals: [
          { ...row('capture.extract', true, 0.048), day: undefined },
          { ...row('comms.classify', false, 0.0002), day: undefined },
        ],
        features: allZero,
      },
    });
    renderWithProviders(<UsageTable />);
    const table = await screen.findByRole('table', { name: 'AI usage by day and task' });
    const priced = within(table).getByRole('row', { name: /comms\.classify/ });
    const fallback = within(table).getByRole('row', { name: /capture\.extract/ });
    const total = within(table).getByRole('row', { name: /Total/ });
    expect(within(priced).queryByText('(estimated)')).not.toBeInTheDocument();
    expect(within(fallback).getByText('(estimated)')).toBeInTheDocument();
    expect(within(total).getByText('(estimated)')).toBeInTheDocument();
  });
});

describe('UsageTable by feature (#341)', () => {
  it('with no calls in the window, lists every feature at zero instead of a blank message', async () => {
    mockApi({ 'GET /ai/usage': { days: 30, items: [], totals: [], features: allZero } });
    renderWithProviders(<UsageTable />);
    const table = await screen.findByRole('table', { name: 'AI usage by feature' });
    for (const label of ['Mail', 'Matching', 'Discovery']) {
      const r = within(table).getByRole('row', { name: (name) => name.startsWith(label) });
      expect(cells(r).slice(1)).toEqual(['', '0', '0', '0', '$0.00']);
    }
    expect(screen.queryByText('No AI calls in this window.')).not.toBeInTheDocument();
    // Nothing ran, so there is no by-day table.
    expect(screen.queryByRole('table', { name: 'AI usage by day and task' })).toBeNull();
  });

  it("shows each feature's totals, and its tasks and models when expanded", async () => {
    mockApi({ 'GET /ai/usage': { days: 30, items: [], totals: [], features: FEATURES } });
    renderWithProviders(<UsageTable />);
    const table = await screen.findByRole('table', { name: 'AI usage by feature' });
    const mailRow = within(table).getByRole('row', { name: /^Mail/ });
    expect(cells(mailRow).slice(1)).toEqual(['', '3 (1 failed)', '3,000', '300', '$0.03']);
    const total = within(table).getByRole('row', { name: /^Total/ });
    expect(cells(total).slice(1)).toEqual(['', '4 (1 failed)', '4,000', '400', '$0.53']);
    expect(within(table).queryByRole('row', { name: /comms\.classify/ })).toBeNull();

    const toggle = within(mailRow).getByRole('button', { name: 'Mail' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    // A task that never ran is a zero row, not a missing one.
    const triage = within(table).getByRole('row', { name: /comms\.triage/ });
    expect(cells(triage)).toEqual(['comms.triage', '', '0', '0', '0', '$0.00']);
    // A task that used two models: its totals, then one row per model.
    const classify = within(table).getByRole('row', { name: /comms\.classify/ });
    expect(cells(classify)).toEqual([
      'comms.classify',
      '2 models',
      '3 (1 failed)',
      '3,000',
      '300',
      '$0.03',
    ]);
    const haiku = within(table).getByRole('row', { name: /claude-haiku-5-5/ });
    expect(cells(haiku).slice(1)).toEqual([
      'claude-haiku-5-5 (Anthropic)',
      '2',
      '2,000',
      '200',
      '$0.01',
    ]);
    expect(within(table).getByRole('row', { name: /claude-sonnet-5-5/ })).toBeInTheDocument();
    // Other features stay closed.
    expect(within(table).queryByRole('row', { name: /resume\.match/ })).toBeNull();

    // A task on one model names it in its own row.
    await userEvent.click(within(table).getByRole('button', { name: 'Matching' }));
    const match = within(table).getByRole('row', { name: /resume\.match/ });
    expect(cells(match).slice(0, 2)).toEqual(['resume.match', 'claude-opus-5-5 (Anthropic)']);

    await userEvent.click(toggle);
    expect(within(table).queryByRole('row', { name: /comms\.classify/ })).toBeNull();
  });

  it('names the provider on each model row, so one model id through two providers reads as two (#350)', async () => {
    const viaTwo = {
      feature: 'capture',
      label: 'Capture',
      ...zero,
      runs: 3,
      inputTokens: 3000,
      outputTokens: 300,
      estCostUsd: 0.04,
      tasks: [
        {
          taskKey: 'capture.extract',
          ...zero,
          runs: 3,
          inputTokens: 3000,
          outputTokens: 300,
          estCostUsd: 0.04,
          models: [
            model('gpt-6-sol', 2, 0.04, 'openai'),
            model('gpt-6-sol', 1, 0, 'openai_compatible'),
          ],
        },
        {
          taskKey: 'capture.job',
          ...zero,
          runs: 1,
          inputTokens: 1000,
          outputTokens: 100,
          estCostUsd: 0.5,
          models: [model('local-llm', 1, 0.5, 'openai_compatible')],
        },
      ],
    };
    mockApi({ 'GET /ai/usage': { days: 30, items: [], totals: [], features: [viaTwo] } });
    renderWithProviders(<UsageTable />);
    const table = await screen.findByRole('table', { name: 'AI usage by feature' });
    await userEvent.click(within(table).getByRole('button', { name: 'Capture' }));

    const extract = within(table).getByRole('row', { name: /capture\.extract/ });
    expect(cells(extract)[1]).toBe('2 models');
    const openai = within(table).getByRole('row', { name: /gpt-6-sol \(OpenAI\)/ });
    expect(cells(openai).slice(1)).toEqual(['gpt-6-sol (OpenAI)', '2', '2,000', '200', '$0.04']);
    const gateway = within(table).getByRole('row', { name: /gpt-6-sol \(OpenAI-compatible\)/ });
    expect(cells(gateway).slice(1)).toEqual([
      'gpt-6-sol (OpenAI-compatible)',
      '1',
      '1,000',
      '100',
      '$0.00',
    ]);
    // A task on one model names its provider in its own row too.
    const job = within(table).getByRole('row', { name: /capture\.job/ });
    expect(cells(job)[1]).toBe('local-llm (OpenAI-compatible)');
  });

  it('asks for the chosen window', async () => {
    const { calls } = mockApi({
      'GET /ai/usage': { days: 30, items: [], totals: [], features: allZero },
    });
    renderWithProviders(<UsageTable />);
    await screen.findByRole('table', { name: 'AI usage by feature' });
    fireEvent.change(screen.getByLabelText('Window'), { target: { value: '90' } });
    await screen.findByRole('table', { name: 'AI usage by feature' });
    await expect
      .poll(() => calls.filter((c) => c.path === '/ai/usage').map((c) => c.search))
      .toEqual(['?days=30', '?days=90']);
  });
});
