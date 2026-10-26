import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AlertSendersList, looksLikeAddress } from './AlertSenders';

const DEFAULTS = ['jobalerts-noreply@linkedin.com', 'alert@indeed.com'];

const props = {
  senders: [...DEFAULTS],
  usingDefaults: true,
  defaults: DEFAULTS,
  saving: false,
  onAdd: vi.fn(),
  onRemove: vi.fn(),
  onResetToDefaults: vi.fn(),
};

describe('looksLikeAddress', () => {
  it('accepts an ordinary address and rejects the obvious non-addresses', () => {
    expect(looksLikeAddress('alerts@example.com')).toBe(true);
    expect(looksLikeAddress('x')).toBe(false);
    expect(looksLikeAddress('no-at-sign.example.com')).toBe(false);
    expect(looksLikeAddress('a@b.com, c@d.com')).toBe(false);
    expect(looksLikeAddress('  ')).toBe(false);
  });
});

describe('AlertSendersList', () => {
  it('says it is using the defaults, and offers no reset when it is', () => {
    render(<AlertSendersList {...props} />);

    expect(screen.getByTestId('alert-senders-status')).toHaveTextContent(/built-in defaults/i);
    expect(screen.queryByRole('button', { name: /reset to defaults/i })).toBeNull();
  });

  it('says a custom list is saved once the user has configured one', () => {
    render(<AlertSendersList {...props} usingDefaults={false} senders={['own@example.com']} />);

    expect(screen.getByTestId('alert-senders-status')).toHaveTextContent(/custom list/i);
    expect(screen.getByRole('button', { name: /reset to defaults/i })).toBeInTheDocument();
  });

  it('distinguishes an explicit empty list from not having configured anything', () => {
    // Principle 6: these are two different states, not the same screen with fewer rows.
    render(<AlertSendersList {...props} usingDefaults={false} senders={[]} />);

    expect(screen.getByTestId('alert-senders-status')).toHaveTextContent(/match nothing/i);
    expect(screen.getByText('No senders configured.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reset to defaults/i })).toBeInTheDocument();
  });

  it('lists each sender with a way to remove it', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(<AlertSendersList {...props} onRemove={onRemove} senders={['own@example.com']} />);

    expect(screen.getByText('own@example.com')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove own@example.com' }));

    expect(onRemove).toHaveBeenCalledWith('own@example.com');
  });

  it('adds an address once it looks like one, lowercased and trimmed client-side too', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(<AlertSendersList {...props} onAdd={onAdd} />);

    const input = screen.getByLabelText('Add an alert sender address');
    const add = screen.getByRole('button', { name: 'Add' });
    expect(add).toBeDisabled();

    await user.type(input, '  Alerts@Example.com  ');
    expect(add).not.toBeDisabled();
    await user.click(add);

    expect(onAdd).toHaveBeenCalledWith('alerts@example.com');
    expect(input).toHaveValue('');
  });

  it('disables every action while saving', () => {
    render(
      <AlertSendersList {...props} saving usingDefaults={false} senders={['own@example.com']} />,
    );

    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove own@example.com' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /reset to defaults/i })).toBeDisabled();
  });
});
