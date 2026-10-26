import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { ShortcutsOverlay } from './ShortcutsOverlay';

describe('ShortcutsOverlay', () => {
  it('opens on ? and lists the shortcuts each screen currently has', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShortcutsOverlay />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.keyboard('?');
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(dialog).getByText('Discovery review queue')).toBeInTheDocument();
    expect(within(dialog).getByText('Decided results')).toBeInTheDocument();
    expect(within(dialog).getByText('Pipeline')).toBeInTheDocument();
    expect(within(dialog).getByText('Contacts')).toBeInTheDocument();
  });

  it('lists the board keyboard reorder, issue #240', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShortcutsOverlay />);
    await user.keyboard('?');
    const dialog = await screen.findByRole('dialog');
    const group = within(dialog).getByText('Pipeline').closest('div');
    expect(group).not.toBeNull();
    expect(
      within(group as HTMLElement).getByText('Space, then ↑ / ↓, then Space'),
    ).toBeInTheDocument();
  });

  it('lists paging through contacts, issue #207', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShortcutsOverlay />);
    await user.keyboard('?');
    const dialog = await screen.findByRole('dialog');
    const group = within(dialog).getByText('Contacts').closest('div');
    expect(group).not.toBeNull();
    expect(within(group as HTMLElement).getByText('n / p')).toBeInTheDocument();
    expect(within(group as HTMLElement).getByText('Next or previous page')).toBeInTheDocument();
    expect(within(group as HTMLElement).getByText('Home / End')).toBeInTheDocument();
  });

  it('lists each surface under its own heading, so a shortcut never reads as universal', async () => {
    // j/k/i/x/Enter exist on both the review queue and the pipeline with different meanings
    // (i accepts a discovery result, interested marks a pipeline opportunity); grouping by
    // screen is what keeps "a shortcut that only works here" from reading as "everywhere".
    const user = userEvent.setup();
    renderWithProviders(<ShortcutsOverlay />);
    await user.keyboard('?');
    const dialog = await screen.findByRole('dialog');
    const queueGroup = within(dialog).getByText('Discovery review queue').closest('div');
    const pipelineGroup = within(dialog).getByText('Pipeline').closest('div');
    expect(queueGroup).not.toBeNull();
    expect(pipelineGroup).not.toBeNull();
    expect(within(queueGroup as HTMLElement).getByText(/posting/i)).toBeInTheDocument();
    expect(within(pipelineGroup as HTMLElement).queryByText(/posting/i)).not.toBeInTheDocument();
    expect(within(pipelineGroup as HTMLElement).getByText(/interested/i)).toBeInTheDocument();
  });

  it("closes with the dialog's own close button", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShortcutsOverlay />);
    await user.keyboard('?');
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not open while focus is in a text field', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <input aria-label="Some field" />
        <ShortcutsOverlay />
      </>,
    );
    await user.click(await screen.findByLabelText('Some field'));
    await user.keyboard('?');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
