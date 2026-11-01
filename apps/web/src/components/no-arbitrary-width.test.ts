// https://github.com/bgoleno/opportun/issues/37: widths come from the layout tokens, and an
// arbitrary width value outside components/ui/ fails lint. Like button-in-grid.test.tsx, these run
// the repo's real eslint.config.js, not the rule in isolation, so they also fail if the rule is
// unwired, narrowed to the wrong files, or shadowed by a later block, and they check that the
// config change left the existing custom rule and the unused-directive report working.
import { ESLint } from 'eslint';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const RULE = 'opportun/no-arbitrary-width';
// import.meta.dirname, not new URL('..', import.meta.url): under jsdom, URL is jsdom's, which
// resolves against the document's http://localhost base instead of the file.
const repoRoot = resolve(import.meta.dirname, '../../../..');
const eslint = new ESLint({ cwd: repoRoot });

/** All messages for `code` linted as the apps/web file at `path` (relative to apps/web). */
async function lint(code: string, path = 'src/components/lint-fixture.tsx') {
  const [result] = await eslint.lintText(code, { filePath: join(repoRoot, 'apps/web', path) });
  // A fixture that fails to parse reports nothing, which would read as "the rule stayed silent".
  const fatal = result?.messages.find((m) => m.fatal);
  if (fatal) throw new Error(`fixture did not parse: ${fatal.message}`);
  return result?.messages ?? [];
}

/** `jsx` placed inside a component, as a view would write it. */
const component = (jsx: string) =>
  `import { cn } from '@/lib/utils';\nexport function Fixture({ on }: { on: boolean }) {\n  return (\n${jsx}\n  );\n}\n`;

const hits = async (code: string, path?: string) =>
  (await lint(code, path)).filter((m) => m.ruleId === RULE);

