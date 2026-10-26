import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Trash2 } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { IconButton } from './icon-button';

describe('IconButton', () => {
  it('#138: the tooltip text is exactly the aria-label, since both come from one label prop', async () => {
    const user = userEvent.setup();
    render(
      <IconButton label="Delete resume" onClick={vi.fn()}>
        <Trash2 aria-hidden="true" />
      </IconButton>,
    );
    const button = screen.getByRole('button', { name: 'Delete resume' });
    expect(
      screen.queryByText('Delete resume', { selector: '[data-slot="tooltip-content"]' }),
    ).not.toBeInTheDocument();
    await user.hover(button);
    expect(
      await screen.findByText('Delete resume', { selector: '[data-slot="tooltip-content"]' }),
    ).toBeInTheDocument();
  });

  it('shows the tooltip on keyboard focus, not only on hover', async () => {
    const user = userEvent.setup();
    render(
      <IconButton label="Detach resume">
        <Trash2 aria-hidden="true" />
      </IconButton>,
    );
    await user.tab();
    expect(
      await screen.findByText('Detach resume', { selector: '[data-slot="tooltip-content"]' }),
    ).toBeInTheDocument();
  });

  it('forwards variant, onClick, and other button props', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <IconButton label="Purge" variant="destructive" onClick={onClick}>
        <Trash2 aria-hidden="true" />
      </IconButton>,
    );
    const button = screen.getByRole('button', { name: 'Purge' });
    expect(button.className).toContain('destructive');
    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
