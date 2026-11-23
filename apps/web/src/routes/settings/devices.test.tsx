import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserCloses, pressEscapeOn } from '@/test/dialog';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import { DevicesCard, relativeTime } from './-devices';

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
const MIN = 60_000;
const TOKEN = `odt_${'A'.repeat(43)}`;
const PW = 'my current password';

interface Meta {
  id: string;
  name: string;
  scopes: string[];
  lastUsedAt: number | null;
  revokedAt: number | null;
  createdAt: number;
}

const LAPTOP: Meta = {
  id: 't1',
  name: 'MacBook connector',
  scopes: ['mail:push'],
  lastUsedAt: NOW - 5 * MIN,
  revokedAt: null,
  createdAt: NOW - 3 * 24 * 60 * MIN,
};
const OLD: Meta = {
  id: 't0',
  name: 'Old laptop',
  scopes: ['mail:push', 'capture:push'],
  lastUsedAt: null,
  revokedAt: NOW - 60 * MIN,
  createdAt: NOW - 30 * 24 * 60 * MIN,
};

const NOT_CONNECTED = {
  connected: false,
  lastSyncAt: null,
  status: null,
  count: 0,
  staleHint: null,
};
const STALE_HINT =
  'No mail from the connector in over 24 hours. Check that it is running on your Mac.';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('relativeTime', () => {
  it('reads like a person would say it', () => {
    expect(relativeTime(NOW - 10_000, NOW)).toBe('just now');
    expect(relativeTime(NOW - 5 * MIN, NOW)).toBe('5 minutes ago');
    expect(relativeTime(NOW - 2 * 60 * MIN, NOW)).toBe('2 hours ago');
    expect(relativeTime(NOW - 24 * 60 * MIN, NOW)).toBe('yesterday');
    expect(relativeTime(NOW - 3 * 24 * 60 * MIN, NOW)).toBe('3 days ago');
  });
});

