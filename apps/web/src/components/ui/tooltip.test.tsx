import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

function renderTooltip() {
  render(
    <Tooltip>
      <TooltipTrigger>Trigger</TooltipTrigger>
      <TooltipContent>Explanation</TooltipContent>
    </Tooltip>,
  );
  return screen.getByText('Trigger');
}

describe('Tooltip', () => {
  it('shows its content on hover', async () => {
    const user = userEvent.setup();
    const trigger = renderTooltip();
    expect(screen.queryByText('Explanation')).not.toBeInTheDocument();
    await user.hover(trigger);
    expect(await screen.findByText('Explanation')).toBeInTheDocument();
  });

  it('#138: shows its content on keyboard focus, not only on hover (the reason to prefer this over a title attribute)', async () => {
    const user = userEvent.setup();
    renderTooltip();
    expect(screen.queryByText('Explanation')).not.toBeInTheDocument();
    await user.tab();
    expect(await screen.findByText('Explanation')).toBeInTheDocument();
  });
});
