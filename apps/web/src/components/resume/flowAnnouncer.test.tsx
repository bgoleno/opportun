// The resume flow's live region (https://github.com/bgoleno/opportun/issues/596): each message is
// a new node, so a repeat is said again, and the region empties once it has been said.
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANNOUNCE_CLEAR_MS, FlowAnnouncement, useFlowAnnouncer } from './flowAnnouncer';

let say: (text: string) => void = () => {};

function Harness() {
  const announcer = useFlowAnnouncer();
  say = announcer.announce;
  return <FlowAnnouncement value={announcer.value} />;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the resume flow live region (#596)', () => {
  it('says a message, and the same message again as a new node', () => {
    render(<Harness />);
    const live = screen.getByRole('status');
    act(() => say('Marked final. Next: apply.'));
    const first = live.firstElementChild;
    expect(live).toHaveTextContent('Marked final. Next: apply.');

    act(() => say('Marked final. Next: apply.'));
    expect(live).toHaveTextContent('Marked final. Next: apply.');
    // A new node: a screen reader is told of an addition, not an unchanged text.
    expect(live.firstElementChild).not.toBe(first);
  });

  it('empties once the message has had time to be said', () => {
    render(<Harness />);
    const live = screen.getByRole('status');
    act(() => say('Recorded as sent. Nothing more to do here.'));
    act(() => vi.advanceTimersByTime(ANNOUNCE_CLEAR_MS - 1));
    expect(live).toHaveTextContent('Recorded as sent. Nothing more to do here.');
    act(() => vi.advanceTimersByTime(1));
    expect(live).toHaveTextContent('');
  });

  it("a new message restarts the wait: the second is not cut short by the first one's timer", () => {
    render(<Harness />);
    const live = screen.getByRole('status');
    act(() => say('Sending Jane base as it is. Next: mark it as final.'));
    act(() => vi.advanceTimersByTime(ANNOUNCE_CLEAR_MS - 10));
    act(() => say('Back to choosing a resume. Next: create a tailored copy.'));
    act(() => vi.advanceTimersByTime(10));
    expect(live).toHaveTextContent('Back to choosing a resume. Next: create a tailored copy.');
  });
});
