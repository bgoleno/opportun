// Removes an empty ANTHROPIC_BASE_URL or OPENAI_BASE_URL from the environment, so it is unset
// (https://github.com/bgoleno/opportun/issues/423).
//
// deploy/compose.yml passes both as `${VAR:-}`, which is an empty string when the user's .env does
// not set them. The AI SDK (@ai-sdk/anthropic, @ai-sdk/openai) creates a default provider while its
// module is being evaluated, reads these two variables from the environment itself, and throws
// "baseURL must be a non-empty string" on an empty or blank one: the process ends before any of
// Opportun's own code runs (qa on #421: every Compose deployment that did not set them crash-looped).
// The server's own reader already treats empty as unset (lib/aiProviderFetch.ts operatorBaseUrls,
// which trims), so deleting a blank value changes nothing Opportun reads.
//
// It must stay the FIRST import of every entry point: src/index.ts and each src/cli/*.ts that runs
// main(). ES modules are evaluated in the order they are imported, depth first, and the SDK is
// reached through ordinary imports (app.ts, config.ts and the CLIs all lead to packages/ai). A
// module imported after any of them runs too late. test/emptyAiBaseUrls.test.ts checks the order.
// It imports nothing itself, for the same reason.

/** Deletes ANTHROPIC_BASE_URL and OPENAI_BASE_URL when either is empty or blank. */
export function unsetEmptyAiBaseUrls(env: NodeJS.ProcessEnv): void {
  if (env.ANTHROPIC_BASE_URL?.trim() === '') delete env.ANTHROPIC_BASE_URL;
  if (env.OPENAI_BASE_URL?.trim() === '') delete env.OPENAI_BASE_URL;
}

unsetEmptyAiBaseUrls(process.env);
