// https://github.com/bgoleno/opportun/issues/37 (W6 of https://github.com/bgoleno/opportun/issues/31):
// widths come from the layout tokens in apps/web/src/index.css (docs/design.md section 9, "Layout
// widths"), and an arbitrary width value in a view is a review finding (rule 5 there). The e2e
// width check (e2e/desktop.spec.ts) finds a line that runs too long, but only in CI, only on the
// views it visits and only once the text is long enough. This rule refuses the cause when it is
// written: a Tailwind width utility whose arbitrary value holds a literal length, or a numeric
// width step wider than 96.
//
// What it flags. A utility, under any variant prefix (lg:, hover:) and with or without the
// important marker, that is one of
// - w-[...], min-w-[...], max-w-[...], basis-[...] or grid-cols-[...], or
// - an arbitrary property for the same thing: [width:...], [min-width:...], [max-width:...],
//   [flex-basis:...], [grid-template-columns:...], [inline-size:...] and its min/max forms,
// and whose value holds a literal length (a number with a unit: 37rem, 70ch, 320px, 100vw, 45%).
// The tokens themselves are not literals: var(--container-rail) and the other --container-*
// variables are removed before looking. So max-w-prose, max-w-page, w-rail, w-chat and
// grid-cols-[minmax(0,1fr)_var(--container-rail)] pass, and so do tracks with no length at all
// (grid-cols-[auto_1fr], grid-cols-[1fr_2fr_auto]): a column split is not a width. A card grid
// is the named grid-cards utility (index.css), on the --container-card token.
//
// It also flags a numeric step: w-, min-w-, max-w- or basis- followed by a bare number greater
// than 96, decimals included (w-97, max-w-160, md:max-w-120, !w-120, w-96.5), under any variant
// prefix and with or without the important marker. In Tailwind 4 these steps are open-ended,
// each calc(var(--spacing) * n), so max-w-160 is a 40rem width written without brackets, and
// without this the rule's escape hatch would be to drop the brackets and divide by 0.25rem
// (tl's review of https://github.com/bgoleno/opportun/pull/64). Why 96: it is the top of
// Tailwind's documented spacing scale (24rem). Anything wider is a layout width, and the tokens
// own those. Reporting it was chosen over documenting the gap, because the gap is the easy way
// round the rule, not an edge case.
//
// What passes on purpose (the boundary agreed with tl on that PR; the tests pin both sides):
// - Numeric steps up to 96 inclusive: icons (w-4, w-5), avatars (w-10) and component widths
//   (w-24 to w-96). The largest in the code is w-72.
// - Tailwind's named container sizes, max-w-xs to max-w-7xl (20rem to 80rem): theme tokens
//   (var(--container-md) and so on) like ours, a fixed set rather than an open-ended one, used
//   for dialog and form widths and for the 48rem stacked chat cap (max-w-3xl).
// - Keywords and fractions: w-full, w-auto, w-fit, w-min, w-max, w-screen, w-px, w-1/2, basis-1/3.
// - size-<n> and size-[...]: a square (icons, avatars), not a layout width.
// - grid-cols-<n>: a column count, not a width.
//
// Where it looks. It reads class names as written, so it is a property of these code shapes,
// not a guarantee:
// - Every string literal and template chunk inside a className (or class) attribute's value,
//   through expressions, cn() and conditionals included.
// - Every string literal and template chunk among the arguments of a call to cn, clsx, cx, cva
//   or twMerge, wherever the call is (a class constant built with cn() outside JSX included).
// What it does not see:
// - A class held in a plain variable or constant (const wide = 'max-w-[70ch]'), a prop
//   (contentClassName="w-[37rem]" on a component that forwards it), or an object passed to
//   anything other than the calls above.
// - A computed string: a template with an interpolated value (`w-[${n}rem]`) is read chunk by
//   chunk, so the arbitrary value is split and nothing matches. So is a string built with + or
//   join().
// - An inline style={{ width: ... }} or a width set in CSS. (The CSP forbids inline styles.)
// - A width behind a CSS variable that is not a token (w-[var(--some-width)]).
//
// Where it applies is set in eslint.config.js: every .ts and .tsx file under apps/web/src except
// components/ui/, the vendored primitives (README.md there). The layout primitives that apply the
// tokens (AppShell, MainWithRail) are checked like any view and pass, because they use only
// tokens. An exception that has to stay carries an eslint-disable-next-line comment that says
// why, so the reason sits next to the value.

