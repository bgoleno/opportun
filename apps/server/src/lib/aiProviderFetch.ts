// SSRF-safe fetch for the AI provider path (issue #334). openai_compatible's baseUrl is
// user-controlled (per-user, per-policy; see lib/ai.ts's own header comment on scoping), so
// every outbound request this path makes -- the key-validation model-list GET
// (aiKeyValidate.ts) and the Vercel AI SDK's own chat-completion POST on every task run
// (packages/ai's createLanguageModel) -- must have its target checked, the same way safeFetch
// checks everything else: scheme, PROHIBITED_HOSTS, and every DNS answer rejected if any is
// private.
//
// This deliberately does NOT reuse safeFetch() itself, for two independent reasons, not one:
//
// 1. safeFetch buffers the whole response into a Buffer (readBody, safeFetch.ts) before
//    returning. The SDK's chat-completion calls stream (ai's streamText), consumed live as the
//    model generates output; a buffered response is incompatible with that, not merely
//    inconvenient.
// 2. safeFetch refuses to combine caller `headers` with `allowPublic: true`
//    (safeFetchWith, safeFetch.ts): "caller headers are not allowed with allowPublic". That
//    refusal is deliberate and correct for safeFetch's OTHER callers, where a header carries a
//    credential that does not belong to whoever chose the destination. Here the credential is
//    the user's own provider key, sent to an endpoint the SAME user chose -- the same trust
//    boundary, not two -- but weakening safeFetch's own rule to fit this one caller would widen
//    it for every other caller relying on it. This is a second, narrower primitive instead.
//
// What it keeps from safeFetch: PROHIBITED_HOSTS (isProhibitedHost) and the private-address
// check (isPrivateAddress), imported directly rather than re-implemented, exactly the way
// lib/mcpClient.ts's checkMcpUrl already does for its own streamable-HTTP transport.
//
// What it does NOT do, unlike safeFetch: pin the connection to the address it resolved.
// Pinning means handing the transport a fixed address instead of letting it resolve the
// hostname again, which is straightforward with safeFetch's own buffering node:https.request
// call (pinnedRequest) but is not available through a standard Fetch-shaped `fetch` (the type
// the SDK's injected fetch must be), without reimplementing a streaming HTTP client on top of
// a custom dispatcher. The gap this leaves -- a window between the resolve here and the real
// fetch's own internal resolve, during which the target's DNS answer could in principle change
// -- is the SAME one SECURITY.md already documents as an accepted deviation for
// lib/mcpClient.ts's streamable-HTTP transport, for the identical reason (a streaming,
// third-party-driven transport that cannot be handed a pre-resolved address the way a buffered
// request can). This matches that already-accepted bar rather than inventing a new, weaker one.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { FetchBlockedError, isPrivateAddress, isProhibitedHost } from './safeFetch';

/**
 * Hostnames trusted as loopback by literal match, never by resolving them: mirrors
 * packages/ai/src/providers.ts's own LOOPBACK_HOSTS exactly (duplicated, not shared, since that
 * package cannot import from apps/server -- see this project's own precedent for this shape of
 * duplication, e.g. lib/sessions.ts and lib/twoFactor.ts each keeping their own token-hash
 * helper). An operator who set a policy's baseUrl to one of these three strings typed it
 * themselves for their own local model runtime; there is no attacker-influenced hostname here
 * to defend against with a DNS lookup, so this branch never resolves at all.
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The SECURITY.md deviation entry this groups with (HTTP MCP sources, the AI provider path,
 * and DNS rebinding) is true if and only if this function calls BOTH isProhibitedHost AND
 * isPrivateAddress on every https target, lacking only connection pinning -- never a check
 * that only does one of the two. A private-range check alone would close the SSRF and leave
 * every PROHIBITED_HOSTS entry (safeFetch.ts) reachable regardless, since those hosts are
 * ordinary public addresses -- precisely the compliance gap issue #334 found. If either call
 * below is ever removed as "redundant", that entry becomes false and nothing else will say so:
 * test/aiProviderFetch.test.ts's compliance check asserts both predicates actually fire (a
 * prohibited public host blocked, a private address blocked), not merely that both symbols
 * are imported.
 */
/** Resolves a hostname to every address it answers with; injected so tests never depend on
 *  real DNS (an RFC 2606 fixture host such as llm.example.com never resolves for real, by
 *  design: RFC 2606 sets these names aside for documentation and testing). */
export type ResolveHost = (host: string) => Promise<string[]>;

const realResolve: ResolveHost = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export interface ProviderFetchOptions {
  allowLoopbackHttp: boolean;
  /**
   * The origins of the operator's own ANTHROPIC_BASE_URL and OPENAI_BASE_URL, which the SDKs read
   * from the environment (issue https://github.com/bgoleno/opportun/issues/344, decision 40). An
   * operator who points them at a proxy chose it, as with OPPORTUN_AI_ALLOW_LOOPBACK_HTTP, so a
   * request to one of these origins skips the https and public-address checks: a LiteLLM
   * container on the compose network, or a private gateway, keeps working. It keeps the rest: no
   * credentials in the URL, and redirect: 'error'. No user can set either variable, and a user's
   * own openai_compatible baseUrl on any other origin is checked as before.
   */
  operatorOrigins?: readonly string[];
}

