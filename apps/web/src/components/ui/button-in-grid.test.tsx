// https://github.com/bgoleno/opportun/issues/9: a <Button> that is a grid item stretches to the
// column width. These run the repo's real eslint.config.js, not the rule in isolation, so they
// also fail if the rule is unwired, narrowed to the wrong files, or shadowed by a later block.
import { render, screen } from '@testing-library/react';
import { ESLint } from 'eslint';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Button } from './button';
import { Collapsible, CollapsibleTrigger } from './collapsible';
import { DropdownMenu, DropdownMenuTrigger } from './dropdown-menu';
import { Tooltip, TooltipTrigger } from './tooltip';

const RULE = 'opportun/no-stretched-grid-button';
// import.meta.dirname, not new URL('..', import.meta.url): under jsdom, URL is jsdom's, which
// resolves against the document's http://localhost base instead of the file.
const repoRoot = resolve(import.meta.dirname, '../../../../..');
const eslint = new ESLint({ cwd: repoRoot });

/** Lines the rule reports for `jsx`, placed inside a component in an apps/web/src .tsx file. */
async function reportedLines(jsx: string): Promise<number[]> {
  const code = `export function Fixture({ on, items }: { on: boolean; items: string[] }) {\n  return (\n${jsx}\n  );\n}\n`;
  const [result] = await eslint.lintText(code, {
    filePath: join(repoRoot, 'apps/web/src/components/lint-fixture.tsx'),
  });
  // A fixture that fails to parse reports nothing, which would read as "the rule stayed silent".
  const fatal = result?.messages.find((m) => m.fatal);
  if (fatal) throw new Error(`fixture did not parse: ${fatal.message}`);
  const hits = result?.messages.filter((m) => m.ruleId === RULE) ?? [];
  for (const m of hits) expect(m.severity).toBe(2);
  // Line 1 is the function signature and line 2 is `return (`, so the fixture starts on line 3.
  return hits.map((m) => m.line - 2);
}

