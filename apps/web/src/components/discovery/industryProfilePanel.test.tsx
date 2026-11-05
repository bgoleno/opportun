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

  /** Presses Suggest industries against this answer, and returns what the panel says. */
  async function failureMessage(answer: unknown) {
    mockApi({ [`GET ${URL}`]: { items: [] }, [`POST ${URL}/suggest`]: answer });
    const user = userEvent.setup();
    await openPanel(user);
    await user.click(await screen.findByRole('button', { name: 'Suggest industries' }));
    const alert = await screen.findByRole('alert');
    // Never a code: no snake_case word, and not the fallback that prints one (#277).
    expect(alert.textContent).not.toMatch(/[a-z]+_[a-z]+|Request failed|Internal server error/);
    return alert;
  }

  const aiFailure = (body: Record<string, unknown>) => () => ({
    status: 503,
    body: { error: { code: 'ai_unavailable', ...body } },
  });

  it.each([
    ['no_key', /AI is not set up\. Add a key in Settings > AI/],
    ['budget_exceeded', /budget is spent.*next budget day.*discovery budget in Settings > AI/],
    ['provider_error', /provider was unavailable.*Try again later/],
    ['invalid_output', /answer could not be used.*Try again/],
    ['no_prompt', /prompt for this is missing.*updated/],
    ['something_new', /could not be made.*Try again later/],
  ])('when the call fails with %s it says what happened and what to do', async (reason, words) => {
    expect(await failureMessage(aiFailure({ reason }))).toHaveTextContent(words);
  });

  it('a rejected key says so and points to Settings > AI, and does not say to wait', async () => {
    const alert = await failureMessage(aiFailure({ reason: 'key_rejected' }));
    expect(alert).toHaveTextContent(/AI provider rejected your key/);
    expect(alert).toHaveTextContent(/Add a working key in Settings > AI/);
    expect(alert).not.toHaveTextContent(/later/);
  });

  it('a key that has expired says when, points to Settings > AI, and does not say to wait', async () => {
    const alert = await failureMessage(
      aiFailure({ reason: 'provider_error', keyHint: 'the stored key expired on 2026-05-01' }),
    );
    expect(alert).toHaveTextContent(/the stored key expired on 2026-05-01/);
    expect(alert).toHaveTextContent(/Add a working key in Settings > AI/);
    expect(alert).not.toHaveTextContent(/later/);
  });

  it.each([
    ['google_not_configured', /Connect your Google account in Settings > Integrations/],
    ['google_not_connected', /Connect your Google account in Settings > Integrations/],
    ['google_reauth_required', /Reconnect in Settings > Integrations/],
    ['reactive_resume_not_connected', /Connect Reactive Resume in Settings > Integrations/],
    ['not_found', /Check that it still opens under Resumes/],
    ['read_failed', /Check that it still opens under Resumes/],
    ['reactive_resume_error', /Check that it still opens under Resumes/],
  ])(
    'a base resume that cannot be read (%s) names it, and says what to do',
    async (reason, fix) => {
      const alert = await failureMessage(() => ({
        status: 409,
        body: { error: { code: 'resume_unreadable', reason, title: 'Sam Base CV' } },
      }));
      expect(alert).toHaveTextContent('Could not read your base resume, "Sam Base CV".');
      expect(alert).toHaveTextContent(fix);
    },
  );

  it('a server failure says so, without its wording', async () => {
    const alert = await failureMessage(() => ({
      status: 500,
      body: { error: { code: 'server_error', message: 'Internal server error' } },
    }));
    expect(alert).toHaveTextContent(/Something went wrong on the server/);
  });

  it('a session that has ended keeps its own plain words', async () => {
    const alert = await failureMessage(() => ({
      status: 401,
      body: { error: { code: 'unauthorized' } },
    }));
    expect(alert).toHaveTextContent('You are signed out.');
  });

  it('no answer at all says the server could not be reached', async () => {
    const alert = await failureMessage(() => {
      throw new TypeError('Failed to fetch');
    });
    expect(alert).toHaveTextContent(/Could not reach the server/);
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
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Add a base resume or a role target first/,
    );
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