async function checkProviderUrl(
  raw: string,
  opts: ProviderFetchOptions,
  resolve: ResolveHost,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchBlockedError('scheme', 'not a valid URL');
  }
  if (url.username !== '' || url.password !== '') {
    throw new FetchBlockedError('scheme', 'credentials in URL');
  }
  if (opts.operatorOrigins?.includes(url.origin) === true) return url;
  const allowLoopbackHttp = opts.allowLoopbackHttp;
  if (url.protocol === 'http:') {
    if (!allowLoopbackHttp || !LOOPBACK_HOSTNAMES.has(url.hostname)) {
      throw new FetchBlockedError('scheme', url.protocol);
    }
    return url;
  }
  if (url.protocol !== 'https:') throw new FetchBlockedError('scheme', url.protocol);
  const host = url.hostname.toLowerCase();
  if (isProhibitedHost(host)) throw new FetchBlockedError('host_not_allowed', host);
  const literal = host.startsWith('[') ? host.slice(1, -1) : host;
  const addresses = isIP(literal) !== 0 ? [literal] : await resolve(host);
  const bad = addresses.find((a) => isPrivateAddress(a));
  if (addresses.length === 0 || bad !== undefined) {
    throw new FetchBlockedError('private_address', `${host} -> ${bad ?? 'nothing'}`);
  }
  return url;
}

type FetchInput = Parameters<typeof fetch>[0];

function targetOf(input: FetchInput): string {
  if (input instanceof Request) return input.url;
  return input instanceof URL ? input.href : input;
}

/**
 * Builds the fetch the AI provider path uses in place of the SDK's own default, or a bare
 * global fetch call (issue #334): every call validated by checkProviderUrl above, then a real
 * fetch -- unmodified, streaming response and all -- with `redirect: 'error'` by default, so
 * the underlying fetch throws rather than ever acting on a 3xx. This is not a new choice: it is
 * `aiKeyValidate.ts`'s own listModels GET carried over unchanged (that call already set
 * `redirect: 'error'` before this file existed), now also applied to the SDK's chat-completion
 * POST, which had no redirect policy of its own before this fix. Neither a model-list nor a
 * chat-completion endpoint has a legitimate reason to redirect, and the request carries the
 * provider key in a header, which must never ride a hop this validation did not check. A
 * caller's own explicit `redirect` still wins (the spread below), since a caller's own
 * stricter choice should never be loosened, but nothing downstream may loosen this default.
 */
export function createProviderFetch(
  opts: ProviderFetchOptions,
  resolve: ResolveHost = realResolve,
): typeof fetch {
  return (async (input: FetchInput, init?: RequestInit) => {
    await checkProviderUrl(targetOf(input), opts, resolve);
    return fetch(input, { redirect: 'error', ...init });
  }) as typeof fetch;
}

export type ProviderTarget = 'anthropic' | 'openai' | 'ai_compatible';

/** The operator's own base URLs for Anthropic and OpenAI, as the environment sets them. */
export interface OperatorBaseUrls {
  anthropic?: string;
  openai?: string;
}

/**
 * Reads ANTHROPIC_BASE_URL and OPENAI_BASE_URL (decision 40). The server passes these to the
 * SDKs itself (packages/ai createLanguageModel), so what the fetch trusts and what the SDK calls
 * are the same value. An empty variable is unset.
 */
export function operatorBaseUrls(env: NodeJS.ProcessEnv): OperatorBaseUrls {
  const out: OperatorBaseUrls = {};
  const anthropic = env.ANTHROPIC_BASE_URL?.trim();
  const openai = env.OPENAI_BASE_URL?.trim();
  if (anthropic !== undefined && anthropic !== '') out.anthropic = anthropic;
  if (openai !== undefined && openai !== '') out.openai = openai;
  return out;
}

/**
 * The origins of the operator's base URLs, by target. A value that is not a URL has no origin to
 * trust; the request to it fails the check as any other bad URL does.
 */
export function operatorProviderOrigins(urls: OperatorBaseUrls): Map<string, ProviderTarget> {
  const out = new Map<string, ProviderTarget>();
  for (const target of ['anthropic', 'openai'] as const) {
    const raw = urls[target];
    if (raw === undefined) continue;
    try {
      out.set(new URL(raw).origin, target);
    } catch {
      // Not a URL: not an origin to trust.
    }
  }
  return out;
}

const OFFICIAL: ReadonlyMap<string, ProviderTarget> = new Map([
  ['api.anthropic.com', 'anthropic'],
  ['api.openai.com', 'openai'],
]);

/**
 * Which provider a request goes to, for its outbound span and metric (14.4): the official hosts
 * and the operator's origins by name, any other endpoint (a user's own gateway) ai_compatible.
 */
export function providerTarget(
  input: FetchInput,
  operator: ReadonlyMap<string, ProviderTarget>,
): ProviderTarget {
  try {
    const url = new URL(targetOf(input));
    return operator.get(url.origin) ?? OFFICIAL.get(url.hostname.toLowerCase()) ?? 'ai_compatible';
  } catch {
    return 'ai_compatible';
  }
}
