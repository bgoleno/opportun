import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import type { IndustryRow } from './companiesApi';
import { IndustryProfilePanel } from './IndustryProfilePanel';

const URL = '/discovery/industry-profile';

const row = (over: Partial<IndustryRow> & { code: string }): IndustryRow => ({
  title: `Title ${over.code}`,
  tier: 'core',
  source: 'resume',
  reason: `Reason ${over.code}.`,
  confirmed: false,
  ...over,
});

async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  renderWithProviders(<IndustryProfilePanel />);
  await user.click(await screen.findByText('Where to look'));
}

describe('Where to look (#219)', () => {
  it('is collapsible, and closed until opened', async () => {
    mockApi({ [`GET ${URL}`]: { items: [row({ code: '5132' })] } });
    const user = userEvent.setup();
    renderWithProviders(<IndustryProfilePanel />);
    const summary = await screen.findByText('Where to look');
    const details = summary.closest('details');
    expect(details).not.toHaveAttribute('open');
    await user.click(summary);
    expect(details).toHaveAttribute('open');
  });

  it('says how many count, and how many wait, while closed', async () => {
    mockApi({
      [`GET ${URL}`]: {
        items: [
          row({ code: '5132', confirmed: true }),
          row({ code: '5415' }),
          row({ code: '5182' }),
        ],
      },
    });
    renderWithProviders(<IndustryProfilePanel />);
    expect(await screen.findByText('1 confirmed, 2 to review')).toBeInTheDocument();
  });

  it('shows the rows by tier, with the reason, where each came from and whether it counts', async () => {
    mockApi({
      [`GET ${URL}`]: {
        items: [
          row({ code: '5132', tier: 'core', source: 'resume', confirmed: true }),
          row({ code: '5222', tier: 'similar', source: 'target' }),
          row({ code: '2211', tier: 'adjacent', source: 'user', reason: null, confirmed: true }),
        ],
      },
    });
    const user = userEvent.setup();
    await openPanel(user);

    const core = await screen.findByRole('list', { name: 'Core industries' });
    expect(within(core).getByText('Title 5132')).toBeVisible();
    expect(within(core).getByText('Reason 5132.')).toBeVisible();
    expect(within(core).getByText('From your resume')).toBeVisible();
    expect(within(core).getByText('Confirmed')).toBeVisible();
    expect(within(core).queryByRole('button', { name: /^Confirm/ })).toBeNull();

    const similar = screen.getByRole('list', { name: 'Similar industries' });
    expect(within(similar).getByText('From your role targets')).toBeVisible();
    expect(within(similar).getByText('Not counted yet')).toBeVisible();
    expect(within(similar).getByRole('button', { name: 'Confirm Title 5222' })).toBeVisible();

    const adjacent = screen.getByRole('list', { name: 'Adjacent industries' });
    expect(within(adjacent).getByText('Added by you')).toBeVisible();
  });

  it('renders a reason as text, never as markup', async () => {
    mockApi({
      [`GET ${URL}`]: { items: [row({ code: '5132', reason: '<img src=x onerror=alert(1)>' })] },
    });
    const user = userEvent.setup();
    await openPanel(user);
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeVisible();
    expect(document.querySelector('img')).toBeNull();
  });

  it('says what Suggest industries sends, before it is pressed', async () => {
    mockApi({ [`GET ${URL}`]: { items: [] } });
    const user = userEvent.setup();
    await openPanel(user);
    const text = await screen.findByText(/sends your base resume/);
    expect(text).toHaveTextContent(/role targets/);
    expect(text).toHaveTextContent(/AI provider/);
    expect(text).toHaveTextContent(/discovery budget/);
    expect(text).toHaveTextContent(/Only the ones you confirm count/);
  });

  it('Suggest industries calls once, shows the new rows and says how many', async () => {
    let items: IndustryRow[] = [];
    const { calls } = mockApi({
      [`GET ${URL}`]: () => ({ items }),
      [`POST ${URL}/suggest`]: () => {
        items = [row({ code: '5132' }), row({ code: '5415' })];
        return { suggested: 2, items };
      },
    });
    const user = userEvent.setup();
    await openPanel(user);
    await user.click(await screen.findByRole('button', { name: 'Suggest industries' }));
    expect(await screen.findByText('Title 5132')).toBeVisible();
    expect(await screen.findByText('2 industries to review')).toBeInTheDocument();
    expect(calls.filter((c) => c.path === `${URL}/suggest`)).toHaveLength(1);
  });

  it('says so when an answer brought nothing new', async () => {
    mockApi({
      [`GET ${URL}`]: { items: [] },
      [`POST ${URL}/suggest`]: { suggested: 0, items: [] },
    });
    const user = userEvent.setup();
    await openPanel(user);
    await user.click(await screen.findByRole('button', { name: 'Suggest industries' }));
    expect(await screen.findByText('No new industries came back')).toBeInTheDocument();
  });

  it.each([
    ['no_key', /AI is not set up/],
    ['budget_exceeded', /discovery budget/],
    ['provider_error', /provider was unavailable/],
    ['invalid_output', /could not be used/],
  ])('when the call fails with %s it says why', async (reason, words) => {
    mockApi({
      [`GET ${URL}`]: { items: [] },
      [`POST ${URL}/suggest`]: () => ({
        status: 503,
        body: { error: { code: 'ai_unavailable', reason } },
      }),
    });
    const user = userEvent.setup();
    await openPanel(user);
    await user.click(await screen.findByRole('button', { name: 'Suggest industries' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(words);
  });

  it('with nothing to read it says what to add', async () => {
    mockApi({
      [`GET ${URL}`]: { items: [] },
      [`POST ${URL}/suggest`]: () => ({
        status: 422,
        body: { error: { code: 'no_profile_input' } },
      }),
    });
    const user = userEvent.setup();
    await openPanel(user);
    await user.click(await screen.findByRole('button', { name: 'Suggest industries' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/base resume or a role target/);
  });

  it('Confirm makes a row count', async () => {
    let items = [row({ code: '5132' })];
    const { calls } = mockApi({
      [`GET ${URL}`]: () => ({ items }),
      [`POST ${URL}/5132/confirm`]: () => {
        items = [row({ code: '5132', confirmed: true })];
        return items[0];
      },
    });
    const user = userEvent.setup();
    await openPanel(user);
    await user.click(await screen.findByRole('button', { name: 'Confirm Title 5132' }));
    expect(await screen.findByText('Confirmed')).toBeVisible();
    expect(calls.some((c) => c.method === 'POST' && c.path === `${URL}/5132/confirm`)).toBe(true);
    expect(screen.queryByRole('button', { name: 'Confirm Title 5132' })).toBeNull();
  });

  it('Remove takes a row away', async () => {
    let items = [row({ code: '5132', confirmed: true })];
    mockApi({
      [`GET ${URL}`]: () => ({ items }),
      [`DELETE ${URL}/5132`]: () => {
        items = [];
        return { status: 204 };
      },
    });
    const user = userEvent.setup();
    await openPanel(user);
    await user.click(await screen.findByRole('button', { name: 'Remove Title 5132' }));
    await waitFor(() => expect(screen.queryByText('Title 5132')).toBeNull());
  });

  it('Add offers the table, and sends the code and tier chosen', async () => {
    let items: IndustryRow[] = [];
    const { calls } = mockApi({
      [`GET ${URL}`]: () => ({ items }),
      [`POST ${URL}`]: () => {
        items = [
          row({
            code: '5132',
            title: 'Software Publishers',
            tier: 'adjacent',
            source: 'user',
            reason: null,
            confirmed: true,
          }),
        ];
        return items[0];
      },
    });
    const user = userEvent.setup();
    await openPanel(user);
    const picker = await screen.findByLabelText('Industry');
    expect((picker as HTMLSelectElement).options).toHaveLength(309); // The prompt, and the 308.
    await user.selectOptions(picker, '5132');
    await user.selectOptions(screen.getByLabelText('Tier'), 'adjacent');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await screen.findByRole('list', { name: 'Adjacent industries' });
    expect(calls.find((c) => c.method === 'POST' && c.path === URL)?.body).toEqual({
      code: '5132',
      tier: 'adjacent',
    });
  });

  it('does not offer a code already in the profile, and Add needs a choice', async () => {
    mockApi({ [`GET ${URL}`]: { items: [row({ code: '5132', title: 'Software Publishers' })] } });
    const user = userEvent.setup();
    await openPanel(user);
    await screen.findByText('Software Publishers');
    const picker = screen.getByLabelText('Industry') as HTMLSelectElement;
    expect(Array.from(picker.options).some((o) => o.value === '5132')).toBe(false);
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
  });

  it('a failure to load stays in the panel', async () => {
    mockApi({
      [`GET ${URL}`]: () => ({ status: 500, body: { error: { code: 'server_error' } } }),
    });
    const user = userEvent.setup();
    await openPanel(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(/server_error/);
  });
});
