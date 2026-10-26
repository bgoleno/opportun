// The two posting-reconciliation indicators (design D8, D9, D10, D13). The background board
// search changes nothing when it cannot settle the posting, so the user has to be told, and
// told somewhere they will act on: a banner on the opportunity, and a mark on the pipeline
// card so it is visible without opening anything.
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import type { OpportunityView } from '@/lib/opportunities';
import {
  PostingConfirmedStatus,
  PostingStateBanner,
  RederiveFromCaptureAction,
} from './PostingStateBanner';
import { DetailsPanel } from './DetailsPanel';

const opp = (over: Partial<OpportunityView> = {}): OpportunityView =>
  ({
    id: 'opp-1',
    userId: 'u1',
    companyId: 'c1',
    companyName: 'Soylent',
    title: 'Staff Product Manager',
    descriptionMd: null,
    postingUrl: null,
    sourceKind: 'discovery',
    sourceRef: null,
    location: null,
    remote: null,
    compNote: null,
    stage: 'interested',
    stageDetail: null,
    closedReason: null,
    dismissedReason: null,
    priority: 2,
    atsJobRef: null,
    postingState: null,
    postingStateDetail: null,
    descriptionIsUserWritten: false,
    hasCapturedPage: false,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }) as OpportunityView;

// renderWithProviders mounts through a TanStack router, which resolves asynchronously: an
// assertion made before it has rendered passes whatever the component does. Every test waits
// on the anchor first, including the ones asserting the banner is absent.
function show(o: OpportunityView) {
  renderWithProviders(
    <>
      <span data-testid="anchor" />
      <PostingStateBanner opp={o} />
    </>,
  );
  return screen.findByTestId('anchor');
}

