import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { GmailLookbackField } from './-gmailLookback';

describe('GmailLookbackField', () => {
  it('shows the current window and saves a changed valid value', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<GmailLookbackField value={180} saving={false} onSave={onSave} />);
    const input = screen.getByLabelText('How far back to read (days)');
    expect(input).toHaveValue('180');
    const button = screen.getByRole('button', { name: 'Save window' });
    expect(button).toBeDisabled(); // unchanged value
    await user.clear(input);
    await user.type(input, '60');
    expect(button).toBeEnabled();
    await user.click(button);
    expect(onSave).toHaveBeenCalledWith(60);
  });

  it('says the window governs every channel, not only the Gmail sync', () => {
    // Issue #53: the same window bounds a LinkedIn export import, and a user who reads this as
    // "Gmail only" would not know why most of their archive did not arrive.
    render(<GmailLookbackField value={180} saving={false} onSave={vi.fn()} />);
    expect(screen.getByText(/everything Opportun reads/i)).toBeInTheDocument();
    expect(screen.getByText(/linkedin export/i)).toBeInTheDocument();
  });

  it('refuses out-of-range or junk values', async () => {
    const user = userEvent.setup();
    render(<GmailLookbackField value={180} saving={false} onSave={vi.fn()} />);
    const input = screen.getByLabelText('How far back to read (days)');
    const button = screen.getByRole('button', { name: 'Save window' });
    for (const bad of ['0', '1096', 'abc', '']) {
      await user.clear(input);
      if (bad !== '') await user.type(input, bad);
      expect(button, bad).toBeDisabled();
    }
  });

  it('a hand-edited query shows a note instead of the field', () => {
    render(<GmailLookbackField value={null} saving={false} onSave={vi.fn()} />);
    expect(screen.getByTestId('gmail-lookback-custom')).toHaveTextContent(/hand-edited/);
    expect(screen.queryByLabelText('How far back to read (days)')).toBeNull();
  });
});
