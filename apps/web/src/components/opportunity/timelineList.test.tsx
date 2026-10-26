import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimelineItem } from '@/lib/opportunities';
import { mockApi, renderWithProviders } from '@/test/render';
import { TimelineList } from './TimelineList';

const NOW = Date.now();

// jsdom performs no real layout, so scrollHeight/clientHeight are always 0. Approximate what
// a browser would measure from the rendered text length, capped at the component's collapsed
// clamp height, so a long and a short fixture exercise the overflow/no-overflow branches the
// same way real layout would.
const CLAMP_PX = 224; // matches TimelineList's 14rem collapsed height at a 16px root font size

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return (this.textContent ?? '').length * 2;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return Math.min((this.textContent ?? '').length * 2, CLAMP_PX);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function activity(overrides: Partial<TimelineItem> = {}): TimelineItem {
  return {
    kind: 'activity',
    id: 'act-1',
    opportunityId: 'opp-1',
    opportunityTitle: 'Staff PM',
    occurredAt: NOW,
    activityKind: 'note',
    title: 'Note',
    bodyMd: 'Short note.',
    participants: [],
    externalUrl: null,
    ...overrides,
  } as TimelineItem;
}

const LONG_BODY = Array.from(
  { length: 20 },
  (_, i) => `Paragraph ${i} of the captured posting, long enough to run well past the fold.`,
).join('\n\n');

function setup(items: TimelineItem[]) {
  const api = mockApi({
    'GET /opportunities/opp-1/timeline': { items, total: items.length },
  });
  const user = userEvent.setup();
  renderWithProviders(<TimelineList opportunityId="opp-1" />);
  return { api, user };
}

describe('TimelineList activity body (issue #236)', () => {
  it('clamps a long captured page behind a "Show more" control', async () => {
    setup([
      activity({
        id: 'act-long',
        activityKind: 'capture',
        title: 'Captured page',
        bodyMd: LONG_BODY,
      }),
    ]);
    const button = await screen.findByRole('button', { name: /show more/i });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    const bodyId = button.getAttribute('aria-controls');
    expect(bodyId).toBeTruthy();
    expect(document.getElementById(bodyId as string)).toHaveTextContent(/Paragraph 0/);
  });

  it('shows no control at all for a short note', async () => {
    setup([activity({ id: 'act-short', bodyMd: 'Went well, moving to onsite.' })]);
    await screen.findByText('Went well, moving to onsite.');
    expect(screen.queryByRole('button', { name: /show (more|less)/i })).toBeNull();
  });

  it('expands and collapses on click, flipping aria-expanded both ways', async () => {
    const { user } = setup([
      activity({ id: 'act-long', activityKind: 'capture', bodyMd: LONG_BODY }),
    ]);
    const more = await screen.findByRole('button', { name: /show more/i });
    await user.click(more);

    const less = screen.getByRole('button', { name: /show less/i });
    expect(less).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/Paragraph 0/)).toBeVisible();

    await user.click(less);
    expect(screen.getByRole('button', { name: /show more/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('is reachable and operable by keyboard', async () => {
    const { user } = setup([
      activity({ id: 'act-long', activityKind: 'capture', bodyMd: LONG_BODY }),
    ]);
    const more = await screen.findByRole('button', { name: /show more/i });
    more.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: /show less/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    screen.getByRole('button', { name: /show less/i }).focus();
    await user.keyboard(' ');
    expect(screen.getByRole('button', { name: /show more/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });
});
