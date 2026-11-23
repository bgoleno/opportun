import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Select } from './select';

describe('Select (#909)', () => {
  const draw = (className?: string) => {
    render(
      <Select aria-label="Kind" className={className}>
        <option>One</option>
      </Select>,
    );
    const select = screen.getByRole('combobox', { name: 'Kind' });
    return { select, wrapper: select.parentElement! };
  };

  // The chevron is placed against the wrapper, so the wrapper is what a width sizes.
  // e2e/selectChevron.spec.ts measures it.
  it('gives a set width to the wrapper, which the select fills', () => {
    const { select, wrapper } = draw('w-full sm:w-40');
    expect(wrapper).toHaveClass('sm:w-40', 'w-full');
    expect(select).toHaveClass('w-full');
    expect(select).not.toHaveClass('sm:w-40');
  });

  it('a set width replaces the full width', () => {
    expect(draw('w-48').wrapper).not.toHaveClass('w-full');
  });

  it('fills its container with no width of its own', () => {
    expect(draw().wrapper).toHaveClass('w-full');
  });
});
