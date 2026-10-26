// Provider adapters over the Vercel AI SDK. A key is handed only to the client for the
// provider it belongs to; baseUrl is honoured only for openai_compatible, so a policy can
// never redirect an Anthropic or OpenAI key to another host.
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { ModelPolicy, ProviderFetchOptions, SafeBaseUrlOptions } from './types';

/**
 * Hostnames trusted as loopback by literal match, never by resolving them (issue #334): an
 * operator who sets a policy's baseUrl to one of these three strings typed it themselves for
 * their own local model runtime, so there is no attacker-influenced hostname here to defend
 * against with a DNS lookup -- unlike the https case below, where the hostname can be anything
 * a user enters and resolve-then-reject-private is what lib/aiProviderFetch.ts (apps/server)
 * does at actual fetch time. Do not "harden" this into a resolve step; that would just break
 * Ollama/LM Studio for no security benefit, since the string itself is the trust boundary here.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Accepts https URLs, or plain http on loopback when opts.allowLoopbackHttp is true (an
 * operator-level decision, issue #334; see SafeBaseUrlOptions). Rejects embedded credentials.
 * Returns the normalized URL; throws otherwise.
 *
 * This checks shape only (scheme, credentials): it has no DNS resolution and no prohibited-host
 * check (PROHIBITED_HOSTS, e.g. linkedin.com, lives in apps/server's safeFetch.ts, which this
 * IO-free package cannot import). The real enforcement boundary is lib/aiProviderFetch.ts
 * (apps/server), which every actual fetch goes through regardless of what this function already
 * accepted; this function exists for an early, friendly rejection at policy-submit time.
 */
export function assertSafeBaseUrl(raw: string | undefined, opts: SafeBaseUrlOptions): string {
  if (raw === undefined || raw.trim() === '') {
    throw new Error('openai_compatible requires a baseUrl');
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('baseUrl is not a valid URL');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('baseUrl must not contain credentials');
  }
  const ok =
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && opts.allowLoopbackHttp && LOOPBACK_HOSTS.has(url.hostname));
  if (!ok) {
    throw new Error(
      opts.allowLoopbackHttp
        ? 'baseUrl must be https, or http on localhost'
        : 'baseUrl must be https (http on localhost is disabled on this deployment)',
    );
  }
  return url.toString().replace(/\/$/, '');
}

export function isSafeBaseUrl(raw: string | undefined, opts: SafeBaseUrlOptions): boolean {
  try {
    assertSafeBaseUrl(raw, opts);
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds the SDK model for a policy. Throws on an unsafe openai_compatible baseUrl.
 *
 * opts.fetch is required, not defaulted to the SDK's own global fetch (issue #334): a silent
 * fallback here is exactly how the SSRF/LinkedIn bypass this fixes went unnoticed -- every
 * caller must say explicitly what fetch an openai_compatible client uses, even one (anthropic,
 * openai) that never reads it, so there is no path left that quietly reaches the real network
 * unvalidated.
 */
export function createLanguageModel(
  policy: ModelPolicy,
  apiKey: string,
  opts: ProviderFetchOptions,
): LanguageModel {
  switch (policy.provider) {
    case 'anthropic':
      return createAnthropic({ apiKey })(policy.model);
    case 'openai':
      return createOpenAI({ apiKey })(policy.model);
    case 'openai_compatible':
      return createOpenAICompatible({
        name: 'openai_compatible',
        baseURL: assertSafeBaseUrl(policy.baseUrl, opts),
        apiKey,
        fetch: opts.fetch,
      })(policy.model);
  }
}
