// https://github.com/bgoleno/opportun/issues/9 (this repository's tracker): a grid item with no
// width of its own stretches to its column (justify-self defaults to stretch), so a <Button>
// dropped straight into a `grid gap-*` container renders as a full-width bar. That was caught
// three times, each only after someone saw the wrong render, and fixed each time with a one-line
// `w-fit`. This rule makes the width a decision at the call site instead: a Button whose layout
// parent is a grid must say `w-fit` (natural width), `w-full` (fill the column, on purpose), or
// otherwise state its width or justify-self.
//
// Why a lint rule rather than a natural-width default on Button itself (the other option the
// issue weighed): a default changes every render that relies on stretching today, with nothing
// to review them against. DialogFooter alone stacks 46 Buttons full width on phones by design
// (flex-col-reverse), and the auth forms' submit and provider buttons are full width on purpose.
// This rule changes no render; it only refuses to let a new one be decided by accident.
//
// What it sees, and what it does not. It reads class names as written at the call site, so it
// is a property of the code shapes below, not a guarantee:
// - The layout parent is the nearest enclosing JSX element, looking through expressions
//   (&&, ?:, .map callbacks) and through elements that render no box of their own: anything
//   with asChild, Fragment, Tooltip and DropdownMenu. Collapsible is deliberately not in that
//   list, because Radix renders it as a <div>. button-in-grid.test.tsx checks those DOM facts.
// - A grid is a `grid`/`inline-grid` class (any variant prefix) in a string literal or template
//   anywhere inside the parent's className, cn() included. A grid that a component applies
//   internally is invisible here: CardHeader and DialogContent are grids, and so is the local
//   Step in routes/settings/-extensionSetup.tsx. So is a className held in a variable.
// - A Button rendered by a helper called from JSX ({renderAction()}), or passed as a prop
//   (actions={<Button />}), is not followed: where it lands is that code's business.
// - Only <Button>. A native <button> stretches the same way, and so does any child of a flex
//   column (align-items defaults to stretch); neither is covered.

/** The element's tag as written: `Button`, or `Fragment` for `<React.Fragment>`. */
function elementName(el) {
  const n = el.openingElement.name;
  if (n.type === 'JSXIdentifier') return n.name;
  if (n.type === 'JSXMemberExpression') return n.property.name;
  return null;
}

function attribute(el, name) {
  return el.openingElement.attributes.find(
    (a) => a.type === 'JSXAttribute' && a.name.name === name,
  );
}

/** Every string literal and template chunk anywhere inside an attribute's value. */
function staticStrings(node, out = []) {
  if (!node || typeof node.type !== 'string') return out;
  if (node.type === 'Literal' && typeof node.value === 'string') out.push(node.value);
  if (node.type === 'TemplateElement') out.push(node.value.cooked ?? '');
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') continue;
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child === 'object') staticStrings(child, out);
    }
  }
  return out;
}

/** Class utilities with variant prefixes (sm:, hover:) and the important marker stripped. */
function utilities(el) {
  const value = attribute(el, 'className')?.value;
  return staticStrings(value)
    .flatMap((s) => s.split(/\s+/))
    .filter(Boolean)
    .map((t) => t.slice(t.lastIndexOf(':') + 1).replace(/^!|!$/g, ''));
}

const isGrid = (u) => u === 'grid' || u === 'inline-grid';

// Anything that sets the inline size or stops the stretch counts, including under a variant
// prefix: `sm:w-fit` alone is a width decision for sm and up, which is the point.
function statesWidth(u) {
  if (/^w-/.test(u)) return u !== 'w-auto';
  if (/^max-w-/.test(u)) return u !== 'max-w-none';
  if (/^size-/.test(u)) return u !== 'size-auto';
  if (/^(justify|place)-self-/.test(u)) return !/-(auto|stretch)$/.test(u);
  // An auto inline margin absorbs the free space, so the item keeps its natural width.
  return /^m[xlrse]?-auto$/.test(u);
}

// The container can stop stretching every item at once.
const stopsStretch = (u) => /^(justify|place)-items-/.test(u) && !/-(stretch|normal)$/.test(u);

// Render no element of their own, so their children sit in whatever contains them.
const NO_BOX = new Set(['Fragment', 'Tooltip', 'DropdownMenu']);

function layoutParent(button) {
  for (let cur = button.parent; cur; cur = cur.parent) {
    if (cur.type === 'JSXAttribute') return null;
    if (cur.type !== 'JSXElement') continue;
    if (attribute(cur, 'asChild') || NO_BOX.has(elementName(cur))) continue;
    return cur;
  }
  return null;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require a <Button> that is a grid item to state its width.',
      url: 'https://github.com/bgoleno/opportun/issues/9',
    },
    messages: {
      stretched:
        'This <Button> is a grid item, so it stretches to the full column width. ' +
        'Add w-fit for its natural width, or w-full if it should fill the column on purpose.',
    },
    schema: [],
  },
  create(context) {
    return {
      JSXElement(node) {
        if (elementName(node) !== 'Button') return;
        // size="icon" is size-9 in buttonVariants: a fixed width already.
        if (attribute(node, 'size')?.value?.value === 'icon') return;
        if (utilities(node).some(statesWidth)) return;
        const parent = layoutParent(node);
        if (!parent) return;
        const parentUtilities = utilities(parent);
        if (!parentUtilities.some(isGrid) || parentUtilities.some(stopsStretch)) return;
        context.report({ node: node.openingElement, messageId: 'stretched' });
      },
    };
  },
};