describe('PostingStateBanner', () => {
  it('shows nothing when no board search was ever attempted', async () => {
    await show(opp());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows nothing when the posting is confirmed', async () => {
    await show(opp({ postingState: 'confirmed' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('says the board is being checked while the job runs', async () => {
    await show(opp({ postingState: 'searching' }));
    expect(screen.getByRole('status')).toHaveTextContent(/checking .*job board/i);
    // Nothing to do yet, so nothing to press.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('offers Choose posting when several rows matched', async () => {
    await show(opp({ postingState: 'needs_review', postingStateDetail: 'ambiguous' }));
    expect(screen.getByRole('status')).toHaveTextContent(/several postings/i);
    expect(screen.getByRole('button', { name: /choose posting/i })).toBeInTheDocument();
  });

  it('offers Look again when the board carried no match', async () => {
    await show(opp({ postingState: 'needs_review', postingStateDetail: 'none_found' }));
    expect(screen.getByRole('button', { name: /look again/i })).toBeInTheDocument();
  });

  it('offers Add board when the company has none', async () => {
    await show(opp({ postingState: 'needs_review', postingStateDetail: 'no_board' }));
    expect(screen.getByRole('status')).toHaveTextContent(/no job board/i);
    expect(screen.getByRole('button', { name: /add board/i })).toBeInTheDocument();
  });

  it('explains that an edit of your own blocked the merge', async () => {
    await show(opp({ postingState: 'needs_review', postingStateDetail: 'edited' }));
    expect(screen.getByRole('status')).toHaveTextContent(/you edited this description/i);
  });

  it.each(['ambiguous', 'none_found', 'no_board', 'failed'] as const)(
    'offers Confirm alongside the board action for %s (issue #250)',
    async (detail) => {
      await show(opp({ postingState: 'needs_review', postingStateDetail: detail }));
      expect(screen.getByRole('button', { name: /^confirm$/i })).toBeInTheDocument();
    },
  );

  it('does not offer Confirm for edited: Review board copy already resolves it', async () => {
    await show(opp({ postingState: 'needs_review', postingStateDetail: 'edited' }));
    expect(screen.queryByRole('button', { name: /^confirm$/i })).not.toBeInTheDocument();
  });

  it('calls onConfirm when Confirm is pressed', async () => {
    const user = userEvent.setup();
    let called = 0;
    renderWithProviders(
      <PostingStateBanner
        opp={opp({ postingState: 'needs_review', postingStateDetail: 'none_found' })}
        onConfirm={() => {
          called += 1;
        }}
      />,
    );
    await user.click(await screen.findByRole('button', { name: /^confirm$/i }));
    expect(called).toBe(1);
  });
});

describe('PostingConfirmedStatus (issue #255)', () => {
  it('shows nothing when the posting is not confirmed', async () => {
    renderWithProviders(
      <>
        <span data-testid="anchor" />
        <PostingConfirmedStatus
          opp={opp({ postingState: 'needs_review', postingStateDetail: 'none_found' })}
          onRefetch={() => {}}
        />
      </>,
    );
    await screen.findByTestId('anchor');
    expect(screen.queryByRole('button', { name: /refetch/i })).not.toBeInTheDocument();
  });

  it('shows the board-match provenance and a Refetch button when confirmed', async () => {
    renderWithProviders(
      <PostingConfirmedStatus opp={opp({ postingState: 'confirmed' })} onRefetch={() => {}} />,
    );
    expect(await screen.findByText(/matched on the company's board/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /refetch/i })).toBeInTheDocument();
  });

  it('confirms before refetching, and only calls onRefetch once confirmed', async () => {
    const user = userEvent.setup();
    let called = 0;
    renderWithProviders(
      <PostingConfirmedStatus
        opp={opp({ postingState: 'confirmed' })}
        onRefetch={() => {
          called += 1;
        }}
      />,
    );
    await user.click(await screen.findByRole('button', { name: /refetch/i }));
    const dialog = await screen.findByRole('dialog', { name: /refetch this posting/i });
    expect(called).toBe(0);
    await user.click(within(dialog).getByRole('button', { name: /refetch/i }));
    expect(called).toBe(1);
  });

  it('warns specifically when the current description is the user’s own writing', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <PostingConfirmedStatus
        opp={opp({ postingState: 'confirmed', descriptionIsUserWritten: true })}
        onRefetch={() => {}}
      />,
    );
    await user.click(await screen.findByRole('button', { name: /refetch/i }));
    expect(await screen.findByText(/edited this description by hand/i)).toBeInTheDocument();
  });

  it('cancel leaves the description untouched: onRefetch never fires', async () => {
    const user = userEvent.setup();
    let called = 0;
    renderWithProviders(
      <PostingConfirmedStatus
        opp={opp({ postingState: 'confirmed' })}
        onRefetch={() => {
          called += 1;
        }}
      />,
    );
    await user.click(await screen.findByRole('button', { name: /refetch/i }));
    const dialog = await screen.findByRole('dialog', { name: /refetch this posting/i });
    await user.click(within(dialog).getByRole('button', { name: /cancel/i }));
    expect(called).toBe(0);
  });

  it('shows "Confirmed by you" and an Undo button for a user confirmation (issue #250)', async () => {
    renderWithProviders(
      <PostingConfirmedStatus
        opp={opp({ postingState: 'confirmed', postingStateDetail: 'user_confirmed' })}
        onRefetch={() => {}}
      />,
    );
    expect(await screen.findByText(/confirmed by you/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /undo/i })).toBeInTheDocument();
    // A board match never shows Undo: there is nothing of the user's own to take back.
    expect(screen.queryByText(/matched on the company's board/i)).not.toBeInTheDocument();
  });

  it('Undo calls onUndo directly, with no confirm step of its own', async () => {
    const user = userEvent.setup();
    let called = 0;
    renderWithProviders(
      <PostingConfirmedStatus
        opp={opp({ postingState: 'confirmed', postingStateDetail: 'user_confirmed' })}
        onRefetch={() => {}}
        onUndo={() => {
          called += 1;
        }}
      />,
    );
    await user.click(await screen.findByRole('button', { name: /undo/i }));
    expect(called).toBe(1);
  });

  it('a board match offers no Undo: nothing of the user’s own to take back', async () => {
    renderWithProviders(
      <PostingConfirmedStatus opp={opp({ postingState: 'confirmed' })} onRefetch={() => {}} />,
    );
    await screen.findByRole('button', { name: /refetch/i });
    expect(screen.queryByRole('button', { name: /undo/i })).not.toBeInTheDocument();
  });
});

describe('RederiveFromCaptureAction (issue #264)', () => {
  it('shows nothing when there is no stored capture', async () => {
    renderWithProviders(
      <>
        <span data-testid="anchor" />
        <RederiveFromCaptureAction opp={opp({ hasCapturedPage: false })} onRederive={() => {}} />
      </>,
    );
    await screen.findByTestId('anchor');
    expect(screen.queryByRole('button', { name: /re-derive/i })).not.toBeInTheDocument();
  });

  it('offers the action whenever a capture is stored, regardless of posting state', async () => {
    renderWithProviders(
      <RederiveFromCaptureAction
        opp={opp({ hasCapturedPage: true, postingState: 'confirmed' })}
        onRederive={() => {}}
      />,
    );
    expect(
      await screen.findByRole('button', { name: /re-derive from capture/i }),
    ).toBeInTheDocument();
  });

  it('confirms before re-deriving, and only calls onRederive once confirmed', async () => {
    const user = userEvent.setup();
    let called = 0;
    renderWithProviders(
      <RederiveFromCaptureAction
        opp={opp({ hasCapturedPage: true })}
        onRederive={() => {
          called += 1;
        }}
      />,
    );
    await user.click(await screen.findByRole('button', { name: /re-derive from capture/i }));
    const dialog = await screen.findByRole('dialog', { name: /re-derive this description/i });
    expect(called).toBe(0);
    await user.click(within(dialog).getByRole('button', { name: /^re-derive$/i }));
    expect(called).toBe(1);
  });

  it('warns specifically when the current description is the user’s own writing', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RederiveFromCaptureAction
        opp={opp({ hasCapturedPage: true, descriptionIsUserWritten: true })}
        onRederive={() => {}}
      />,
    );
    await user.click(await screen.findByRole('button', { name: /re-derive from capture/i }));
    expect(await screen.findByText(/edited this description by hand/i)).toBeInTheDocument();
  });

  it('warns specifically about overriding a user confirmation (issue #250)', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RederiveFromCaptureAction
        opp={opp({
          hasCapturedPage: true,
          postingState: 'confirmed',
          postingStateDetail: 'user_confirmed',
        })}
        onRederive={() => {}}
      />,
    );
    await user.click(await screen.findByRole('button', { name: /re-derive from capture/i }));
    expect(await screen.findByText(/confirmed this posting yourself/i)).toBeInTheDocument();
  });

  it('cancel leaves things untouched: onRederive never fires', async () => {
    const user = userEvent.setup();
    let called = 0;
    renderWithProviders(
      <RederiveFromCaptureAction
        opp={opp({ hasCapturedPage: true })}
        onRederive={() => {
          called += 1;
        }}
      />,
    );
    await user.click(await screen.findByRole('button', { name: /re-derive from capture/i }));
    const dialog = await screen.findByRole('dialog', { name: /re-derive this description/i });
    await user.click(within(dialog).getByRole('button', { name: /cancel/i }));
    expect(called).toBe(0);
  });
});

describe('the Description card keeps a way to look the posting up', () => {
  it('offers the banner action once a description exists', async () => {
    // Before this branch the Find posting button rendered only while the description was
    // empty, which a capture makes permanently false.
    mockApi({
      'GET /opportunities/opp-1/attachments': { items: [], total: 0 },
      'POST /opportunities/opp-1/find-posting': { outcome: 'none', candidates: [] },
    });
    renderWithProviders(
      <DetailsPanel
        opp={opp({
          descriptionMd: 'the captured page text',
          postingState: 'needs_review',
          postingStateDetail: 'none_found',
        })}
      />,
    );
    expect(await screen.findByRole('button', { name: /look again/i })).toBeInTheDocument();
  });

  it('runs the search when the banner action is pressed', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /opportunities/opp-1/attachments': { items: [], total: 0 },
      'POST /opportunities/opp-1/find-posting': { outcome: 'none', candidates: [] },
    });
    renderWithProviders(
      <DetailsPanel
        opp={opp({
          descriptionMd: 'the captured page text',
          postingState: 'needs_review',
          postingStateDetail: 'ambiguous',
        })}
      />,
    );
    await user.click(await screen.findByRole('button', { name: /choose posting/i }));
    expect(
      calls.some((c) => c.method === 'POST' && c.path === '/opportunities/opp-1/find-posting'),
    ).toBe(true);
  });

  it('still offers Find posting on an opportunity with no description', async () => {
    mockApi({ 'GET /opportunities/opp-1/attachments': { items: [], total: 0 } });
    renderWithProviders(<DetailsPanel opp={opp()} />);
    expect(await screen.findByRole('button', { name: /find posting/i })).toBeInTheDocument();
  });

  it('offers Refetch on a confirmed opportunity, where the banner shows nothing (issue #255)', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /opportunities/opp-1/attachments': { items: [], total: 0 },
      'POST /opportunities/opp-1/find-posting': { outcome: 'none', candidates: [] },
    });
    renderWithProviders(
      <DetailsPanel
        opp={opp({
          descriptionMd: 'What We Do: cybercrime is growing.',
          postingState: 'confirmed',
        })}
      />,
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /refetch/i }));
    const dialog = await screen.findByRole('dialog', { name: /refetch this posting/i });
    await user.click(within(dialog).getByRole('button', { name: /refetch/i }));
    expect(await screen.findByText(/no close match on the board/i)).toBeInTheDocument();
    expect(
      calls.some((c) => c.method === 'POST' && c.path === '/opportunities/opp-1/find-posting'),
    ).toBe(true);
  });

  it('confirms a flagged posting from the banner (issue #250)', async () => {
    const user = userEvent.setup();
    const confirmed = opp({
      descriptionMd: 'the captured page text',
      postingState: 'confirmed',
      postingStateDetail: 'user_confirmed',
    });
    const { calls } = mockApi({
      'GET /opportunities/opp-1/attachments': { items: [], total: 0 },
      'POST /opportunities/opp-1/posting/confirm': confirmed,
    });
    renderWithProviders(
      <DetailsPanel
        opp={opp({
          descriptionMd: 'the captured page text',
          postingState: 'needs_review',
          postingStateDetail: 'none_found',
        })}
      />,
    );
    await user.click(await screen.findByRole('button', { name: /^confirm$/i }));
    expect(
      calls.some((c) => c.method === 'POST' && c.path === '/opportunities/opp-1/posting/confirm'),
    ).toBe(true);
    expect(await screen.findByText(/posting confirmed/i)).toBeInTheDocument();
  });

  it('offers Re-derive from capture whenever a capture is stored (issue #264)', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /opportunities/opp-1/attachments': { items: [], total: 0 },
      'POST /opportunities/opp-1/posting/rederive': {
        outcome: 'capture_only',
        opportunity: opp({
          descriptionMd: 'derived from the stored capture',
          hasCapturedPage: true,
        }),
      },
    });
    renderWithProviders(
      <DetailsPanel
        opp={opp({
          descriptionMd: 'What We Do: cybercrime is growing.',
          postingState: 'confirmed',
          hasCapturedPage: true,
        })}
      />,
    );
    await user.click(await screen.findByRole('button', { name: /re-derive from capture/i }));
    const dialog = await screen.findByRole('dialog', { name: /re-derive this description/i });
    await user.click(within(dialog).getByRole('button', { name: /^re-derive$/i }));
    expect(
      calls.some((c) => c.method === 'POST' && c.path === '/opportunities/opp-1/posting/rederive'),
    ).toBe(true);
    expect(await screen.findByText(/re-derived from the capture/i)).toBeInTheDocument();
  });

  it('says so, and changes nothing, when the capture carries no description', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /opportunities/opp-1/attachments': { items: [], total: 0 },
      'POST /opportunities/opp-1/posting/rederive': { outcome: 'no_description_found' },
    });
    renderWithProviders(
      <DetailsPanel
        opp={opp({
          descriptionMd: 'What We Do: cybercrime is growing.',
          postingState: 'confirmed',
          hasCapturedPage: true,
        })}
      />,
    );
    await user.click(await screen.findByRole('button', { name: /re-derive from capture/i }));
    const dialog = await screen.findByRole('dialog', { name: /re-derive this description/i });
    await user.click(within(dialog).getByRole('button', { name: /^re-derive$/i }));
    expect(await screen.findByText(/nothing to re-derive/i)).toBeInTheDocument();
    expect(screen.getByText('What We Do: cybercrime is growing.')).toBeInTheDocument();
  });

  it('undoes a user confirmation from the banner (issue #250)', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /opportunities/opp-1/attachments': { items: [], total: 0 },
      'POST /opportunities/opp-1/posting/unconfirm': opp({
        descriptionMd: 'the captured page text',
        postingState: 'needs_review',
        postingStateDetail: 'none_found',
      }),
    });
    renderWithProviders(
      <DetailsPanel
        opp={opp({
          descriptionMd: 'the captured page text',
          postingState: 'confirmed',
          postingStateDetail: 'user_confirmed',
        })}
      />,
    );
    await user.click(await screen.findByRole('button', { name: /undo/i }));
    expect(
      calls.some((c) => c.method === 'POST' && c.path === '/opportunities/opp-1/posting/unconfirm'),
    ).toBe(true);
  });
});
