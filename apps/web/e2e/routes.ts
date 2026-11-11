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

/** The views only an administrator reaches. */
export const ADMIN_ROUTES = ['/settings/users', '/settings/jobs', '/settings/metrics'] as const;
