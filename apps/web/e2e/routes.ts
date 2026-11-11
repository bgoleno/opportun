// The routed views every layout spec walks: mobile.spec.ts at phone widths and desktop.spec.ts
// at desktop widths (issue https://github.com/bgoleno/opportun/issues/33). One list, so a new
// route cannot be added to one spec and missed by the other.

/** Every routed view a signed-in user can reach without existing data. */
export const USER_ROUTES = [
  '/',
  '/pipeline',
  '/discovery',
  '/discovery/companies',
  '/discovery/decided',
  '/discovery/prompts',
  '/discovery/sources',
  '/resumes',
  '/inbox',
  '/network',
  '/settings',
  '/settings/account',
  '/settings/security',
  '/settings/profile',
  '/settings/role-targets',
  '/settings/resume-rules',
  '/settings/ai',
  '/settings/integrations',
  '/settings/mail-filters',
  '/settings/data',
  '/settings/metrics',
] as const;

/**
 * The views only an administrator reaches. A path is in one list or the other, never both: the
 * specs name a test after its path, and Playwright refuses a suite with two tests of one name.
 * `/settings/metrics` is a user route (a user sees their own AI metrics); the admin's fuller view
 * of it is walked by e2e/metrics.spec.ts.
 */
export const ADMIN_ROUTES = ['/settings/users', '/settings/jobs'] as const;
