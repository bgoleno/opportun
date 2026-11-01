// Page width or fluid (docs/design.md section 9, "Layout widths"; issue
// https://github.com/bgoleno/opportun/issues/32). AppShell caps every view at the page width and
// centres it in the main area. A view that gains from width (a board, a long list) opts out by
// declaring `staticData: { layout: 'fluid' }` on its route. That is a reviewed decision:
// layout.test.tsx pins the set of fluid routes, so making a view fluid changes a test.

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    /** 'fluid' opts this route's view out of the page cap. Absent means page width. */
    layout?: 'fluid';
  }
}

export type RouteLayout = 'page' | 'fluid';

/**
 * The layout of the route being shown: its deepest match decides, so a parent layout route
 * (Discovery's tabs) is fluid on the tabs that declare it and page width on the rest.
 */
export function layoutOf(matches: readonly { staticData?: { layout?: 'fluid' } }[]): RouteLayout {
  return matches.at(-1)?.staticData?.layout === 'fluid' ? 'fluid' : 'page';
}
