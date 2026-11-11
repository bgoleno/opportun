// Server tests do not depend on DNS (https://github.com/bgoleno/opportun/issues/344, part 2
// requirement 4). Every AI provider's request goes through the checked fetch
// (lib/aiProviderFetch.ts), which resolves the provider's host before the request: with the real
// resolver a test would need DNS for api.anthropic.com or api.openai.com, and fail or hang on a
// machine with none. testApp (helpers.ts) installs this for every app it builds: every host
// answers with one public address, the one the provider fetch tests use (a documentation range
// such as RFC 5737's is refused as not public). The real fetch is still each test's own stub, so
// nothing leaves the test.
import type { ResolveHost } from '../src/lib/aiProviderFetch';

export const resolvePublicForTests: ResolveHost = async () => ['93.184.216.34'];
