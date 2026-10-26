import type { Checklist, Onboarding, TourState } from '@opportun/core';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHotkeys } from '@/lib/useHotkeys';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import { SetupChecklist } from './SetupChecklist';
import { TourProvider, useTour } from './TourProvider';

const NOT_STARTED: TourState = {
  version: 1,
  status: 'not_started',
  stepId: null,
  startedAt: null,
  finishedAt: null,
};
const NOTHING_DONE: Checklist = {
  aiKey: false,
  mail: false,
  firstOpportunity: false,
  dismissed: false,
  activatedAt: null,
};

function onboarding(over: Partial<Onboarding> = {}): Onboarding {
  return { tour: NOT_STARTED, checklist: NOTHING_DONE, autoStart: false, demo: false, ...over };
}

const ALL_TARGETS = [
  'setup-checklist',
  'ai-provider-keys',
  'gmail-card',
  'inbox-tabs',
  'inbox-connect',
  'new-opportunity',
  'pipeline-board',
  'discovery-sections',
  'register-resume',
  'contacts-list',
  'account-menu',
];

/** Every target the tour points at, on every route (the test router renders one tree). */
function FakePage({ hotkey, omit = [] }: { hotkey?: () => void; omit?: string[] }) {
  const { launch } = useTour();
  useHotkeys({ j: () => hotkey?.() });
  return (
    <main id="main" tabIndex={-1}>
      <button type="button" onClick={launch}>
        Launch tour
      </button>
      <SetupChecklist />
      {ALL_TARGETS.filter((t) => t !== 'setup-checklist' && !omit.includes(t)).map((t) => (
        <div key={t} data-tour={t}>
          {t}
        </div>
      ))}
      <select aria-label="Provider" data-tour="ai-provider">
        <option>anthropic</option>
      </select>
    </main>
  );
}

/** The server: answers GET with `state`, PUT by applying the body, recording every call. */
function server(initial: Onboarding, opts: { failPut?: boolean } = {}) {
  let state = initial;
  const mock = mockApi({
    'GET /onboarding': () => state,
    'PUT /onboarding/tour': (call: ApiCall) => {
      if (opts.failPut === true)
        return { status: 500, body: { error: { code: 'internal', message: 'boom' } } };
      const body = call.body as { status: TourState['status']; stepId: TourState['stepId'] };
      state = {
        ...state,
        autoStart: false,
        tour: { ...state.tour, ...body, startedAt: 1, finishedAt: null },
      };
      // Wrapped: mockApi reads a bare object's `status` key as the HTTP status.
      return { status: 200, body: state.tour };
    },
    'PATCH /onboarding/checklist': () => {
      state = { ...state, checklist: { ...state.checklist, dismissed: true } };
      return state.checklist;
    },
  });
  const puts = () =>
    mock.calls
      .filter((c) => c.method === 'PUT')
      .map((c) => c.body as { status: string; stepId: string });
  return { ...mock, puts };
}

function setup(
  initial: Onboarding,
  opts: { failPut?: boolean; omit?: string[]; path?: string } = {},
) {
  const api = server(initial, opts);
  const hotkey = vi.fn();
  const utils = renderWithProviders(
    <TourProvider>
      <FakePage hotkey={hotkey} omit={opts.omit ?? []} />
    </TourProvider>,
    { path: opts.path ?? '/' },
  );
  return { ...utils, api, hotkey };
}

const tourDialog = () => document.querySelector('dialog[data-tour-layer]') as HTMLDialogElement;
/** The open tour card, waiting for it to appear. */
const card = () => {
  const layer = tourDialog();
  if (layer === null) throw new Error('the tour is not open');
  return within(layer);
};
const findCard = async () => {
  await waitFor(() => expect(tourDialog()).not.toBeNull());
  return card();
};

