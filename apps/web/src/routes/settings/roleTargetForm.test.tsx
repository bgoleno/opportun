import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RoleTargetForm, type RoleTargetPayload } from './-roleTargetForm';

async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Name'), 'Staff PM, platform');
  await user.type(screen.getByLabelText('Title family'), 'Product Manager');
}

const LADDER = [
  'Junior',
  'Mid-level',
  'Senior',
  'Staff',
  'Principal',
  'Distinguished',
  'Director',
  'Senior Director',
  'VP',
  'Executive',
];

function optionLabels(select: HTMLElement): string[] {
  return Array.from((select as HTMLSelectElement).options).map((o) => o.textContent ?? '');
}

describe('RoleTargetForm', () => {
  it('offers Any plus the named seniority ladder, with no free numeric entry', () => {
    render(<RoleTargetForm onSubmit={vi.fn()} submitLabel="Save" />);
    for (const label of ['Minimum seniority', 'Maximum seniority']) {
      const select = screen.getByLabelText(label);
      expect(select.tagName).toBe('SELECT');
      expect(optionLabels(select)).toEqual(['Any', ...LADDER]);
      expect(select).toHaveValue('');
    }
  });

  it('sends nulls when both ends are left on Any', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(p: RoleTargetPayload) => Promise<void>>().mockResolvedValue();
    render(<RoleTargetForm onSubmit={onSubmit} submitLabel="Save" />);
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ seniorityMin: null, seniorityMax: null });
  });

  it('keeps an off-ladder stored value selected as Level N', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(p: RoleTargetPayload) => Promise<void>>().mockResolvedValue();
    render(
      <RoleTargetForm
        submitLabel="Save"
        onSubmit={onSubmit}
        initial={{
          name: 'Legacy',
          titleFamily: 'Engineering',
          seniorityMin: 42,
          seniorityMax: null,
          industries: [],
          keywords: [],
          locations: [],
          remotePref: 'any',
          compMin: null,
          compMax: null,
          currency: null,
          active: true,
        }}
      />,
    );
    const min = screen.getByLabelText('Minimum seniority') as HTMLSelectElement;
    expect(min.selectedOptions[0]?.textContent).toBe('Level 42');
    expect(optionLabels(min)).toEqual(['Any', ...LADDER, 'Level 42']);
    expect(optionLabels(screen.getByLabelText('Maximum seniority'))).toEqual(['Any', ...LADDER]);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ seniorityMin: 42, seniorityMax: null });
  });

  it('rejects seniorityMin greater than seniorityMax without submitting', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<RoleTargetForm onSubmit={onSubmit} submitLabel="Save" />);
    await fillRequired(user);
    await user.selectOptions(screen.getByLabelText('Minimum seniority'), 'Distinguished');
    await user.selectOptions(screen.getByLabelText('Maximum seniority'), 'Staff');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const min = screen.getByLabelText('Minimum seniority');
    await waitFor(() => expect(min).toHaveAttribute('aria-invalid', 'true'));
    expect(screen.getByRole('alert')).toHaveTextContent(/minimum seniority/i);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits a valid payload in the API shape', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(p: RoleTargetPayload) => Promise<void>>().mockResolvedValue();
    render(<RoleTargetForm onSubmit={onSubmit} submitLabel="Save" />);
    await fillRequired(user);
    await user.selectOptions(screen.getByLabelText('Minimum seniority'), 'Staff');
    await user.selectOptions(screen.getByLabelText('Maximum seniority'), 'Principal');
    await user.type(screen.getByLabelText('Industries'), 'Developer tools, Security, ');
    await user.type(screen.getByLabelText('Keywords'), 'platform,  api');
    await user.type(screen.getByLabelText('Locations'), 'Seattle');
    await user.selectOptions(screen.getByLabelText('Work arrangement'), 'hybrid');
    // Typed the way a salary is written, commas and all.
    await user.type(screen.getByLabelText('Minimum compensation'), '200,000');
    await user.type(screen.getByLabelText('Currency'), 'usd');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({
      name: 'Staff PM, platform',
      titleFamily: 'Product Manager',
      seniorityMin: 4,
      seniorityMax: 5,
      industries: ['Developer tools', 'Security'],
      keywords: ['platform', 'api'],
      locations: ['Seattle'],
      remotePref: 'hybrid',
      compMin: 200000,
      compMax: null,
      currency: 'USD',
      active: true,
    });
  });

  it('allows an open-ended seniority range and prefills from an existing target', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(p: RoleTargetPayload) => Promise<void>>().mockResolvedValue();
    render(
      <RoleTargetForm
        submitLabel="Save"
        onSubmit={onSubmit}
        initial={{
          name: 'Director',
          titleFamily: 'Engineering Manager',
          seniorityMin: 7,
          seniorityMax: null,
          industries: ['Fintech'],
          keywords: [],
          locations: [],
          remotePref: 'remote',
          compMin: null,
          compMax: null,
          currency: null,
          active: false,
        }}
      />,
    );
    expect(screen.getByLabelText('Name')).toHaveValue('Director');
    expect(screen.getByLabelText('Active')).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      seniorityMin: 7,
      seniorityMax: null,
      industries: ['Fintech'],
      remotePref: 'remote',
      active: false,
    });
  });

  it('requires name and title family', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<RoleTargetForm onSubmit={onSubmit} submitLabel="Save" />);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
