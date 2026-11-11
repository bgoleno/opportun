// Server tests do not depend on DNS (https://github.com/bgoleno/opportun/issues/344, part 2
// requirement 4). Every AI provider's request goes through the checked fetch
// (lib/aiProviderFetch.ts), which resolves the provider's host before the request: with the real
// resolver a test would need DNS for api.anthropic.com or api.openai.com, and fail on a machine
// with none. This answers every host with one public address instead, the one the other provider
// fetch tests use (a documentation range such as RFC 5737's is refused as not public).
// The real fetch is still each test's own stub, so nothing leaves the test.
import { setProviderResolveOverride } from '../src/lib/ai';
import type { ResolveHost } from '../src/lib/aiProviderFetch';
import type { ApiEnv } from './api';

export const resolvePublicForTests: ResolveHost = async () => ['93.184.216.34'];

/** A file's boot, with each app it builds resolving provider hosts without DNS. */
export function withProviderResolver<A extends unknown[]>(
  boot: (...args: A) => Promise<ApiEnv>,
): (...args: A) => Promise<ApiEnv> {
  return async (...args) => {
    const env = await boot(...args);
    setProviderResolveOverride(env.app.db, resolvePublicForTests);
    return env;
  };
}