describe('DevicesCard', () => {
  it('lists tokens with scopes, created, last used and revoked state', async () => {
    mockApi({
      'GET /device-tokens': { items: [LAPTOP, OLD] },
      'GET /integrations/apple-mail': NOT_CONNECTED,
    });
    renderWithProviders(<DevicesCard />);
    const list = await screen.findByRole('list', { name: 'Device tokens' });
    const laptop = within(list).getByRole('listitem', { name: 'MacBook connector' });
    expect(within(laptop).getByText('Apple Mail connector (mail:push)')).toBeInTheDocument();
    expect(within(laptop).getByText(/Created 3 days ago/)).toBeInTheDocument();
    expect(within(laptop).getByText(/Last used 5 minutes ago/)).toBeInTheDocument();
    expect(within(laptop).getByRole('button', { name: 'Revoke' })).toBeInTheDocument();

    const old = within(list).getByRole('listitem', { name: 'Old laptop' });
    expect(within(old).getByText('Revoked')).toBeInTheDocument();
    expect(within(old).getByText(/Never used/)).toBeInTheDocument();
    expect(within(old).getByText('Browser capture (capture:push)')).toBeInTheDocument();
    expect(within(old).queryByRole('button', { name: 'Revoke' })).toBeNull();
    // Nothing secret is ever listed.
    expect(document.body.textContent).not.toContain('odt_');
  });

  it('shows Apple Mail as not connected until the connector has pushed a batch', async () => {
    mockApi({
      'GET /device-tokens': { items: [] },
      'GET /integrations/apple-mail': NOT_CONNECTED,
    });
    renderWithProviders(<DevicesCard />);
    expect(await screen.findByText(/Apple Mail: not connected/)).toBeInTheDocument();
    expect(screen.getByText(/No device tokens yet/)).toBeInTheDocument();
  });

  it('shows Apple Mail as connected with the time of the last batch', async () => {
    mockApi({
      'GET /device-tokens': { items: [LAPTOP] },
      'GET /integrations/apple-mail': {
        connected: true,
        lastSyncAt: NOW - 2 * 60 * MIN,
        status: 'ok',
        count: 12,
        staleHint: null,
      },
    });
    renderWithProviders(<DevicesCard />);
    expect(
      await screen.findByText('Apple Mail: connected, last batch 2 hours ago (12 messages).'),
    ).toBeInTheDocument();
  });

  it('shows the server staleness hint under a connected line', async () => {
    mockApi({
      'GET /device-tokens': { items: [LAPTOP] },
      'GET /integrations/apple-mail': {
        connected: true,
        lastSyncAt: NOW - 3 * 24 * 60 * MIN,
        status: 'ok',
        count: 12,
        staleHint: STALE_HINT,
      },
    });
    renderWithProviders(<DevicesCard />);
    expect(await screen.findByText(/Apple Mail: connected, last batch 3 days ago/)).toBeVisible();
    expect(screen.getByText(STALE_HINT)).toBeVisible();
  });

  it('with mail history but no active Apple Mail token, says it is disconnected and when it last synced', async () => {
    mockApi({
      'GET /device-tokens': { items: [OLD] },
      'GET /integrations/apple-mail': {
        connected: false,
        lastSyncAt: NOW - 2 * 60 * MIN,
        status: 'ok',
        count: 12,
        staleHint: null,
      },
    });
    renderWithProviders(<DevicesCard />);
    expect(
      await screen.findByText(
        /Apple Mail: not connected \(no active token; last batch 2 hours ago\)/,
      ),
    ).toBeVisible();
    expect(screen.queryByText(/Apple Mail: connected/)).toBeNull();
  });

  it('creates a token with name, scopes and the current password, then shows it exactly once', async () => {
    const user = userEvent.setup();
    let items: Meta[] = [];
    const { calls } = mockApi({
      'GET /device-tokens': () => ({ items }),
      'GET /integrations/apple-mail': NOT_CONNECTED,
      'POST /device-tokens': (call: ApiCall) => {
        const body = call.body as { name: string; scopes: string[] };
        const meta = {
          ...LAPTOP,
          id: 't9',
          name: body.name,
          scopes: body.scopes,
          lastUsedAt: null,
        };
        items = [meta];
        return { status: 201, body: { ...meta, token: TOKEN } };
      },
    });
    renderWithProviders(<DevicesCard />);
    await user.click(await screen.findByRole('button', { name: 'Create token' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create a device token' });
    await user.type(within(dialog).getByLabelText('Name'), 'Work MacBook');
    // Apple Mail is preselected; add browser capture as well.
    expect(within(dialog).getByRole('checkbox', { name: /Apple Mail connector/ })).toBeChecked();
    await user.click(within(dialog).getByRole('checkbox', { name: /Browser capture/ }));
    await user.type(within(dialog).getByLabelText('Current password'), PW);
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.path === '/device-tokens')?.body).toEqual({
        name: 'Work MacBook',
        scopes: ['mail:push', 'capture:push'],
        password: PW,
      }),
    );
    const shown = await screen.findByRole('dialog', { name: 'Copy your device token' });
    expect(within(shown).getByLabelText('Device token')).toHaveValue(TOKEN);
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: write },
      configurable: true,
    });
    await user.click(within(shown).getByRole('button', { name: 'Copy token' }));
    expect(write).toHaveBeenCalledWith(TOKEN);
    // Neither Escape nor a close the browser makes on its own dismisses it (#898): closing is only
    // through the explicit confirmation.
    pressEscapeOn(shown);
    expect(screen.getByRole('dialog', { name: 'Copy your device token' })).toBe(shown);
    browserCloses(shown);
    expect(screen.getByRole('dialog', { name: 'Copy your device token' })).toBe(shown);
    expect(within(shown).getByLabelText('Device token')).toHaveValue(TOKEN);
    await user.click(within(shown).getByRole('button', { name: 'I saved it' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Copy your device token' })).toBeNull(),
    );
    expect(
      await within(screen.getByRole('list', { name: 'Device tokens' })).findByRole('listitem', {
        name: 'Work MacBook',
      }),
    ).toBeInTheDocument();
    // Gone for good: the plaintext is nowhere on the page any more.
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  // https://github.com/bgoleno/opportun/issues/898: after an Escape on the first token's dialog, the
  // next token was created and its dialog never showed.
  it("shows the next token too, whatever was tried on the first one's dialog", async () => {
    const user = userEvent.setup();
    let made = 0;
    mockApi({
      'GET /device-tokens': { items: [] },
      'GET /integrations/apple-mail': NOT_CONNECTED,
      'POST /device-tokens': () => {
        made += 1;
        return { status: 201, body: { ...LAPTOP, id: `t${made}`, token: `odt_${made}` } };
      },
    });
    renderWithProviders(<DevicesCard />);
    const create = async () => {
      await user.click(await screen.findByRole('button', { name: 'Create token' }));
      const dialog = await screen.findByRole('dialog', { name: 'Create a device token' });
      await user.type(within(dialog).getByLabelText('Name'), 'Mac');
      await user.type(within(dialog).getByLabelText('Current password'), PW);
      await user.click(within(dialog).getByRole('button', { name: 'Create' }));
      return screen.findByRole('dialog', { name: 'Copy your device token' });
    };
    const first = await create();
    expect(within(first).getByLabelText('Device token')).toHaveValue('odt_1');
    pressEscapeOn(first);
    browserCloses(first);
    await user.click(within(first).getByRole('button', { name: 'I saved it' }));

    const second = await create();
    expect(second).toBeVisible();
    expect(within(second).getByLabelText('Device token')).toHaveValue('odt_2');
  });

  // https://github.com/bgoleno/opportun/issues/904: the server made the token and its answer never
  // came, so nobody has seen the token's value, and the list did not show it to be revoked.
  describe('a create whose answer is lost', () => {
    const MADE: Meta = { ...LAPTOP, id: 't9', name: 'Work MacBook', lastUsedAt: null };
    const SAYS =
      'Could not confirm that "Work MacBook" was created. If it was, its value can no longer be shown: revoke what the list marks "Not shown here", and create another.';
    const FOUND =
      'A token named "Work MacBook" was created since then, and its value was not shown here. Unless you have it, revoke what the list marks "Not shown here" and create another.';
    /** Once a create of that name has been answered: there is no other to create. */
    const answered = (text: string) => text.replace(/,? and create another\.$/, '.');
    const FOUND_AFTER = answered(FOUND);
    /** The list was not read before the create, so nothing in it can be told to be the lost one. */
    const UNKNOWN =
      'Could not confirm that "Work MacBook" was created. If the list has one by that name whose value you do not have, it can no longer be shown: revoke it, and create another.';
    const MARK = 'Not shown here';
    const drop = (): never => {
      throw new TypeError('Failed to fetch');
    };
    const FAILURES: [string, () => unknown][] = [
      ['the connection drops', drop],
      ['a proxy answers for the server', () => ({ status: 502 })],
      ["a proxy's own refusal, which the server never gave", () => ({ status: 408 })],
      [
        'the server answers with an error after',
        () => ({ status: 500, body: { error: { code: 'internal' } } }),
      ],
      ['the answer has no token in it', () => ({ status: 201, body: {} })],
      ['the answer is empty', () => ({ status: 201 })],
      // It opened the dialog that shows a token with nothing in it (qa on #918).
      ['the token in the answer is empty', () => ({ status: 201, body: { ...MADE, token: '' } })],
    ];

    /** Opens Create, fills it in and presses Create; the server makes the token, then `answer`s. */
    async function create(answer: () => unknown, made = true) {
      const user = userEvent.setup();
      let items: Meta[] = [];
      const { calls } = mockApi({
        'GET /device-tokens': () => ({ items }),
        'GET /integrations/apple-mail': NOT_CONNECTED,
        'POST /device-tokens': () => {
          if (made) items = [MADE];
          return answer();
        },
        'DELETE /device-tokens/t9': () => {
          items = [{ ...MADE, revokedAt: NOW }];
          return { status: 204 };
        },
      });
      renderWithProviders(<DevicesCard />);
      await user.click(await screen.findByRole('button', { name: 'Create token' }));
      const dialog = await screen.findByRole('dialog', { name: 'Create a device token' });
      await user.type(within(dialog).getByLabelText('Name'), 'Work MacBook');
      await user.type(within(dialog).getByLabelText('Current password'), PW);
      await user.click(within(dialog).getByRole('button', { name: 'Create' }));
      return { user, dialog, calls };
    }

    it.each(FAILURES)(
      '%s: it is listed, the page says so, and it can be revoked',
      async (_w, answer) => {
        const { user, dialog } = await create(answer);
        expect(await within(dialog).findByRole('alert')).toHaveTextContent(SAYS);
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        // Still said on the page, with the token in the list and marked, and no token shown.
        const row = await screen.findByRole('listitem', { name: 'Work MacBook' });
        expect(await within(row).findByText(MARK)).toBeInTheDocument();
        expect(screen.getByRole('alert')).toHaveTextContent(FOUND);
        expect(screen.queryByRole('dialog', { name: 'Copy your device token' })).toBeNull();

        await user.click(within(row).getByRole('button', { name: 'Revoke' }));
        const sure = await screen.findByRole('dialog', { name: 'Revoke Work MacBook?' });
        await user.click(within(sure).getByRole('button', { name: 'Revoke' }));
        await waitFor(() => expect(screen.getByText('Revoked')).toBeInTheDocument());
        // Revoked, so there is nothing left to say.
        await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
        expect(screen.queryByText(MARK)).toBeNull();
      },
    );

    it('closed while it was in flight: the page says so, and the next create starts clean', async () => {
      let fail!: () => void;
      const { user, dialog } = await create(
        () =>
          new Promise((_, reject) => {
            fail = () => reject(new TypeError('Failed to fetch'));
          }),
      );
      await within(dialog).findByRole('button', { name: 'Creating...' });
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      fail();
      expect(await screen.findByRole('alert')).toBeInTheDocument();
      expect(await screen.findByRole('listitem', { name: 'Work MacBook' })).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(FOUND));
      await user.click(screen.getByRole('button', { name: 'Create token' }));
      const again = await screen.findByRole('dialog', { name: 'Create a device token' });
      expect(within(again).queryByRole('alert')).toBeNull();
    });

    const fill = async (user: ReturnType<typeof userEvent.setup>, name = 'Work MacBook') => {
      await user.click(await screen.findByRole('button', { name: 'Create token' }));
      const dialog = await screen.findByRole('dialog', { name: 'Create a device token' });
      const field = within(dialog).getByLabelText('Name');
      await user.clear(field);
      await user.type(field, name);
      const password = within(dialog).getByLabelText('Current password');
      await user.clear(password);
      await user.type(password, PW);
      return dialog;
    };
    const pressCreate = (user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) =>
      user.click(within(dialog).getByRole('button', { name: 'Create' }));
    const rowsNamed = (name = 'Work MacBook') => screen.findAllByRole('listitem', { name });
    const revokeRow = async (user: ReturnType<typeof userEvent.setup>, row: HTMLElement) => {
      const name = row.getAttribute('aria-label')!;
      await user.click(within(row).getByRole('button', { name: 'Revoke' }));
      const sure = await screen.findByRole('dialog', { name: `Revoke ${name}?` });
      await user.click(within(sure).getByRole('button', { name: 'Revoke' }));
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: `Revoke ${name}?` })).toBeNull(),
      );
    };
    /** A server whose creates each make a token or not, and answer or not, as `plan` says. */
    function server(
      plan: ('made and lost' | 'lost' | 'answered')[],
      start: Meta[] = [],
      more: Record<string, unknown> = {},
    ) {
      const state = { items: start };
      const made: Meta[] = [];
      let n = 0;
      const revokes = Object.fromEntries(
        ['g0', 'g1', 'g2', 'g3', ...start.map((t) => t.id)].map((id) => [
          `DELETE /device-tokens/${id}`,
          () => {
            state.items = state.items.map((t) => (t.id === id ? { ...t, revokedAt: NOW } : t));
            return { status: 204 };
          },
        ]),
      );
      const { calls } = mockApi({
        'GET /device-tokens': () => ({ items: state.items }),
        'GET /integrations/apple-mail': NOT_CONNECTED,
        'POST /device-tokens': (call: ApiCall) => {
          const what = plan[n];
          const token = { ...MADE, id: `g${n}`, name: (call.body as { name: string }).name };
          n += 1;
          if (what !== 'lost') {
            state.items = [token, ...state.items];
            made.push(token);
          }
          if (what !== 'answered') return drop();
          return { status: 201, body: { ...token, token: `odt_${token.id}` } };
        },
        ...revokes,
        ...more,
      });
      return { state, calls };
    }
    const saved = async (user: ReturnType<typeof userEvent.setup>) => {
      const shown = await screen.findByRole('dialog', { name: 'Copy your device token' });
      await user.click(within(shown).getByRole('button', { name: 'I saved it' }));
    };
    const marked = () => screen.queryAllByText(MARK).map((m) => m.closest('li[aria-label]'));

    // tl on #918: pressing Create again in the same dialog is the natural next step.
    it('a retry that works, when the first was never made: nothing is left to say', async () => {
      const user = userEvent.setup();
      server(['lost', 'answered']);
      renderWithProviders(<DevicesCard />);
      const dialog = await fill(user);
      await pressCreate(user, dialog);
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(SAYS);
      await pressCreate(user, dialog);
      await saved(user);
      expect(await rowsNamed()).toHaveLength(1);
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
      expect(marked()).toEqual([]);
    });

    it('a retry that works, when the first was made: the page says which one to revoke', async () => {
      const user = userEvent.setup();
      server(['made and lost', 'answered']);
      renderWithProviders(<DevicesCard />);
      const dialog = await fill(user);
      await pressCreate(user, dialog);
      await within(dialog).findByRole('alert');
      await pressCreate(user, dialog);
      await saved(user);
      await waitFor(async () => expect(await rowsNamed()).toHaveLength(2));
      // The newest first: the good one, shown just now, then the lost one.
      const [good, lost] = await rowsNamed();
      await waitFor(() => expect(marked()).toEqual([lost]));
      expect(screen.getByRole('alert')).toHaveTextContent(FOUND_AFTER);
      expect(screen.getByRole('alert')).not.toHaveTextContent('create another');
      await revokeRow(user, lost!);
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
      expect(marked()).toEqual([]);
      expect(within(good!).getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
    });

    it('two lost in a row and then one that works: both lost ones are marked, the good one never', async () => {
      const user = userEvent.setup();
      server(['made and lost', 'made and lost', 'answered']);
      renderWithProviders(<DevicesCard />);
      const dialog = await fill(user);
      await pressCreate(user, dialog);
      await within(dialog).findByRole('alert');
      // The list now holds the first lost one, so the second's own list is no baseline.
      await waitFor(async () =>
        expect(
          await screen.findAllByRole('listitem', { name: 'Work MacBook', hidden: true }),
        ).toHaveLength(1),
      );
      await pressCreate(user, dialog);
      await waitFor(async () =>
        expect(
          await screen.findAllByRole('listitem', { name: 'Work MacBook', hidden: true }),
        ).toHaveLength(2),
      );
      await pressCreate(user, dialog);
      await saved(user);
      await waitFor(async () => expect(await rowsNamed()).toHaveLength(3));
      const [, second, first] = await rowsNamed();
      await waitFor(() => expect(marked()).toEqual([second, first]));
      await revokeRow(user, first!);
      expect(screen.getByRole('alert')).toHaveTextContent(FOUND_AFTER);
      await revokeRow(user, (await rowsNamed())[1]!);
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    });

    it('one shown before the list was read again is never marked', async () => {
      const user = userEvent.setup();
      let reads = 0;
      server(['answered', 'made and lost'], [], {
        // The list as it was before the first create, until the second has failed.
        'GET /device-tokens': () => {
          reads += 1;
          return {
            items:
              reads <= 2
                ? []
                : [
                    { ...MADE, id: 'g1' },
                    { ...MADE, id: 'g0' },
                  ],
          };
        },
      });
      renderWithProviders(<DevicesCard />);
      const dialog = await fill(user);
      await pressCreate(user, dialog);
      await saved(user);
      const again = await fill(user);
      await pressCreate(user, again);
      await within(again).findByRole('alert');
      await user.click(within(again).getByRole('button', { name: 'Cancel' }));
      await waitFor(async () => expect(await rowsNamed()).toHaveLength(2));
      const [lost] = await rowsNamed();
      expect(marked()).toEqual([lost]);
    });

    // The extension setup names every token after the browser and the person.
    it('one of that name from before is never marked, and revoking it changes nothing', async () => {
      const user = userEvent.setup();
      const older = { ...MADE, id: 't8', lastUsedAt: NOW - 5 * MIN };
      const { state } = server(['lost'], [older, { ...LAPTOP, id: 't7' }]);
      renderWithProviders(<DevicesCard />);
      await screen.findByRole('listitem', { name: 'Work MacBook' });
      const dialog = await fill(user);
      await pressCreate(user, dialog);
      await within(dialog).findByRole('alert');
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(marked()).toEqual([]);
      expect(screen.getByRole('alert')).toHaveTextContent(SAYS);
      // The server got to it late: it is in the list the next time that is read.
      state.items = [MADE, ...state.items];
      await revokeRow(user, await screen.findByRole('listitem', { name: 'MacBook connector' }));
      await waitFor(async () => expect(await rowsNamed()).toHaveLength(2));
      const [lost, old] = await rowsNamed();
      expect(marked()).toEqual([lost]);
      await revokeRow(user, old!);
      expect(marked()).toHaveLength(1);
      expect(screen.getByRole('alert')).toHaveTextContent(FOUND);
    });

    it('revoking another one leaves it said, when nothing of it is in the list yet', async () => {
      const user = userEvent.setup();
      server(['lost'], [{ ...LAPTOP, id: 't7' }]);
      renderWithProviders(<DevicesCard />);
      const dialog = await fill(user);
      await pressCreate(user, dialog);
      await within(dialog).findByRole('alert');
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await revokeRow(user, await screen.findByRole('listitem', { name: 'MacBook connector' }));
      await screen.findByText('Revoked');
      expect(screen.getByRole('alert')).toHaveTextContent(SAYS);
    });

    it('two lost ones of different names are both said, and a retry settles only its own', async () => {
      const user = userEvent.setup();
      server(['made and lost', 'lost', 'answered']);
      renderWithProviders(<DevicesCard />);
      const dialog = await fill(user);
      await pressCreate(user, dialog);
      await within(dialog).findByRole('alert');
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      const second = await fill(user, 'Phone');
      await pressCreate(user, second);
      await within(second).findByRole('alert');
      await pressCreate(user, second);
      await saved(user);
      await rowsNamed('Phone');
      await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1));
      expect(screen.getByRole('alert')).toHaveTextContent(FOUND);
    });

    it('a list that could not be read again after the retry keeps it said', async () => {
      const user = userEvent.setup();
      let fail = false;
      const { state } = server(['lost', 'answered'], [], {
        'GET /device-tokens': () => (fail ? { status: 500 } : { items: state.items }),
      });
      renderWithProviders(<DevicesCard />);
      const dialog = await fill(user);
      await pressCreate(user, dialog);
      await within(dialog).findByRole('alert');
      fail = true;
      await pressCreate(user, dialog);
      await saved(user);
      await screen.findByText('Request failed (http_500).');
      expect(screen.getAllByRole('alert').map((x) => x.textContent)).toContain(answered(SAYS));
    });

    // tl on #918: a list that was not read is not an empty one.
    describe('when the list was not read before the create', () => {
      const OLDER = { ...MADE, id: 't8' };
      it.each(['failed', 'unfinished'] as const)(
        'its read %s: nothing is marked, and no token is named',
        async (how) => {
          const user = userEvent.setup();
          let read = false;
          const { state } = server(['made and lost'], [{ ...OLDER, lastUsedAt: NOW - MIN }], {
            'GET /device-tokens': () => {
              if (read) return { items: state.items };
              return how === 'failed' ? { status: 500 } : new Promise(() => undefined);
            },
          });
          renderWithProviders(<DevicesCard />);
          if (how === 'failed') await screen.findByText('Request failed (http_500).');
          const dialog = await fill(user);
          read = true;
          await pressCreate(user, dialog);
          // Said so in the dialog too, whose sentence is set as the create fails.
          expect(await within(dialog).findByRole('alert')).toHaveTextContent(UNKNOWN);
          await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
          await waitFor(async () => expect(await rowsNamed()).toHaveLength(2));
          expect(marked()).toEqual([]);
          expect(screen.getByRole('alert')).toHaveTextContent(UNKNOWN);
          expect(screen.getByRole('alert')).not.toHaveTextContent(MARK);
        },
      );

      it('it was read once, and its last read failed', async () => {
        const user = userEvent.setup();
        let fail = false;
        const { state } = server(['lost', 'made and lost'], [OLDER], {
          'GET /device-tokens': () => (fail ? { status: 500 } : { items: state.items }),
        });
        const { queryClient } = renderWithProviders(<DevicesCard />);
        await rowsNamed();
        fail = true;
        await act(() => queryClient.invalidateQueries({ queryKey: ['device-tokens'] }));
        await screen.findByText('Request failed (http_500).');
        fail = false;
        const dialog = await fill(user);
        await pressCreate(user, dialog);
        expect(await within(dialog).findByRole('alert')).toHaveTextContent(UNKNOWN);
      });

      it('a list being read again counts as read, when its last finished read worked', async () => {
        const user = userEvent.setup();
        let hold = false;
        let go: () => void = () => undefined;
        const { state } = server(['made and lost'], [OLDER], {
          'GET /device-tokens': () => {
            if (!hold) return { items: state.items };
            hold = false;
            return new Promise((resolve) => {
              go = () => resolve({ items: state.items });
            });
          },
        });
        const { queryClient } = renderWithProviders(<DevicesCard />);
        await rowsNamed();
        hold = true;
        act(() => void queryClient.invalidateQueries({ queryKey: ['device-tokens'] }));
        const dialog = await fill(user);
        await pressCreate(user, dialog);
        expect(await within(dialog).findByRole('alert')).toHaveTextContent(SAYS);
        go();
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        await waitFor(async () => expect(await rowsNamed()).toHaveLength(2));
        const [lost] = await rowsNamed();
        await waitFor(() => expect(marked()).toEqual([lost]));
      });

      it('it stays so through a second lost create, in the dialog too', async () => {
        const user = userEvent.setup();
        let read = false;
        const { state } = server(['lost', 'made and lost'], [OLDER], {
          'GET /device-tokens': () => (read ? { items: state.items } : { status: 500 }),
        });
        renderWithProviders(<DevicesCard />);
        await screen.findByText('Request failed (http_500).');
        const dialog = await fill(user);
        read = true;
        await pressCreate(user, dialog);
        await within(dialog).findByRole('alert');
        await screen.findAllByRole('listitem', { name: 'Work MacBook', hidden: true });
        await pressCreate(user, dialog);
        await waitFor(async () =>
          expect(
            await screen.findAllByRole('listitem', { name: 'Work MacBook', hidden: true }),
          ).toHaveLength(2),
        );
        expect(within(dialog).getByRole('alert')).toHaveTextContent(UNKNOWN);
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        expect(marked()).toEqual([]);
        expect(screen.getByRole('alert')).toHaveTextContent(UNKNOWN);
      });

      it.each<[string, Meta[], boolean]>([
        ['none of that name', [], false],
        ['one that has been used', [{ ...OLDER, lastUsedAt: NOW - MIN }], false],
        ['an old one never used, which might be it', [OLDER], true],
      ])('after a retry that works, with %s in the list', async (_w, start, said) => {
        const user = userEvent.setup();
        let read = false;
        const { state } = server(['lost', 'answered'], start, {
          'GET /device-tokens': () => (read ? { items: state.items } : { status: 500 }),
        });
        renderWithProviders(<DevicesCard />);
        await screen.findByText('Request failed (http_500).');
        const dialog = await fill(user);
        read = true;
        await pressCreate(user, dialog);
        await within(dialog).findByRole('alert');
        await pressCreate(user, dialog);
        await saved(user);
        await waitFor(async () => expect(await rowsNamed()).toHaveLength(1 + start.length));
        await waitFor(() =>
          expect(screen.queryAllByRole('alert').map((x) => x.textContent)).toEqual(
            said ? [answered(UNKNOWN)] : [],
          ),
        );
        expect(marked()).toEqual([]);
        if (said) await user.click(screen.getByRole('button', { name: 'Dismiss' }));
        await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
      });
    });

    it('one that has been used is not marked, and loses its mark when it is', async () => {
      const user = userEvent.setup();
      const { state } = server(['made and lost']);
      const { queryClient } = renderWithProviders(<DevicesCard />);
      await screen.findByText('No device tokens yet.');
      const dialog = await fill(user);
      await pressCreate(user, dialog);
      await within(dialog).findByRole('alert');
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(marked()).toHaveLength(1));
      // Somebody has its value, so it is not the lost one.
      state.items = state.items.map((t) => ({ ...t, lastUsedAt: NOW }));
      await act(() => queryClient.invalidateQueries({ queryKey: ['device-tokens'] }));
      await waitFor(() => expect(marked()).toEqual([]));
      expect(screen.getByRole('alert')).toHaveTextContent(SAYS);
    });

    it.each(['Cancel', 'Dismiss'])(
      '%s reads the list again, for one the server made late',
      async (how) => {
        const user = userEvent.setup();
        const { state } = server(['lost']);
        renderWithProviders(<DevicesCard />);
        const dialog = await fill(user);
        await pressCreate(user, dialog);
        await within(dialog).findByRole('alert');
        if (how === 'Dismiss') {
          await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
          await screen.findByRole('alert');
          await new Promise((r) => setTimeout(r, 0));
        }
        state.items = [MADE];
        await user.click(
          how === 'Cancel'
            ? within(dialog).getByRole('button', { name: 'Cancel' })
            : screen.getByRole('button', { name: 'Dismiss' }),
        );
        expect(await screen.findByRole('listitem', { name: 'Work MacBook' })).toBeInTheDocument();
        expect(marked()).toHaveLength(how === 'Cancel' ? 1 : 0);
      },
    );

    it('can be put away when the token was never made', async () => {
      const { user, dialog } = await create(drop, false);
      await within(dialog).findByRole('alert');
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await user.click(screen.getByRole('button', { name: 'Dismiss' }));
      expect(screen.queryByText(SAYS)).toBeNull();
      expect(screen.getByText('No device tokens yet.')).toBeInTheDocument();
    });

    it.each<[string, number, string, string]>([
      ['a wrong password', 403, 'invalid_password', 'That is not your current password.'],
      ['too many tokens', 409, 'too_many_tokens', 'Request failed (too_many_tokens).'],
    ])(
      'a refusal (%s) is said as before, and the list is read again',
      async (_w, status, code, says) => {
        const { user, dialog, calls } = await create(
          () => ({ status, body: { error: { code } } }),
          false,
        );
        expect(await within(dialog).findByRole('alert')).toHaveTextContent(says);
        const reads = () => calls.filter((c) => c.method === 'GET' && c.path === '/device-tokens');
        await waitFor(() => expect(reads()).toHaveLength(2));
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByRole('alert')).toBeNull();
        expect(screen.queryByText(/Could not confirm/)).toBeNull();
      },
    );

    describe('of the extension setup', () => {
      // The browser of its target, and whom the page says you are.
      const NAME = 'Chrome · this browser';
      const named = (text: string) => text.replace('Work MacBook', NAME);
      const SETUP = {
        'GET /auth/2fa': { enabled: false, recoveryCodesLeft: 0, hasPassword: true },
        'GET /artifacts/extension': {
          baseUrl: 'http://nas.local:8080',
          buildCommand: 'pnpm build',
          targets: [
            {
              id: 'chrome',
              label: 'Chrome, Edge, Brave',
              filename: 'opportun-chrome.zip',
              available: true,
              buildStamp: null,
            },
          ],
        },
      };
      async function lose(plan: Parameters<typeof server>[0], start: Meta[] = []) {
        const user = userEvent.setup();
        server(plan, start, SETUP);
        renderWithProviders(<DevicesCard />);
        for (const t of start) await screen.findByRole('listitem', { name: t.name });
        await user.click(await screen.findByRole('button', { name: 'Set up' }));
        const setup = await screen.findByRole('dialog', { name: 'Set up the browser extension' });
        await user.type(await within(setup).findByLabelText('Password'), PW);
        await user.click(within(setup).getByRole('button', { name: 'Continue' }));
        expect(await within(setup).findByRole('alert')).toHaveTextContent(named(SAYS));
        return { user, setup };
      }

      it('a list that was not read: no token is named, in it or on the page', async () => {
        const user = userEvent.setup();
        let read = false;
        const older = { ...MADE, id: 't8', name: NAME };
        const { state } = server(['lost'], [older], {
          ...SETUP,
          'GET /device-tokens': () => (read ? { items: state.items } : { status: 500 }),
        });
        renderWithProviders(<DevicesCard />);
        await screen.findByText('Request failed (http_500).');
        await user.click(screen.getByRole('button', { name: 'Set up' }));
        const setup = await screen.findByRole('dialog', { name: 'Set up the browser extension' });
        await user.type(await within(setup).findByLabelText('Password'), PW);
        read = true;
        await user.click(within(setup).getByRole('button', { name: 'Continue' }));
        expect(await within(setup).findByRole('alert')).toHaveTextContent(named(UNKNOWN));
        await user.click(within(setup).getByRole('button', { name: 'Close' }));
        await rowsNamed(NAME);
        expect(marked()).toEqual([]);
        expect(screen.getByRole('alert')).toHaveTextContent(named(UNKNOWN));
      });

      it('one of that name from before is not marked', async () => {
        const older = { ...MADE, id: 't8', name: NAME, lastUsedAt: NOW - 5 * MIN };
        const { user, setup } = await lose(['made and lost'], [older]);
        await user.click(within(setup).getByRole('button', { name: 'Close' }));
        await waitFor(async () => expect(await rowsNamed(NAME)).toHaveLength(2));
        const [lost] = await rowsNamed(NAME);
        await waitFor(() => expect(marked()).toEqual([lost]));
      });

      it('said in it and on the page, listed and marked', async () => {
        const { user, setup } = await lose(['made and lost']);
        await user.click(within(setup).getByRole('button', { name: 'Close' }));
        const row = await screen.findByRole('listitem', { name: NAME });
        expect(await within(row).findByText(MARK)).toBeInTheDocument();
        expect(screen.getByRole('alert')).toHaveTextContent(named(FOUND));
      });

      it.each<['lost' | 'made and lost', number]>([
        ['lost', 0],
        ['made and lost', 1],
      ])(
        'Continue again, when the first was %s: %i marked, and never the good one',
        async (first, n) => {
          const { user, setup } = await lose([first, 'answered']);
          await user.click(within(setup).getByRole('button', { name: 'Continue' }));
          expect(await within(setup).findByText('odt_g1')).toBeInTheDocument();
          await user.click(within(setup).getByRole('button', { name: 'Close setup' }));
          await user.click(await screen.findByRole('button', { name: 'Close anyway' }));
          await waitFor(async () => expect(await rowsNamed(NAME)).toHaveLength(1 + n));
          const [, lost] = await rowsNamed(NAME);
          await waitFor(() => expect(marked()).toEqual(n === 0 ? [] : [lost]));
          expect(screen.queryAllByRole('alert').map((x) => x.textContent)).toEqual(
            n === 0 ? [] : [named(FOUND_AFTER)],
          );
        },
      );
    });
  });

  it('validates the dialog: a name, at least one scope and the password are required', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /device-tokens': { items: [] },
      'GET /integrations/apple-mail': NOT_CONNECTED,
    });
    renderWithProviders(<DevicesCard />);
    await user.click(await screen.findByRole('button', { name: 'Create token' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create a device token' });
    await user.click(within(dialog).getByRole('checkbox', { name: /Apple Mail connector/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(within(dialog).getByText('Give the token a name.')).toBeInTheDocument();
    expect(within(dialog).getByText('Pick at least one permission.')).toBeInTheDocument();
    expect(within(dialog).getByText('Enter your current password.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('a wrong current password keeps the dialog open with an error and shows no token', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /device-tokens': { items: [] },
      'GET /integrations/apple-mail': NOT_CONNECTED,
      'POST /device-tokens': () => ({ status: 403, body: { error: { code: 'invalid_password' } } }),
    });
    renderWithProviders(<DevicesCard />);
    await user.click(await screen.findByRole('button', { name: 'Create token' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create a device token' });
    await user.type(within(dialog).getByLabelText('Name'), 'Work MacBook');
    await user.type(within(dialog).getByLabelText('Current password'), 'wrong');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByText('That is not your current password.')).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Copy your device token' })).toBeNull();
  });

  // https://github.com/bgoleno/opportun/issues/743: a password changed mid-check (#643) is said in
  // plain words, from the server's sentence or, should a body ever arrive without it, the client's.
  it.each([
    [
      'with the server sentence',
      {
        code: 'password_changed',
        message:
          'Your password changed while this was being checked. Sign in again and try once more.',
      },
    ],
    ['with the code alone', { code: 'password_changed' }],
  ])('a password changed during the check says so, %s', async (_how, error) => {
    const user = userEvent.setup();
    mockApi({
      'GET /device-tokens': { items: [] },
      'GET /integrations/apple-mail': NOT_CONNECTED,
      'POST /device-tokens': () => ({ status: 403, body: { error } }),
    });
    renderWithProviders(<DevicesCard />);
    await user.click(await screen.findByRole('button', { name: 'Create token' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create a device token' });
    await user.type(within(dialog).getByLabelText('Name'), 'Work MacBook');
    await user.type(within(dialog).getByLabelText('Current password'), 'correct');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(
      await within(dialog).findByText(
        'Your password changed while this was being checked. Sign in again and try once more.',
      ),
    ).toBeVisible();
    expect(within(dialog).queryByText(/Request failed/)).toBeNull();
  });

  it('revokes a token only after confirmation', async () => {
    const user = userEvent.setup();
    let items: Meta[] = [LAPTOP];
    const { calls } = mockApi({
      'GET /device-tokens': () => ({ items }),
      'GET /integrations/apple-mail': NOT_CONNECTED,
      'DELETE /device-tokens/t1': () => {
        items = [{ ...LAPTOP, revokedAt: NOW }];
        return { status: 204 };
      },
    });
    renderWithProviders(<DevicesCard />);
    const row = await screen.findByRole('listitem', { name: 'MacBook connector' });
    await user.click(within(row).getByRole('button', { name: 'Revoke' }));
    const confirm = await screen.findByRole('dialog', { name: 'Revoke MacBook connector?' });
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);

    await user.click(within(row).getByRole('button', { name: 'Revoke' }));
    const again = await screen.findByRole('dialog', { name: 'Revoke MacBook connector?' });
    await user.click(within(again).getByRole('button', { name: 'Revoke' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([
        '/device-tokens/t1',
      ]),
    );
    expect(await within(row).findByText('Revoked')).toBeInTheDocument();
    // Revoking can disconnect Apple Mail, so its status is fetched again.
    await waitFor(() =>
      expect(calls.filter((c) => c.path === '/integrations/apple-mail').length).toBe(2),
    );
  });

  describe('browser extension row (design D15, D23)', () => {
    it('says so before anyone mints a token when the server has no download', async () => {
      mockApi({
        'GET /device-tokens': { items: [] },
        'GET /integrations/apple-mail': NOT_CONNECTED,
        'GET /artifacts/extension': {
          baseUrl: 'http://localhost:8080',
          buildCommand: 'pnpm --filter @opportun/extension build',
          targets: [
            {
              id: 'chrome',
              label: 'Chrome, Edge, Brave',
              filename: 'c.zip',
              available: false,
              buildStamp: null,
            },
            {
              id: 'firefox',
              label: 'Firefox',
              filename: 'f.zip',
              available: false,
              buildStamp: null,
            },
          ],
        },
      });
      renderWithProviders(<DevicesCard />);
      // D15: the card says it, rather than the user discovering it after confirming a password
      // and holding a token they now have to store or revoke.
      expect(
        await screen.findByText(/pnpm --filter @opportun\/extension build/),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /set up/i })).toBeDisabled();
    });

    const row = () => screen.getByRole('listitem', { name: /browser extension/i });

    it('reads as not set up without a capture token', async () => {
      mockApi({
        'GET /device-tokens': { items: [LAPTOP] },
        'GET /integrations/apple-mail': NOT_CONNECTED,
      });
      renderWithProviders(<DevicesCard />);
      expect(await screen.findByRole('listitem', { name: /browser extension/i })).toHaveTextContent(
        /not set up/i,
      );
    });

    it('reads as waiting while an unused capture token exists', async () => {
      const unused = {
        ...LAPTOP,
        id: 'c1',
        name: 'Chrome',
        scopes: ['capture:push'],
        lastUsedAt: null,
      };
      mockApi({
        'GET /device-tokens': { items: [unused] },
        'GET /integrations/apple-mail': NOT_CONNECTED,
      });
      renderWithProviders(<DevicesCard />);
      // The row renders before the token list arrives, so wait for the text the data decides.
      expect(await screen.findByText(/waiting for its first capture/i)).toBeInTheDocument();
    });

    it('reads as set up once a capture token has been used, and stays addable', async () => {
      const used = { ...LAPTOP, id: 'c1', name: 'Chrome', scopes: ['capture:push'] };
      mockApi({
        'GET /device-tokens': { items: [used] },
        'GET /integrations/apple-mail': NOT_CONNECTED,
      });
      renderWithProviders(<DevicesCard />);
      expect(await screen.findByText(/last capture/i)).toBeInTheDocument();
      // A second browser is a normal thing to add, so Set up never disappears.
      expect(within(row()).getByRole('button', { name: /set up/i })).toBeInTheDocument();
    });

    it('ignores a revoked capture token', async () => {
      mockApi({
        'GET /device-tokens': { items: [OLD] },
        'GET /integrations/apple-mail': NOT_CONNECTED,
      });
      renderWithProviders(<DevicesCard />);
      // Wait for the list to arrive, then confirm the revoked token changed nothing.
      await screen.findByRole('listitem', { name: 'Old laptop' });
      expect(row()).toHaveTextContent(/not set up/i);
    });
  });
});

// https://github.com/bgoleno/opportun/issues/182: the assisted apply permission, alone and with
// its plain wording, only where the feature exists (sec: least privilege for any other client).
describe('DevicesCard: the assisted apply permission', () => {
  const USAGE = { used: 0, cap: 10, instanceCap: 10, userCap: null, nextFreeAt: null };

  it('mints apply:assist alone, with wording on what it reads', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /device-tokens': { items: [] },
      'GET /integrations/apple-mail': NOT_CONNECTED,
      'GET /settings/applications': USAGE,
      'POST /device-tokens': (call: ApiCall) => ({
        status: 201,
        body: {
          ...LAPTOP,
          id: 't9',
          scopes: (call.body as { scopes: string[] }).scopes,
          token: TOKEN,
        },
      }),
    });
    renderWithProviders(<DevicesCard />);
    // The card says what the permission reads too, the confirmation lookup included (#199).
    expect(
      await screen.findByText(/also ask which of your applications a job site's page belongs to/),
    ).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Create token' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create a device token' });
    await user.type(within(dialog).getByLabelText('Name'), 'Chrome');
    await user.click(within(dialog).getByRole('checkbox', { name: /Apple Mail connector/ }));
    await user.click(await within(dialog).findByRole('checkbox', { name: /Assisted apply/ }));
    expect(
      within(dialog).getByText(/cannot start, review or submit an application/),
    ).toBeInTheDocument();
    // What the token can read is stated, the confirmation lookup included (sec on #199).
    expect(
      within(dialog).getByText(/which of your applications a job site's page belongs to/),
    ).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Current password'), PW);
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(
        (
          calls.find((c) => c.method === 'POST' && c.path === '/device-tokens')?.body as {
            scopes: string[];
          }
        )?.scopes,
      ).toEqual(['apply:assist']),
    );
  });

  it('is not offered where assisted apply does not exist', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /device-tokens': { items: [] },
      'GET /integrations/apple-mail': NOT_CONNECTED,
    });
    renderWithProviders(<DevicesCard />);
    await user.click(await screen.findByRole('button', { name: 'Create token' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create a device token' });
    await within(dialog).findByRole('checkbox', { name: /Browser capture/ });
    // After the availability check has answered (404 here), not only before it (tl on #185).
    await waitFor(() => expect(calls.some((c) => c.path === '/settings/applications')).toBe(true));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(within(dialog).queryByRole('checkbox', { name: /Assisted apply/ })).toBeNull();
  });

  it('lists a token with it under its own name', async () => {
    mockApi({
      'GET /device-tokens': { items: [{ ...LAPTOP, scopes: ['capture:push', 'apply:assist'] }] },
      'GET /integrations/apple-mail': NOT_CONNECTED,
    });
    renderWithProviders(<DevicesCard />);
    expect(await screen.findByText('Assisted apply (apply:assist)')).toBeInTheDocument();
  });
});
