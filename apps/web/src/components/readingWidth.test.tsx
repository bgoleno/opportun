// https://github.com/bgoleno/opportun/issues/34: running text wraps at reading width (max-w-prose,
// 65ch), set once in the shared components that render it rather than at each call site, and
// every main-plus-rail layout uses the one rail width (--container-rail). jsdom does no layout,
// so these pin the classes; e2e/desktop.spec.ts measures the real line lengths in a browser.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FormField } from './FormField';
import { MainWithRail } from './MainWithRail';
import { Markdown } from './Markdown';
import { CardDescription } from './ui/card';

describe('reading width, set once in the shared components', () => {
  it('a card description wraps at reading width', () => {
    render(<CardDescription>Keys are encrypted at rest.</CardDescription>);
    expect(screen.getByText('Keys are encrypted at rest.')).toHaveClass('max-w-prose');
  });

  it("a form field's help text wraps at reading width", () => {
    render(
      <FormField label="Label" hint="Placeholders: displayName, company.">
        {(control) => <input {...control} />}
      </FormField>,
    );
    expect(screen.getByText('Placeholders: displayName, company.')).toHaveClass('max-w-prose');
  });

  it('a rendered Markdown block wraps at reading width without a class from the caller', () => {
    render(<Markdown>{'A paragraph of the job description.'}</Markdown>);
    const block = screen.getByText('A paragraph of the job description.').closest('.markdown');
    expect(block).toHaveClass('max-w-prose');
  });
});

describe('MainWithRail', () => {
  it('puts the rail at the --container-rail token from lg, and stacks below it', () => {
    render(
      <MainWithRail>
        <div>main</div>
        <div>rail</div>
      </MainWithRail>,
    );
    const grid = screen.getByText('main').parentElement;
    expect(grid).toHaveAttribute('data-slot', 'main-with-rail');
    expect(grid).toHaveClass(
      'grid',
      'grid-cols-1',
      'lg:grid-cols-[minmax(0,1fr)_var(--container-rail)]',
    );
  });
});