describe('no-arbitrary-width', () => {
  it.each([
    ['max-w-[70ch]', '<p className="max-w-[70ch] text-sm">Running text</p>'],
    ['w-[37rem]', '<div className="w-[37rem]">Panel</div>'],
    ['grid-cols-[1fr_21rem]', '<div className="grid gap-6 lg:grid-cols-[1fr_21rem]" />'],
  ])('fails a new %s, naming the tokens and the design doc section', async (utility, jsx) => {
    const found = await hits(component(jsx));
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe(2);
    const message = found[0]?.message ?? '';
    expect(message).toContain(utility);
    for (const token of ['max-w-prose', 'max-w-page', 'w-rail', 'w-chat']) {
      expect(message).toContain(token);
    }
    expect(message).toContain('docs/design.md section 9, "Layout widths"');
  });

  // The boundary agreed with tl on https://github.com/bgoleno/opportun/pull/64. Tailwind 4's
  // numeric steps take any number (calc(var(--spacing) * n)), so max-w-160 is a 40rem width
  // without brackets. Above 96 (24rem, the top of Tailwind's documented spacing scale) a numeric
  // width step is reported; up to 96, and the named container sizes, pass (below).
  it.each([
    ['max-w-160', '<div className="max-w-160" />'],
    ['w-97', '<div className="w-97" />'],
    ['md:max-w-120', '<div className="md:max-w-120" />'],
    ['!w-120', '<div className="!w-120" />'],
    ['min-w-100', '<div className="sm:min-w-100" />'],
    ['basis-120', '<div className="basis-120" />'],
    ['w-96.5', '<div className="w-96.5" />'],
  ])('fails a numeric width step above 96, %s', async (utility, jsx) => {
    const found = await hits(component(jsx));
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe(2);
    expect(found[0]?.message).toContain(utility);
    expect(found[0]?.message).toContain('numeric step');
    expect(found[0]?.message).toContain('docs/design.md section 9, "Layout widths"');
  });

  it.each([
    ['w-96', 'the largest numeric step that passes'],
    ['w-64', 'a component width'],
    ['w-4', 'an icon'],
    ['size-4', 'a square'],
    ['max-w-md', 'a named container size'],
    ['max-w-3xl', 'a named container size (the stacked chat cap)'],
    ['max-w-7xl', 'the largest named container size'],
    ['w-1/2', 'a fraction'],
    ['basis-1/3', 'a fraction'],
    ['w-full', 'a keyword'],
    ['w-screen', 'a keyword'],
    ['grid-cols-3', 'a column count, not a width'],
  ])('passes %s (%s)', async (utility) => {
    expect(await hits(component(`<div className="${utility}" />`))).toEqual([]);
  });

  it.each([
    ['the reading width', '<p className="max-w-prose text-sm">Running text</p>'],
    ['the page cap', '<div className="mx-auto w-full max-w-page" />'],
    ['the rail and chat widths', '<aside className="w-rail lg:w-chat" />'],
    [
      'a grid track that is a token',
      '<div className="grid lg:grid-cols-[minmax(0,1fr)_var(--container-rail)]" />',
    ],
    ['a column split with no length', '<dl className="grid grid-cols-[auto_1fr]" />'],
    ['the card grid utility', '<ul className="grid grid-cards gap-2" />'],
    ['a fixed square, not a width', '<span className="size-[18px]" />'],
  ])('passes %s', async (_case, jsx) => {
    expect(await hits(component(jsx))).toEqual([]);
  });

  it.each([
    ['under a variant prefix', '<div className="md:max-w-[70ch]" />'],
    ['with the important marker', '<div className="!w-[37rem]" />'],
    ['as an arbitrary property', '<div className="[max-width:70ch]" />'],
    ['in a cn() call', "<div className={cn('grid', on && 'w-[37rem]')} />"],
    ['in a conditional', "<div className={on ? 'w-full' : 'w-[37rem]'} />"],
    ['in a template literal', "<div className={`grid ${on ? 'p-2' : ''} max-w-[70ch]`} />"],
  ])('sees one %s', async (_shape, jsx) => {
    expect(await hits(component(jsx))).toHaveLength(1);
  });

  it('sees a class constant built with cn() in a .ts file', async () => {
    const code = "import { cn } from '@/lib/utils';\nexport const wide = cn('max-w-[70ch]');\n";
    expect(await hits(code, 'src/lib/lint-fixture.ts')).toHaveLength(1);
  });

  it('reports a cn() call inside a className once, not twice', async () => {
    expect(await hits(component("<div className={cn('w-[37rem]')} />"))).toHaveLength(1);
  });

  it('does not see a class held in a plain constant (a documented limit)', async () => {
    const code = "export const wide = 'max-w-[70ch]';\n";
    expect(await hits(code, 'src/lib/lint-fixture.ts')).toEqual([]);
  });

  it('leaves the vendored primitives in components/ui alone', async () => {
    const code = component('<div className="w-[calc(100%-2rem)] min-w-[10rem]" />');
    expect(await hits(code, 'src/components/ui/lint-fixture.tsx')).toEqual([]);
  });

  it('accepts an exception that is disabled on its line', async () => {
    const jsx =
      '<div\n// eslint-disable-next-line opportun/no-arbitrary-width -- a fixture exception\nclassName="w-[37rem]"\n/>';
    const messages = await lint(component(jsx));
    expect(messages.filter((m) => m.ruleId === RULE)).toEqual([]);
    expect(messages.filter((m) => /unused eslint-disable/i.test(m.message))).toEqual([]);
  });
});

describe('the config change kept what was there', () => {
  it('still runs no-stretched-grid-button beside the new rule', async () => {
    const jsx = '<div className="grid gap-4 max-w-[70ch]">\n<Button>Save</Button>\n</div>';
    const rules = (await lint(component(jsx))).map((m) => m.ruleId);
    expect(rules).toContain('opportun/no-stretched-grid-button');
    expect(rules).toContain(RULE);
  });

  it('still reports a disable comment that no longer suppresses anything', async () => {
    const jsx =
      '<div\n// eslint-disable-next-line opportun/no-arbitrary-width -- nothing left to excuse\nclassName="max-w-prose"\n/>';
    const unused = (await lint(component(jsx))).filter((m) =>
      /unused eslint-disable/i.test(m.message),
    );
    expect(unused).toHaveLength(1);
  });
});
