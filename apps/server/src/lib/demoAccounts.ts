// The demo's shared fixture accounts (decision 133; tl and sec on
// https://github.com/bgoleno/opportun/issues/542#issuecomment-6884754511). The protections that
// exist because demo accounts are shared logins apply to these accounts only, never to an
// account the owner makes on a demo server for one person. Shared means one of the seed's pinned
// ids, the set the nightly reset deletes and reseeds, never a stored flag: a flag could be changed
// at runtime, and the shared demo admin's password is known to every invitee.
import { DEMO_USERS } from '../cli/seedDemoFixture';
import type { Config } from '../config';

/** The seed's pinned account ids: the shared demo accounts. */
export const SHARED_DEMO_IDS: ReadonlySet<string> = new Set(DEMO_USERS.map((u) => u.id));

/** Whether `userId` is a shared demo account on this server: a demo server, and a pinned id. */
export function isSharedDemoAccount(cfg: Pick<Config, 'demo'>, userId: string): boolean {
  return cfg.demo && SHARED_DEMO_IDS.has(userId);
}