// The second half of every message: where the widths come from, and how to keep an exception.
const USE_A_TOKEN =
  'Use a width token instead: max-w-prose (65ch) for running text, max-w-page for a page, ' +
  '<MainWithRail> or w-rail for a side rail, w-chat for the chat column, grid-cards for a card ' +
  'grid (docs/design.md section 9, "Layout widths", rule 5). If this one has to stay, disable ' +
  'the rule on this line with a comment saying why.';

/** Class helpers whose string arguments are class names. */
const CLASS_CALLS = new Set(['cn', 'clsx', 'cx', 'cva', 'twMerge']);

const WIDTH_UTILITY = /^-?(?:w|min-w|max-w|basis|grid-cols)-\[(.+)\]$/;
const WIDTH_PROPERTY =
  /^\[(?:width|min-width|max-width|flex-basis|grid-template-columns|(?:min-|max-)?inline-size):(.+)\]$/;

// A number with a CSS length unit or a percentage. fr is a share of the free space, not a width.
const LITERAL_LENGTH =
  /\d(?:rem|em|ex|ch|lh|rlh|px|pt|pc|cm|mm|in|q|vw|vh|vi|vb|vmin|vmax|[sld]v(?:w|h|i|b|min|max)|cq(?:w|h|i|b|min|max)|%)(?![a-z])/i;
const TOKEN = /var\(--container-[\w-]+\)/g;
// A numeric width step (w-150, max-w-96.5), and the largest one that passes.
// (\d+\.?\d* rather than \d+(\.\d+)?: the same strings to Number(), without a quantified group
// that security/detect-unsafe-regex reports.)
const NUMERIC_STEP = /^-?(?:w|min-w|max-w|basis)-(\d+\.?\d*)$/;
const LARGEST_STEP = 96;

/** The utility without its variant prefixes: the part after the last colon outside brackets. */
function baseUtility(token) {
  let depth = 0;
  let start = 0;
  for (const [i, c] of [...token].entries()) {
    if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (c === ':' && depth === 0) start = i + 1;
  }
  return token.slice(start).replace(/^!|!$/g, '');
}

/**
 * Which report a class token earns: 'numericStep' for a numeric width step over 96,
 * 'arbitrary' for an arbitrary width value with a literal length, or null.
 */
export function arbitraryWidth(token) {
  const u = baseUtility(token);
  const step = NUMERIC_STEP.exec(u)?.[1];
  if (step !== undefined) return Number(step) > LARGEST_STEP ? 'numericStep' : null;
  const value = (WIDTH_UTILITY.exec(u) ?? WIDTH_PROPERTY.exec(u))?.[1];
  if (value === undefined) return null;
  return LITERAL_LENGTH.test(value.replace(TOKEN, '')) ? 'arbitrary' : null;
}

/** Every string literal and template chunk anywhere inside node, as [node, text] pairs. */
function staticStrings(node, out = []) {
  if (!node || typeof node.type !== 'string') return out;
  if (node.type === 'Literal' && typeof node.value === 'string') out.push([node, node.value]);
  if (node.type === 'TemplateElement') out.push([node, node.value.cooked ?? '']);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') continue;
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child === 'object') staticStrings(child, out);
    }
  }
  return out;
}

function calleeName(call) {
  const c = call.callee;
  if (c.type === 'Identifier') return c.name;
  if (c.type === 'MemberExpression' && c.property.type === 'Identifier') return c.property.name;
  return null;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow arbitrary width values outside the layout tokens.',
      url: 'https://github.com/bgoleno/opportun/issues/37',
    },
    messages: {
      arbitrary: `\`{{utility}}\` is an arbitrary width. ${USE_A_TOKEN}`,
      numericStep: `\`{{utility}}\` is a numeric step wider than 96 (24rem), a layout width. ${USE_A_TOKEN}`,
    },
    schema: [],
  },
  create(context) {
    // A cn() call inside a className is reached twice (from the attribute and from the call);
    // each string is reported once.
    const seen = new WeakSet();
    function check(node) {
      for (const [str, text] of staticStrings(node)) {
        if (seen.has(str)) continue;
        seen.add(str);
        for (const token of text.split(/\s+/)) {
          const messageId = token && arbitraryWidth(token);
          if (messageId) context.report({ node: str, messageId, data: { utility: token } });
        }
      }
    }
    return {
      JSXAttribute(node) {
        if (node.name.type === 'JSXIdentifier' && ['className', 'class'].includes(node.name.name)) {
          check(node.value);
        }
      },
      CallExpression(node) {
        if (CLASS_CALLS.has(calleeName(node))) check({ type: 'Arguments', args: node.arguments });
      },
    };
  },
};
