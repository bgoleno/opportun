// Env-gated providers for end-to-end tests (apps/web/e2e). Each flag swaps one external
// boundary for an in-process fake so the full app runs with no network and no real accounts:
//   OPPORTUN_AI_MOCK=1     every AI task answers from a canned model (mockAi.ts)
//   OPPORTUN_DOCS_MOCK=1   resume documents live in memory (mockDocs.ts)
//   OPPORTUN_GMAIL_MOCK=1  Google OAuth and Gmail are a fixture mailbox (mockGoogle.ts)
//   OPPORTUN_SOURCE_MOCK=1 Greenhouse boards serve fixture postings and board detection answers
//                          from fixtures (mockSources.ts)
//   OPPORTUN_OAUTH_MOCK=1  OAuth sign-in token/userinfo endpoints answer for the identity the
//                          e2e encodes in the code (mockOAuth.ts)
// A server started with NODE_ENV=production refuses all of them.
import type { FastifyInstance } from 'fastify';
import { registerSource, resetSources } from '../adapters/discoverySource';
import type { BuildOptions } from '../app';
import type { Config } from '../config';
import { mockAiOverride, mockAiRoutes } from './mockAi';
import { createMockDocumentStore } from './mockDocs';
import { createMockGoogleApi, mockGoogleTokenFetch } from './mockGoogle';
import { mockOAuthFetch } from './mockOAuth';
import { mockGreenhouseSource, mockSourceFetch, mockSourceRoutes } from './mockSources';

export const MOCK_FLAGS = [
  'OPPORTUN_AI_MOCK',
  'OPPORTUN_DOCS_MOCK',
  'OPPORTUN_GMAIL_MOCK',
  'OPPORTUN_SOURCE_MOCK',
  'OPPORTUN_OAUTH_MOCK',
] as const;
export type MockFlag = (typeof MOCK_FLAGS)[number];

export interface TestSupport {
  /** The flags that were on. */
  enabled: MockFlag[];
  build: BuildOptions;
  /** Registers mock-only routes once the app is built. */
  register(app: FastifyInstance): Promise<void>;
}

/** Which mock flags are set to 1 (any other value is off). */
export function enabledMocks(env: NodeJS.ProcessEnv): MockFlag[] {
  // eslint-disable-next-line security/detect-object-injection -- flag is a MOCK_FLAGS literal
  return MOCK_FLAGS.filter((flag) => env[flag] === '1');
}

/** The mock wiring for the flags in `env`; undefined when none is set. */
export function testSupportFromEnv(env: NodeJS.ProcessEnv, cfg: Config): TestSupport | undefined {
  const enabled = enabledMocks(env);
  if (enabled.length === 0) return undefined;
  if (env.NODE_ENV === 'production') {
    throw new Error(
      `${enabled.join(', ')} must not be set in production: they replace real AI, Google and job board providers with test fakes`,
    );
  }
  // The canned endpoint ignores response_format, and the SDK warns about that on every
  // structured call; the warning is noise for a fake model.
  if (enabled.includes('OPPORTUN_AI_MOCK')) {
    (globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;
  }
  const build: BuildOptions = {};
  const on = (flag: MockFlag) => enabled.includes(flag);
  if (on('OPPORTUN_AI_MOCK')) build.ai = mockAiOverride(cfg.port);
  if (on('OPPORTUN_DOCS_MOCK')) build.documentStore = createMockDocumentStore();
  // The OAuth exchange is part of the Google fake, so either Google mock enables it.
  if (on('OPPORTUN_GMAIL_MOCK') || on('OPPORTUN_DOCS_MOCK')) {
    build.google = createMockGoogleApi();
    build.googleFetch = mockGoogleTokenFetch;
  }
  if (on('OPPORTUN_SOURCE_MOCK')) build.sourceFetch = mockSourceFetch;
  if (on('OPPORTUN_OAUTH_MOCK')) build.oauth = { fetch: mockOAuthFetch };
  return {
    enabled,
    build,
    async register(app) {
      if (on('OPPORTUN_AI_MOCK')) await app.register(mockAiRoutes);
      if (on('OPPORTUN_SOURCE_MOCK')) {
        registerSource(mockGreenhouseSource);
        app.addHook('onClose', async () => resetSources());
        await app.register(mockSourceRoutes);
      }
    },
  };
}
