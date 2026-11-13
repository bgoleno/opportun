// https://github.com/bgoleno/opportun/issues/491: a toast that names a user's title can hold one
// long unbroken token (a tailored copy's title, "Name-Company-role_slug"). It must break inside
// the toast. jsdom has no layout, so this checks the rule that allows the break; the width itself
// was checked live at 375 px (see the PR).
import { act, render, screen } from '@testing-library/react';
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