beforeEach(() => {
  // jsdom lays nothing out: give tour targets a box, unless a test hides one.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const visible = this.hasAttribute('data-tour');
    return DOMRect.fromRect(visible ? { x: 10, y: 10, width: 120, height: 40 } : {});
  });
  // Reduced motion: instant scrolls, so no step waits on the smooth-scroll timeout.
  vi.stubGlobal(
    'matchMedia',
    (q: string) =>
      ({
        matches: q.includes('prefers-reduced-motion'),
        media: q,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('auto-start', () => {
  it('shows the welcome screen when the server says autoStart', async () => {
    setup(onboarding({ autoStart: true }));
    expect(
      await screen.findByRole('heading', { name: "Let's get your search running" }),
    ).toBeInTheDocument();
    expect(tourDialog().open).toBe(true);
    expect(card().getByRole('button', { name: 'Start the tour' })).toHaveFocus();
  });

  it('shows nothing for an account the server says not to start for', async () => {
    const { api } = setup(onboarding({ autoStart: false }));
    await waitFor(() => expect(api.calls.some((c) => c.path === '/onboarding')).toBe(true));
    await screen.findByText('Get set up');
    expect(tourDialog()).toBeNull();
  });

  it('does not auto-start on a page deeper than top level', async () => {
    const { api } = setup(onboarding({ autoStart: true }), { path: '/opportunities/abc' });
    await waitFor(() => expect(api.calls.some((c) => c.path === '/onboarding')).toBe(true));
    await screen.findByText('Get set up');
    expect(tourDialog()).toBeNull();
  });
});

describe('running the tour', () => {
  it('advances with Next (recording each step and navigating) and goes Back', async () => {
    const user = userEvent.setup();
    const { api, router } = setup(onboarding({ autoStart: true }));
    await user.click(await screen.findByRole('button', { name: 'Start the tour' }));
    expect(
      await card().findByRole('heading', { name: /Three steps to a working search/ }),
    ).toBeInTheDocument();
    expect(card().getByText('Step 1 of 9')).toBeInTheDocument();
    expect(api.puts()).toEqual([{ status: 'in_progress', stepId: 'checklist' }]);
    // Step 1 has no Back.
    expect(card().queryByRole('button', { name: 'Back' })).toBeNull();

    await user.click(card().getByRole('button', { name: 'Next' }));
    expect(
      await card().findByRole('heading', { name: /Bring your own AI key/ }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/settings/ai');
    expect(api.puts().at(-1)).toEqual({ status: 'in_progress', stepId: 'ai-key' });
    // Not done: Do it now is the primary action and has focus.
    await waitFor(() => expect(card().getByRole('button', { name: 'Add my key' })).toHaveFocus());

    await user.click(card().getByRole('button', { name: 'Back' }));
    expect(await card().findByRole('heading', { name: /Three steps/ })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
  });

  it.each([
    [
      'Skip tour',
      (u: ReturnType<typeof userEvent.setup>) =>
        u.click(card().getByRole('button', { name: 'Skip tour' })),
    ],
    [
      'Close tour (X)',
      (u: ReturnType<typeof userEvent.setup>) =>
        u.click(card().getByRole('button', { name: 'Close tour' })),
    ],
    [
      'Escape',
      async () => {
        act(() => {
          tourDialog().dispatchEvent(new Event('cancel', { cancelable: true }));
        });
      },
    ],
  ])('%s records skipped with the step reached and closes', async (_name, exit) => {
    const user = userEvent.setup();
    const { api } = setup(onboarding({ autoStart: true }));
    await user.click(await screen.findByRole('button', { name: 'Start the tour' }));
    await user.click(await card().findByRole('button', { name: 'Next' }));
    await card().findByRole('heading', { name: /Bring your own AI key/ });
    await exit(user);
    await waitFor(() => expect(tourDialog()).toBeNull());
    expect(api.puts().at(-1)).toEqual({ status: 'skipped', stepId: 'ai-key' });
  });

  it('a Skip whose write fails says so and leaves the tour open', async () => {
    const user = userEvent.setup();
    setup(onboarding({ autoStart: true }), { failPut: true });
    await user.click(await (await findCard()).findByRole('button', { name: 'Not now' }));
    expect(await screen.findByText('Could not save the tour')).toBeInTheDocument();
    expect(tourDialog().open).toBe(true);
  });

  it('Done on the last step records completed', async () => {
    const user = userEvent.setup();
    const { api } = setup(
      onboarding({ tour: { ...NOT_STARTED, status: 'skipped', stepId: 'finish' } }),
    );
    await user.click(await screen.findByRole('button', { name: 'Launch tour' }));
    await user.click(await (await findCard()).findByRole('button', { name: 'Resume at step 9' }));
    await user.click(await card().findByRole('button', { name: 'Done' }));
    await waitFor(() => expect(tourDialog()).toBeNull());
    expect(api.puts().at(-1)).toEqual({ status: 'completed', stepId: 'finish' });
  });
});

describe('relaunch', () => {
  it('after a skip, offers Resume at the recorded step and Start over', async () => {
    const user = userEvent.setup();
    const { api, router } = setup(
      onboarding({ tour: { ...NOT_STARTED, status: 'skipped', stepId: 'inbox' } }),
    );
    await user.click(await screen.findByRole('button', { name: 'Launch tour' }));
    expect(
      await (await findCard()).findByRole('button', { name: 'Start over' }),
    ).toBeInTheDocument();
    await user.click(card().getByRole('button', { name: 'Resume at step 4' }));
    expect(
      await card().findByRole('heading', { name: /Your mail will land here/ }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/inbox');
    expect(api.puts().at(-1)).toEqual({ status: 'in_progress', stepId: 'inbox' });
  });

  it('Start over begins again at step 1', async () => {
    const user = userEvent.setup();
    const { api } = setup(
      onboarding({ tour: { ...NOT_STARTED, status: 'skipped', stepId: 'inbox' } }),
    );
    await user.click(await screen.findByRole('button', { name: 'Launch tour' }));
    await user.click(await (await findCard()).findByRole('button', { name: 'Start over' }));
    expect(await card().findByText('Step 1 of 9')).toBeInTheDocument();
    expect(api.puts().at(-1)).toEqual({ status: 'in_progress', stepId: 'checklist' });
  });
});

describe('Do it now and the Resume pill', () => {
  it('pauses (recorded first), closes the overlay, focuses the control, and resumes at the next step', async () => {
    const user = userEvent.setup();
    const { api, router } = setup(
      onboarding({ tour: { ...NOT_STARTED, status: 'skipped', stepId: 'ai-key' } }),
    );
    await user.click(await screen.findByRole('button', { name: 'Launch tour' }));
    await user.click(await (await findCard()).findByRole('button', { name: 'Resume at step 2' }));
    await user.click(await card().findByRole('button', { name: 'Add my key' }));

    const pill = await screen.findByRole('button', { name: 'Resume tour (2 of 9)' });
    expect(tourDialog()).toBeNull();
    expect(api.puts().at(-1)).toEqual({ status: 'paused', stepId: 'ai-key' });
    expect(router.state.location.pathname).toBe('/settings/ai');
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Provider' })).toHaveFocus());

    await user.click(pill);
    expect(
      await (await findCard()).findByRole('heading', { name: /Let your inbox do the data entry/ }),
    ).toBeInTheDocument();
    expect(api.puts().at(-1)).toEqual({ status: 'in_progress', stepId: 'mail' });
  });

  it('a pause saved before the OAuth redirect comes back as the pill, and resumes at step 4', async () => {
    const user = userEvent.setup();
    const { api } = setup(
      onboarding({ tour: { ...NOT_STARTED, status: 'paused', stepId: 'mail' } }),
      { path: '/settings/integrations' },
    );
    await user.click(await screen.findByRole('button', { name: 'Resume tour (3 of 9)' }));
    expect(await (await findCard()).findByText('Step 4 of 9')).toBeInTheDocument();
    expect(api.puts().at(-1)).toEqual({ status: 'in_progress', stepId: 'inbox' });
  });

  it('says so when the item that paused the tour is done', async () => {
    setup(
      onboarding({
        tour: { ...NOT_STARTED, status: 'paused', stepId: 'mail' },
        checklist: { ...NOTHING_DONE, mail: true },
      }),
    );
    expect(
      await screen.findByRole('button', { name: "Nice, that's done. Continue tour" }),
    ).toBeInTheDocument();
  });

  it('page hotkeys do nothing while the tour is open, and work while it is paused', async () => {
    const user = userEvent.setup();
    const { hotkey } = setup(
      onboarding({ tour: { ...NOT_STARTED, status: 'skipped', stepId: 'ai-key' } }),
    );
    await user.click(await screen.findByRole('button', { name: 'Launch tour' }));
    await user.click(await (await findCard()).findByRole('button', { name: 'Resume at step 2' }));
    await card().findByRole('heading', { name: /Bring your own AI key/ });
    // Focus off the card's buttons so only the dialog[open] guard is in play.
    (document.activeElement as HTMLElement).blur();
    await user.keyboard('j');
    expect(hotkey).not.toHaveBeenCalled();

    await user.click(card().getByRole('button', { name: 'Add my key' }));
    await screen.findByRole('button', { name: 'Resume tour (2 of 9)' });
    (document.activeElement as HTMLElement).blur();
    await user.keyboard('j');
    expect(hotkey).toHaveBeenCalledTimes(1);
  });
});

describe('target fallbacks', () => {
  it('shows a step centered, highlighting nothing, when its target never appears', async () => {
    const user = userEvent.setup();
    setup(onboarding({ tour: { ...NOT_STARTED, status: 'skipped', stepId: 'ai-key' } }), {
      omit: ['ai-provider-keys'],
    });
    await user.click(await screen.findByRole('button', { name: 'Launch tour' }));
    await user.click(await (await findCard()).findByRole('button', { name: 'Resume at step 2' }));
    const layer = tourDialog();
    await waitFor(
      () =>
        expect(layer.querySelector('[data-tour-card]')).toHaveAttribute('data-layout', 'centered'),
      { timeout: 4000 },
    );
    expect(layer.querySelector('[data-tour-spotlight]')).toBeNull();
    expect(card().getByRole('heading', { name: /Bring your own AI key/ })).toBeVisible();
  });

  it('anchors the card and draws the spotlight when the target is there', async () => {
    const user = userEvent.setup();
    setup(onboarding({ tour: { ...NOT_STARTED, status: 'skipped', stepId: 'ai-key' } }));
    await user.click(await screen.findByRole('button', { name: 'Launch tour' }));
    await user.click(await (await findCard()).findByRole('button', { name: 'Resume at step 2' }));
    const layer = tourDialog();
    await waitFor(() => {
      expect(layer.querySelector('[data-tour-card]')).toHaveAttribute('data-layout', 'anchored');
      expect(layer.querySelector('[data-tour-spotlight]')).not.toBeNull();
    });
  });
});

describe('demo instance', () => {
  it('runs view-only: no checklist, no setup items, no Do it now, done copy', async () => {
    const user = userEvent.setup();
    const { api } = setup(onboarding({ autoStart: true, demo: true }));
    await (await findCard()).findByRole('heading', { name: "Let's get your search running" });
    expect(card().queryByRole('list', { name: /Setup:/ })).toBeNull();
    expect(screen.queryByText('Get set up')).toBeNull();

    await user.click(card().getByRole('button', { name: 'Start the tour' }));
    // Step 1 points at the checklist, which the demo does not have: passed through, count kept.
    expect(await card().findByText('Step 2 of 9')).toBeInTheDocument();
    expect(card().getByText(/Your AI key is in/)).toBeInTheDocument();
    expect(card().queryByRole('button', { name: 'Add my key' })).toBeNull();
    expect(api.puts()[0]).toEqual({ status: 'in_progress', stepId: 'ai-key' });

    await user.click(card().getByRole('button', { name: 'Next' }));
    expect(await card().findByText(/Your mail is connected/)).toBeInTheDocument();
    expect(card().queryByRole('button', { name: 'Set up Gmail' })).toBeNull();
    expect(card().queryByRole('button', { name: /Apple Mail/ })).toBeNull();
  });
});

describe('setup checklist', () => {
  it('shows progress accessibly and hides Hide until one item is done', async () => {
    setup(onboarding());
    const bar = await screen.findByRole('progressbar', { name: 'Setup progress' });
    expect(bar).toHaveAttribute('aria-valuenow', '0');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '3');
    expect(screen.getByText('0 of 3 done')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hide' })).toBeNull();
  });

  it('Hide records the dismissal once something is done', async () => {
    const user = userEvent.setup();
    const { api } = setup(onboarding({ checklist: { ...NOTHING_DONE, aiKey: true } }));
    expect(await screen.findByText('1 of 3 done')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Add key' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Hide' }));
    await waitFor(() => expect(screen.queryByText('Get set up')).toBeNull());
    expect(api.calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([
      { dismissed: true },
    ]);
  });

  it('Take the tour opens the welcome screen', async () => {
    const user = userEvent.setup();
    setup(onboarding());
    await user.click(await screen.findByRole('button', { name: 'Take the tour' }));
    expect(
      await (await findCard()).findByRole('button', { name: 'Start the tour' }),
    ).toBeInTheDocument();
  });

  it('celebrates activation for one visit and records the dismissal', async () => {
    const { api } = setup(
      onboarding({
        checklist: {
          aiKey: true,
          mail: true,
          firstOpportunity: true,
          dismissed: false,
          activatedAt: 5,
        },
      }),
    );
    expect(
      await screen.findByText('Your pipeline now fills itself from your mail.'),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(api.calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([
        { dismissed: true },
      ]),
    );
    // Still shown for the rest of this visit.
    expect(screen.getByText('Your pipeline now fills itself from your mail.')).toBeInTheDocument();
  });
});
