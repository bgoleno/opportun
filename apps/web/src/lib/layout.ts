// Page width or fluid (docs/design.md section 9, "Layout widths"; issue
// https://github.com/bgoleno/opportun/issues/32). AppShell caps every view at the page width and
// centres it in the main area. A view that gains from width (a board, a long list) opts out by
// declaring `staticData: { layout: 'fluid' }` on its route, or on its section's route so every
// tab gets it. That is a reviewed decision: layout.test.tsx pins where it is declared, so making
// a view fluid changes a test.

export type RouteLayout = 'page' | 'fluid';

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    /** This route's layout, and its child routes' unless they declare their own. */
    layout?: RouteLayout;
  }
}

/**
 * The layout of the route being shown: the deepest match that declares one decides, so a
 * section's tabs inherit the section's layout (Discovery declares fluid once, keeping its header
 * and tab strip still between tabs). Nothing declared means page width.
 */
export function layoutOf(
  matches: readonly { staticData?: { layout?: RouteLayout } }[],
): RouteLayout {
  return matches.findLast((m) => m.staticData?.layout !== undefined)?.staticData?.layout ?? 'page';
}
