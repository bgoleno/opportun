import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ThemeToggle } from '@/components/ThemeToggle';
import { ThemeProvider } from '@/lib/theme';
import { mockApi, renderWithProviders } from '@/test/render';

function render() {
  mockApi({ 'GET /settings/theme': { theme: 'auto' } });
  return renderWithProviders(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  );
}

describe('ThemeToggle (issue #138)', () => {
  it('shows a tooltip on hover, matching the button’s aria-label, without breaking the menu', async () => {
    render();
    const button = await screen.findByRole('button', { name: 'Theme: Auto (system)' });

    await userEvent.hover(button);
    expect(await screen.findByText('Theme: Auto (system)')).toBeInTheDocument();

    await userEvent.click(button);
    expect(await screen.findByRole('menu')).toBeInTheDocument();
  });
});
