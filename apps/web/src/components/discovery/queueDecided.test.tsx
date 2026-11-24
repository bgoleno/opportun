// Deciding a card that was decided somewhere else (a capture, another tab): the page says what
// happened, with the way to its opportunity, the card stays gone, and no dialog asks anything
// (https://github.com/bgoleno/opportun/issues/968; tl's design, sections 2 and 3, on
// https://github.com/bgoleno/opportun/issues/967).
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders, toastRegion, type ApiCall } from '@/test/render';
import type { DiscoveryResult } from './api';
import { ReviewQueue } from './ReviewQueue';

const NOW = Date.now();

function result(id: string, over: Partial<DiscoveryResult> = {}): DiscoveryResult {
  return {
    id,
    runId: 'run-1',
    sourceId: 'src-1',
    sourceKind: 'alert_email',
    roleTargetId: null,
    posting: { company: 'Initech', title: `Role ${id}`, postingUrl: null, location: null },
    dedupeKey: `initech|role ${id}|`,
    aiScore: 80,
    aiRationale: null,
    rankSkipReason: null,
    rankDeferredAt: null,
    rankBatchSentAt: null,
    prefilterOutcome: null,
    prefilterRule: null,
    resolution: 'needs_capture',
    resolvedSourceRef: null,
    disposition: 'pending',
    opportunityId: null,
    sourceMailChannel: null,
    sourceMailExternalId: null,
    dismissReason: null,
    dismissNote: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

const A = result('A');
const B = result('B');
const member = (id: string, location: string): DiscoveryResult =>
  result(id, {
    dedupeKey: `globex|analyst|${location.toLowerCase()}`,
    posting: { company: 'Globex', title: 'Analyst', postingUrl: null, location },
  });
const GROUP = [member('g1', 'Austin'), member('g2', 'Boston'), member('g3', 'Chicago')];

const refusal = (status: number, error: Record<string, unknown>) => () => ({
  status,
  body: { error },
});
const inPipeline = refusal(409, {
  code: 'already_decided',
  message: 'This result was already accepted.',
  disposition: 'accepted',
  existingId: 'o-9',
});
const deleted = refusal(409, {
  code: 'already_decided',
  message: 'This result was already accepted.',
  disposition: 'accepted',
});
const dismissed = refusal(409, {
  code: 'already_decided',
  message: 'This result was already dismissed.',
  disposition: 'dismissed',
});

function queue(items: DiscoveryResult[], routes: Record<string, unknown>) {
  const server = { items };
  const { calls } = mockApi({
    'GET /discovery/results': () => ({ items: server.items, total: server.items.length }),
    ...routes,
  });
  return { server, calls, ...renderWithProviders(<ReviewQueue />) };
}

const posts = (calls: ApiCall[]) =>
  calls.filter((c) => c.method === 'POST').map((c) => [c.path, c.body] as const);

/** The toast that says `title`, and that it is not an error's. */
async function said(title: string) {
  const el = await toastRegion().findByText(title);
  const item = el.closest('li');
  if (item === null) throw new Error('the toast has no list item');
  expect(item.className).not.toContain('destructive');
  return within(item);
}

describe('one card, decided somewhere else', () => {
  it.each([
    ['Accept', 'accept', inPipeline, 'Already in your pipeline', true],
    [
      'Accept',
      'accept',
      deleted,
      'Already accepted; its opportunity has since been deleted.',
      false,
    ],
    ['Accept', 'accept', dismissed, 'Not accepted: this result was already dismissed.', false],
    ['Dismiss', 'dismiss', inPipeline, 'Not dismissed: already in your pipeline', true],
    [
      'Dismiss',
      'dismiss',
      deleted,
      'Not dismissed: already accepted, and its opportunity has since been deleted.',
      false,
    ],
    ['Dismiss', 'dismiss', dismissed, 'Already dismissed.', false],
  ])(
    '%s (%s): the sentence, the link when there is one, and no dialog',
    async (button, route, answer, title, linked) => {
      // Held on the list on purpose: the card must be gone before the next read takes it.
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let reads = 0;
      const { calls } = mockApi({
        'GET /discovery/results': async () => {
          reads += 1;
          if (reads > 1) await gate;
          return { items: reads > 1 ? [B] : [A, B], total: reads > 1 ? 1 : 2 };
        },
        [`POST /discovery/results/A/${route}`]: answer,
      });
      const { router } = renderWithProviders(<ReviewQueue />);
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: `${button} Role A at Initech` }));
      if (button === 'Dismiss') {
        const dialog = await screen.findByRole('dialog', { name: 'Dismiss result' });
        await user.selectOptions(within(dialog).getByLabelText('Reason'), 'stale');
        await user.click(within(dialog).getByRole('button', { name: 'Dismiss' }));
      }
      // Before the next read: gone with its answer, not put back until that read takes it.
      await waitFor(() => expect(reads).toBe(2));
      expect(screen.queryByRole('listitem', { name: 'Role A at Initech' })).toBeNull();
      expect(screen.getByText('1 result to review.')).toBeInTheDocument();
      release();
      const toast = await said(title);
      expect(toast.getByText('Role A at Initech')).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(posts(calls)).toHaveLength(1);
      const view = toast.queryByRole('button', { name: 'View opportunity' });
      expect(view !== null).toBe(linked);
      if (view !== null) {
        await user.click(view);
        await waitFor(() => expect(router.state.location.pathname).toBe('/opportunities/o-9'));
      }
    },
  );

  it('a card the server refuses for another reason still comes back', async () => {
    const q = queue([A, B], {
      'POST /discovery/results/A/accept': refusal(500, { code: 'internal' }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Accept Role A at Initech' }));
    expect(await toastRegion().findByText('Not accepted')).toBeInTheDocument();
    expect(await screen.findByRole('listitem', { name: 'Role A at Initech' })).toBeInTheDocument();
    expect(posts(q.calls)).toHaveLength(1);
  });
});

describe('the duplicate dialog', () => {
  const duplicate = refusal(409, { code: 'duplicate', existingId: 'o-5' });

  /** Accept answers duplicate; what the dialog's button answers. */
  function asking(second: () => unknown) {
    let n = 0;
    return queue([A, B], {
      'POST /discovery/results/A/accept': () => (n++ === 0 ? duplicate() : second()),
    });
  }
  async function open(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: 'Accept Role A at Initech' }));
    return await screen.findByRole('dialog', { name: 'Already in your pipeline?' });
  }

  it.each(['Attach to existing', 'Create anyway'])(
    '%s on a result captured while it was open: it closes and says so',
    async (button) => {
      asking(inPipeline);
      const user = userEvent.setup();
      const dialog = await open(user);
      await user.click(within(dialog).getByRole('button', { name: button }));
      const toast = await said('Already in your pipeline');
      expect(toast.getByRole('button', { name: 'View opportunity' })).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).toBeNull();
    },
  );

  it('Attach to an opportunity deleted while it was open: it closes, says so, and the card stays', async () => {
    asking(refusal(404, { code: 'opportunity_not_found' }));
    const user = userEvent.setup();
    const dialog = await open(user);
    await user.click(within(dialog).getByRole('button', { name: 'Attach to existing' }));
    await said('Not attached: that opportunity has since been deleted.');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByRole('listitem', { name: 'Role A at Initech' })).toBeInTheDocument();
  });

  it('Attach of a result that is gone does not say its opportunity was deleted', async () => {
    asking(refusal(404, { code: 'not_found' }));
    const user = userEvent.setup();
    const dialog = await open(user);
    await user.click(within(dialog).getByRole('button', { name: 'Attach to existing' }));
    expect(await toastRegion().findByText('Not accepted')).toBeInTheDocument();
    expect(toastRegion().queryByText(/since been deleted/)).toBeNull();
  });

  it('another card accepted meanwhile does not close it', async () => {
    let answer!: () => void;
    const gate = new Promise<void>((r) => (answer = r));
    queue([A, B], {
      'POST /discovery/results/B/accept': async () => {
        await gate;
        return { ...B, disposition: 'accepted', opportunityId: 'o-7' };
      },
      'POST /discovery/results/A/accept': duplicate,
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Accept Role B at Initech' }));
    await open(user);
    answer();
    await said('Added to pipeline');
    expect(screen.getByRole('dialog', { name: 'Already in your pipeline?' })).toBeInTheDocument();
  });

  it('any other error leaves it open', async () => {
    asking(refusal(500, { code: 'internal' }));
    const user = userEvent.setup();
    const dialog = await open(user);
    await user.click(within(dialog).getByRole('button', { name: 'Attach to existing' }));
    expect(await toastRegion().findByText('Not accepted')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Already in your pipeline?' })).toBeInTheDocument();
  });
});

describe('a card of several locations, some decided somewhere else', () => {
  const accepted = (id: string) => () => ({
    ...GROUP.find((g) => g.id === id)!,
    disposition: 'accepted',
    opportunityId: 'o-9',
  });
  const acceptAll = async (user: ReturnType<typeof userEvent.setup>) =>
    user.click(await screen.findByRole('button', { name: 'Accept all 3 for Analyst at Globex' }));
  async function dismissAll(user: ReturnType<typeof userEvent.setup>) {
    await user.click(
      await screen.findByRole('button', { name: 'Dismiss all 3 for Analyst at Globex' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Dismiss result' });
    await user.selectOptions(within(dialog).getByLabelText('Reason'), 'stale');
    await user.click(within(dialog).getByRole('button', { name: 'Dismiss' }));
  }

  it('Accept all, the first already in an opportunity: the rest are linked to it', async () => {
    const q = queue(GROUP, {
      'POST /discovery/results/g1/accept': inPipeline,
      'POST /discovery/results/g2/accept': accepted('g2'),
      'POST /discovery/results/g3/accept': accepted('g3'),
    });
    const user = userEvent.setup();
    await acceptAll(user);
    const toast = await said('2 other locations linked; 1 already in your pipeline');
    expect(toast.getByRole('button', { name: 'View opportunity' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(posts(q.calls)).toEqual([
      ['/discovery/results/g1/accept', {}],
      ['/discovery/results/g2/accept', { attachTo: 'o-9' }],
      ['/discovery/results/g3/accept', { attachTo: 'o-9' }],
    ]);
  });

  it.each([
    ['dismissed', dismissed, 'Not accepted: this result was already dismissed.'],
    [
      'accepted, its opportunity deleted',
      deleted,
      'Already accepted; its opportunity has since been deleted.',
    ],
  ])('Accept all, the first %s: it stops there and says so', async (_what, answer, title) => {
    const q = queue(GROUP, { 'POST /discovery/results/g1/accept': answer });
    const user = userEvent.setup();
    await acceptAll(user);
    const toast = await said(title);
    expect(
      toast.getByText('Analyst at Globex. Its other locations are still here.'),
    ).toBeInTheDocument();
    expect(posts(q.calls)).toHaveLength(1);
  });

  it('Accept all, another member already decided: counted, not a failure', async () => {
    queue(GROUP, {
      'POST /discovery/results/g1/accept': accepted('g1'),
      'POST /discovery/results/g2/accept': inPipeline,
      'POST /discovery/results/g3/accept': dismissed,
    });
    const user = userEvent.setup();
    await acceptAll(user);
    const toast = await said(
      '1 added to pipeline; 1 already in your pipeline; 1 already dismissed',
    );
    expect(toast.getByRole('button', { name: 'View opportunity' })).toBeInTheDocument();
    expect(toastRegion().queryByText('Not accepted')).toBeNull();
  });

  it('Accept all that matches another opportunity, captured while it asked: the rest follow it', async () => {
    let n = 0;
    const q = queue(GROUP, {
      'POST /discovery/results/g1/accept': () =>
        n++ === 0 ? refusal(409, { code: 'duplicate', existingId: 'o-5' })() : inPipeline(),
      'POST /discovery/results/g2/accept': accepted('g2'),
      'POST /discovery/results/g3/accept': accepted('g3'),
    });
    const user = userEvent.setup();
    await acceptAll(user);
    const dialog = await screen.findByRole('dialog', { name: 'Already in your pipeline?' });
    await user.click(within(dialog).getByRole('button', { name: 'Attach to existing' }));
    await said('2 other locations linked; 1 already in your pipeline');
    expect(posts(q.calls).slice(2)).toEqual([
      ['/discovery/results/g2/accept', { attachTo: 'o-9' }],
      ['/discovery/results/g3/accept', { attachTo: 'o-9' }],
    ]);
  });

  it('Dismiss all: each kind counted, with the way to the one opportunity', async () => {
    queue(GROUP, {
      'POST /discovery/results/g1/dismiss': { ...GROUP[0]!, disposition: 'dismissed' },
      'POST /discovery/results/g2/dismiss': inPipeline,
      'POST /discovery/results/g3/dismiss': dismissed,
    });
    const user = userEvent.setup();
    await dismissAll(user);
    const toast = await said('1 dismissed; 1 already in your pipeline; 1 already dismissed');
    expect(toast.getByRole('button', { name: 'View opportunity' })).toBeInTheDocument();
  });

  it('Dismiss all: one whose opportunity was deleted is in no pipeline, and there is no link', async () => {
    queue(GROUP, {
      'POST /discovery/results/g1/dismiss': { ...GROUP[0]!, disposition: 'dismissed' },
      'POST /discovery/results/g2/dismiss': deleted,
      'POST /discovery/results/g3/dismiss': { ...GROUP[2]!, disposition: 'dismissed' },
    });
    const user = userEvent.setup();
    await dismissAll(user);
    const toast = await said('2 dismissed; 1 already accepted');
    expect(toast.queryByRole('button', { name: 'View opportunity' })).toBeNull();
  });

  it("a card whose accept failed leaves nothing to the next card's Attach", async () => {
    const duplicate = refusal(409, { code: 'duplicate', existingId: 'o-5' });
    let n = 0;
    const q = queue([...GROUP, A], {
      'POST /discovery/results/g1/accept': refusal(500, { code: 'internal' }),
      'POST /discovery/results/A/accept': () =>
        n++ === 0 ? duplicate() : { ...A, disposition: 'accepted', opportunityId: 'o-5' },
    });
    const user = userEvent.setup();
    await acceptAll(user);
    expect(await toastRegion().findByText('Not accepted')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Accept Role A at Initech' }));
    const dialog = await screen.findByRole('dialog', { name: 'Already in your pipeline?' });
    await user.click(within(dialog).getByRole('button', { name: 'Attach to existing' }));
    await said('Attached to the existing opportunity');
    expect(posts(q.calls).map(([path]) => path)).toEqual([
      '/discovery/results/g1/accept',
      '/discovery/results/A/accept',
      '/discovery/results/A/accept',
    ]);
  });

  it("a card in flight does not lend its locations to another card's dialog", async () => {
    const duplicate = refusal(409, { code: 'duplicate', existingId: 'o-5' });
    let answer!: () => void;
    const gate = new Promise<void>((r) => (answer = r));
    let n = 0;
    const q = queue([...GROUP, A], {
      'POST /discovery/results/g1/accept': async () => {
        await gate;
        return refusal(500, { code: 'internal' })();
      },
      'POST /discovery/results/A/accept': () =>
        n++ === 0 ? duplicate() : { ...A, disposition: 'accepted', opportunityId: 'o-5' },
    });
    const user = userEvent.setup();
    await acceptAll(user);
    await user.click(await screen.findByRole('button', { name: 'Accept Role A at Initech' }));
    const dialog = await screen.findByRole('dialog', { name: 'Already in your pipeline?' });
    await user.click(within(dialog).getByRole('button', { name: 'Attach to existing' }));
    answer();
    await said('Attached to the existing opportunity');
    expect(posts(q.calls).some(([path]) => /g2|g3/.test(path))).toBe(false);
  });

  it('Attach to a deleted opportunity ends it: the next duplicate is only its own card', async () => {
    const duplicate = refusal(409, { code: 'duplicate', existingId: 'o-5' });
    const n = { g1: 0, A: 0 };
    const q = queue([...GROUP, A], {
      'POST /discovery/results/g1/accept': () =>
        n.g1++ === 0 ? duplicate() : refusal(404, { code: 'opportunity_not_found' })(),
      'POST /discovery/results/A/accept': () =>
        n.A++ === 0 ? duplicate() : { ...A, disposition: 'accepted', opportunityId: 'o-5' },
    });
    const user = userEvent.setup();
    const attach = async () => {
      const dialog = await screen.findByRole('dialog', { name: 'Already in your pipeline?' });
      await user.click(within(dialog).getByRole('button', { name: 'Attach to existing' }));
    };
    await acceptAll(user);
    await attach();
    await said('Not attached: that opportunity has since been deleted.');
    await user.click(await screen.findByRole('button', { name: 'Accept Role A at Initech' }));
    await attach();
    await said('Attached to the existing opportunity');
    expect(posts(q.calls).map(([path]) => path)).toEqual([
      '/discovery/results/g1/accept',
      '/discovery/results/g1/accept',
      '/discovery/results/A/accept',
      '/discovery/results/A/accept',
    ]);
  });

  it('a member that truly fails is still an error', async () => {
    queue(GROUP, {
      'POST /discovery/results/g1/accept': accepted('g1'),
      'POST /discovery/results/g2/accept': inPipeline,
      'POST /discovery/results/g3/accept': refusal(500, { code: 'internal' }),
    });
    const user = userEvent.setup();
    await acceptAll(user);
    const el = await toastRegion().findByText(
      '1 added to pipeline; 1 already in your pipeline; 1 not linked',
    );
    expect(el.closest('li')?.className).toContain('destructive');
  });
});

describe('bulk', () => {
  it.each([
    [
      'Accept',
      'bulk-accept',
      'Accept 2',
      '0 accepted; 1 linked to an opportunity; 1 already decided',
    ],
    ['Dismiss', 'bulk-dismiss', 'Dismiss 2', '0 dismissed; 2 already decided'],
  ])('%s counts them, with no link', async (button, route, confirm, title) => {
    queue([A, B], {
      [`POST /discovery/results/${route}`]: {
        results:
          button === 'Accept'
            ? [
                { id: 'A', outcome: 'attached', existingId: 'o-9' },
                { id: 'B', outcome: 'already_decided', existingId: 'o-9' },
              ]
            : [
                { id: 'A', outcome: 'already_decided', existingId: 'o-9' },
                { id: 'B', outcome: 'already_decided' },
              ],
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: 'Select Role A at Initech' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Role B at Initech' }));
    await user.click(screen.getByRole('button', { name: button }));
    await user.click(await screen.findByRole('button', { name: confirm }));
    const toast = await said(title);
    expect(toast.queryByRole('button', { name: 'View opportunity' })).toBeNull();
    expect(toast.queryByRole('button', { name: 'Undo' })).toBeNull();
  });
});

describe('Capture description on a lead decided somewhere else', () => {
  it('says so, keeps the text, offers no second try and reads the queue again', async () => {
    const SENTENCE = 'That result no longer needs a capture.';
    const q = queue([A, B], {
      'POST /capture': refusal(409, { code: 'not_capturable', message: SENTENCE }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Role A' }));
    await user.click(await screen.findByRole('button', { name: 'Capture description' }));
    const dialog = await screen.findByRole('dialog', { name: 'Capture description' });
    await user.click(within(dialog).getByLabelText('Pasted text'));
    await user.type(within(dialog).getByLabelText('Posting description'), 'The whole posting');
    q.server.items = [B];
    await user.click(within(dialog).getByRole('button', { name: 'Capture' }));
    expect(await within(dialog).findByText(SENTENCE)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Posting description')).toHaveValue('The whole posting');
    expect(within(dialog).getByRole('button', { name: 'Capture' })).toBeDisabled();
    await waitFor(() => expect(screen.queryByText('Role A', { selector: 'li *' })).toBeNull());
    // Still no second try after a change of mode.
    await user.click(within(dialog).getByLabelText('Link'));
    expect(within(dialog).getByRole('button', { name: 'Capture' })).toBeDisabled();
    expect(posts(q.calls)).toHaveLength(1);
  });
});