describe('no-stretched-grid-button', () => {
  it.each([
    ['as a direct child of a grid', '<div className="grid gap-4">\n<Button>Save</Button>\n</div>'],
    ['behind && in a grid', '<div className="grid gap-4">\n{on && <Button>Save</Button>}\n</div>'],
    [
      'in a ternary in a grid',
      '<div className="grid gap-4">\n{on ? null : (\n<Button>Save</Button>\n)}\n</div>',
    ],
    [
      'in a fragment in nested ternaries in a grid',
      '<div className="grid gap-4">\n{on ? null : on ? null : (\n<>\n<Button>Save</Button>\n</>\n)}\n</div>',
    ],
    [
      'returned from a .map callback in a grid',
      '<div className="grid gap-2">\n{items.map((i) => (\n<Button key={i}>{i}</Button>\n))}\n</div>',
    ],
    [
      'in a keyed Fragment from a .map callback in a grid',
      '<div className="grid gap-2">\n{items.map((i) => (\n<Fragment key={i}>\n<Button>{i}</Button>\n</Fragment>\n))}\n</div>',
    ],
    [
      'inside an asChild trigger in a Tooltip in a grid',
      '<div className="grid gap-2">\n<Tooltip>\n<TooltipTrigger asChild>\n<Button>Save</Button>\n</TooltipTrigger>\n</Tooltip>\n</div>',
    ],
    [
      'in a CardContent grid',
      '<CardContent className="grid gap-4">\n<Button>Save</Button>\n</CardContent>',
    ],
    [
      'in a responsive grid',
      '<form className="flex gap-2 sm:grid">\n<Button>Save</Button>\n</form>',
    ],
    ['in an inline-grid', '<div className="inline-grid gap-2">\n<Button>Save</Button>\n</div>'],
    [
      'in a grid built with cn()',
      "<div className={cn('grid gap-2', on && 'p-2')}>\n<Button>Save</Button>\n</div>",
    ],
    [
      'in a grid built with a template literal',
      "<div className={`grid gap-2 ${on ? 'p-2' : ''}`}>\n<Button>Save</Button>\n</div>",
    ],
    [
      'in a grid, with classes that do not constrain its width',
      '<div className="grid gap-2">\n<Button className="gap-1.5 px-2 w-auto justify-self-stretch">Save</Button>\n</div>',
    ],
  ])('reports a bare Button %s', async (_shape, jsx) => {
    const lines = await reportedLines(jsx);
    const buttonLine = jsx.split('\n').findIndex((l) => l.includes('<Button')) + 1;
    expect(buttonLine).toBeGreaterThan(0);
    expect(lines).toEqual([buttonLine]);
  });

  it.each([
    'w-fit',
    'w-full',
    'w-32',
    'max-w-xs',
    'size-9',
    'justify-self-start',
    'place-self-center',
    'ml-auto',
    'mx-auto',
    'sm:w-fit',
  ])('accepts a grid Button whose className states its width with %s', async (cls) => {
    expect(
      await reportedLines(
        `<div className="grid gap-4">\n<Button className="${cls}">Save</Button>\n</div>`,
      ),
    ).toEqual([]);
  });

  it('accepts a grid Button whose width cn() states', async () => {
    expect(
      await reportedLines(
        "<div className=\"grid gap-4\">\n<Button className={cn('w-fit', on && 'px-2')}>Save</Button>\n</div>",
      ),
    ).toEqual([]);
  });

  it('accepts an icon-sized Button, whose size variant fixes its width', async () => {
    expect(
      await reportedLines('<div className="grid gap-4">\n<Button size="icon">X</Button>\n</div>'),
    ).toEqual([]);
  });

  it.each(['justify-items-start', 'place-items-center'])(
    'accepts a bare Button in a grid that stops stretching its items with %s',
    async (cls) => {
      expect(
        await reportedLines(`<div className="grid gap-4 ${cls}">\n<Button>Save</Button>\n</div>`),
      ).toEqual([]);
    },
  );

  it.each([
    ['a flex row', '<div className="flex gap-2">\n<Button>Save</Button>\n</div>'],
    [
      'grid-cols without grid',
      '<div className="grid-cols-2 gap-2">\n<Button>Save</Button>\n</div>',
    ],
    [
      'a CardHeader overridden to flex at the call site',
      '<CardHeader className="flex flex-wrap items-start justify-between gap-4">\n<Button>Save</Button>\n</CardHeader>',
    ],
    [
      'a Collapsible in a grid (it renders its own div)',
      '<div className="grid gap-4">\n<Collapsible>\n<CollapsibleTrigger asChild>\n<Button>Show</Button>\n</CollapsibleTrigger>\n</Collapsible>\n</div>',
    ],
    [
      'a non-grid element nested in a grid',
      '<div className="grid gap-4">\n<div className="flex">\n<Button>Save</Button>\n</div>\n</div>',
    ],
    [
      // The prop's owner is itself a grid: where it puts the prop is its own business.
      'a prop of a grid element',
      '<Section className="grid gap-4" actions={<Button>Save</Button>} />',
    ],
    ['nothing (a component returning it)', '<Button>Save</Button>'],
  ])('accepts a bare Button in %s', async (_shape, jsx) => {
    expect(await reportedLines(jsx)).toEqual([]);
  });
});

// The rule looks through Tooltip and DropdownMenu, and through any asChild element, to find a
// Button's grid parent, and does not look through Collapsible. That is only right while these
// render the DOM below; if a Radix upgrade changes it, the rule's list must change with it.
// The "grid" div has no grid class: jsdom applies no CSS, and parentage is all that is tested.
describe('wrappers the rule looks through', () => {
  it('Tooltip and DropdownMenu with an asChild trigger leave the Button a child of the grid', () => {
    render(
      <div data-testid="grid">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button>Tip</Button>
          </TooltipTrigger>
        </Tooltip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button>Menu</Button>
          </DropdownMenuTrigger>
        </DropdownMenu>
      </div>,
    );
    const grid = screen.getByTestId('grid');
    expect(screen.getByRole('button', { name: 'Tip' }).parentElement).toBe(grid);
    expect(screen.getByRole('button', { name: 'Menu' }).parentElement).toBe(grid);
  });

  it('Collapsible puts its own element between the grid and the Button', () => {
    render(
      <div data-testid="grid">
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button>Show</Button>
          </CollapsibleTrigger>
        </Collapsible>
      </div>,
    );
    const button = screen.getByRole('button', { name: 'Show' });
    expect(button.parentElement).not.toBe(screen.getByTestId('grid'));
    expect(button.parentElement?.parentElement).toBe(screen.getByTestId('grid'));
  });
});
