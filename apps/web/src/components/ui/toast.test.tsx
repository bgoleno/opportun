// https://github.com/bgoleno/opportun/issues/491: a toast that names a user's title can hold one
// long unbroken token (a tailored copy's title, "Name-Company-role_slug"). It must break inside
// the toast. jsdom has no layout, so this checks the rule that allows the break; the width itself
// was checked live at 375 px (see the PR).
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Toaster, toast } from './toast';

const LONG =
  'Jane Example-Northwind Labs International-staff_platform_engineer_developer_infrastructure';

describe('Toaster: a long unbroken token breaks inside the toast (#491)', () => {
  afterEach(() => {
    // Toasts live in a module-level store; close what this test opened.
    for (const close of screen.queryAllByRole('button', { name: 'Dismiss notification' })) {
      act(() => close.click());
    }
  });

  it('in the description and in the title', async () => {
    render(<Toaster />);
    act(() => toast({ title: `Removed ${LONG}`, description: LONG, variant: 'success' }));
    const description = await screen.findByText(LONG);
    const title = screen.getByText(`Removed ${LONG}`);
    for (const el of [description, title]) {
      expect(el.className).toContain('[overflow-wrap:anywhere]');
    }
    // The text column may shrink below its content's width, so the break can happen.
    expect(description.parentElement?.className).toContain('min-w-0');
  });
});

// https://github.com/bgoleno/opportun/issues/1014: Radix's wrapper has pointer-events: none until it has
// counted a toast, a task after the toast is drawn. What is read here is the moment it is drawn.
describe('Toaster: a toast takes the pointer from its first drawing on (#1014)', () => {
  it('its action, its close button and its text', async () => {
    render(<Toaster />);
    const wrapper = screen.getByRole('region', { name: /^Notifications/ });
    const drawn: string[] = [];
    const observer = new MutationObserver(() => {
      const li = wrapper.querySelector('li');
      if (li === null || drawn.length > 0) return;
      // The wrapper does not take it yet: otherwise this reads some later moment.
      drawn.push(`wrapper ${getComputedStyle(wrapper).pointerEvents}`);
      for (const el of [li, ...li.querySelectorAll('button')])
        drawn.push(`${el.tagName.toLowerCase()} ${getComputedStyle(el).pointerEvents}`);
    });
    observer.observe(wrapper, { childList: true, subtree: true });
    toast({ title: 'Dismissed', action: { label: 'Undo', onClick: () => undefined } });
    await waitFor(() => expect(drawn).not.toEqual([]));
    observer.disconnect();
    expect(drawn).toEqual(['wrapper none', 'li auto', 'button auto', 'button auto']);
    act(() => screen.getByRole('button', { name: 'Dismiss notification' }).click());
    await waitFor(() => expect(wrapper.querySelector('li')).toBeNull());
    await waitFor(() => expect(getComputedStyle(wrapper).pointerEvents).toBe('none'));
  });
});
