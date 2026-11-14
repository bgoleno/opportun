// The shared demo admin (https://github.com/bgoleno/opportun/issues/563; sec's amendment B on
// #542, and tl and sec on #563). demo-admin is one of the seed's pinned accounts, so its password
// is known to every invitee. On a demo server it is an admin only on the routes below, and there
// only over the pinned accounts; everywhere else it is an ordinary user. The session plugin builds
// its request context that way, so every admin check, today's and any added later, sees a
// non-admin unless the route is listed here. An account the operator makes for one person
// (cli/createDemoAccount.ts) is out of its reach.
import type { Config } from '../config';
import type { UserCtx } from '../repos/base';
import { isSharedDemoAccount, SHARED_DEMO_IDS } from './demoAccounts';

/**
 * Method and route (as Fastify names it) where a shared demo admin stays an admin. Each one limits
 * itself to the pinned accounts with isSharedDemoAdmin, and has a test in demoSharedAdmin.test.ts.
 */
export const SHARED_ADMIN_ROUTES: ReadonlySet<string> = new Set([
  'GET /api/v1/admin/users',
  'GET /api/v1/admin/peppers',
  'POST /api/v1/admin/users/:id/reset-password',
  'GET /api/v1/jobs',
  'POST /api/v1/jobs/:id/retry',
]);

/** The request's context, without admin rights for a shared demo admin off the allowlist. */
export function narrowSharedDemoAdmin(
  cfg: Pick<Config, 'demo'>,
  ctx: UserCtx | null,
  method: string,
  route: string,
): UserCtx | null {
  if (ctx === null || !ctx.isAdmin || !isSharedDemoAccount(cfg, ctx.userId)) return ctx;
  return SHARED_ADMIN_ROUTES.has(`${method} ${route}`) ? ctx : { ...ctx, isAdmin: false };
}

/** Whether an admin request comes from the shared demo admin, so it reaches pinned accounts only. */
export function isSharedDemoAdmin(cfg: Pick<Config, 'demo'>, ctx: UserCtx): boolean {
  return ctx.isAdmin && isSharedDemoAccount(cfg, ctx.userId);
}

/** Whether a shared demo admin may act on `userId`: a pinned account, or no account at all. */
export function withinSharedDemo(userId: string | null): boolean {
  return userId === null || SHARED_DEMO_IDS.has(userId);
}
