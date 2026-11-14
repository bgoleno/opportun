// Anthropic's batch client for ranking (#509, slice A of https://github.com/bgoleno/opportun/issues/358;
// tl's slice text issuecomment-6871513480). Message Batches is three plain HTTP endpoints, so this
// is a small client of them rather than a new dependency (tl: prefer none):
//   - POST {base}/messages/batches              submit
//   - GET  {base}/messages/batches/{id}         state
//   - GET  {base}/messages/batches/{id}/results results, as JSON Lines
// Built as every provider client here is (#334, #344): the server's explicit fetch and the
// operator's base URL, never the environment and never a global fetch; the key only in x-api-key,
// and never in an error, a log or a span. Written against Anthropic's API reference (see
// anthropicBatch.fixtures.ts for the pages and the date read): no call to the real API was made to
// build it, and the owner's own batch confirms it (slice C, #511).
import { generateText, Output } from 'ai';
import type { BatchProvider, BatchRequest, BatchResultItem, BatchState, BatchUsage } from './batch';
import { createLanguageModel } from './providers';
import { SDK_TELEMETRY_OFF } from './telemetry';
import { OFFICIAL_BASE_URLS, type ModelPolicy, type ProviderFetchOptions } from './types';

/** The API version the live calls send (the AI SDK's Anthropic provider), so a batch sends it too. */
export const ANTHROPIC_VERSION = '2023-06-01';

/** Anthropic's rule for a request's custom_id (the reference: 1 to 64 of these). */
const CUSTOM_ID = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * The key the SDK is given while it builds a request's body. Never a real key: the body is all
 * that is kept, and the request it would make is answered here, by `capture`, without leaving.
 */
const PLACEHOLDER_KEY = 'sk-ant-placeholder-for-a-batch-body';

/**
 * A request's `params`: the body the live call sends for it, built by the very code that sends the
 * live call (the AI SDK's Anthropic provider, called as runStructured calls it), and captured on
 * its way out instead of sent. So a batch asks exactly what a live call would, the system's cache
 * split, the structured output format and the SDK's rewriting of the schema included, and a later
 * SDK change to the live body changes the batch's too (tl's criterion 3; the test that pins the
 * equality is anthropicBatch.test.ts).
 */
async function liveBody(
  policy: ModelPolicy,
  request: BatchRequest['request'],
): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> | null = null;
  const capture = (async (_input: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    // An answer the SDK takes as a refusal, so it stops here and nothing else is attempted.
    return new Response(
      JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'captured for a batch' },
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  const model = createLanguageModel(policy, PLACEHOLDER_KEY, {
    fetch: capture,
    allowLoopbackHttp: false,
  });
  try {
    await generateText({
      model,
      system: request.system,
      prompt: request.prompt,
      output: Output.object({ schema: request.schema }),
      maxRetries: 0,
      telemetry: SDK_TELEMETRY_OFF,
      maxOutputTokens: request.maxOutputTokens,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    });
  } catch {
    // The capture's answer: expected.
  }
  if (body === null) throw new Error('Anthropic batch: the request body could not be built');
  return body;
}

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** One results line, as the reference gives it; anything else is an unexpected answer. */
function resultItem(line: unknown): BatchResultItem | null {
  if (!isRecord(line) || typeof line.custom_id !== 'string' || !isRecord(line.result)) return null;
  const customId = line.custom_id;
  const result = line.result;
  switch (result.type) {
    case 'succeeded': {
      const message = result.message;
      if (!isRecord(message) || !Array.isArray(message.content) || !isRecord(message.usage)) {
        return null;
      }
      const text = message.content
        .filter((b): b is Json => isRecord(b) && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('');
      const u = message.usage;
      const cacheRead = count(u.cache_read_input_tokens);
      const cacheWrite = count(u.cache_creation_input_tokens);
      // The total input is input_tokens plus both cache counts (the reference); BatchUsage.input
      // includes the cache tokens, as the live path's usage does.
      const usage: BatchUsage = {
        input: count(u.input_tokens) + cacheRead + cacheWrite,
        output: count(u.output_tokens),
        cacheRead,
        cacheWrite,
      };
      return { customId, kind: 'succeeded', text, usage };
    }
    case 'errored': {
      const outer = result.error;
      const inner = isRecord(outer) ? outer.error : undefined;
      const type = isRecord(inner) && typeof inner.type === 'string' ? inner.type : 'unknown';
      // The error's type only, never its message: the message is the provider's words, which can
      // quote the request, and it goes to the ledger.
      return {
        customId,
        kind: 'errored',
        invalidRequest: type === 'invalid_request_error',
        detail: type,
      };
    }
    case 'expired':
      return { customId, kind: 'expired' };
    case 'canceled':
      return { customId, kind: 'canceled' };
    default:
      return null;
  }
}

/** Anthropic's Message Batches, for one policy and key. See the file's top for what it may reach. */
export function createAnthropicBatchProvider(target: {
  policy: ModelPolicy;
  apiKey: string;
  providerFetch: ProviderFetchOptions;
}): BatchProvider {
  const { policy, apiKey, providerFetch } = target;
  // The same fetch and base URL as the live Anthropic client (providers.ts createLanguageModel):
  // the operator's ANTHROPIC_BASE_URL when set, with the fetch that trusts its origin.
  const doFetch = providerFetch.officialFetch ?? providerFetch.fetch;
  const base = (providerFetch.baseUrls?.anthropic ?? OFFICIAL_BASE_URLS.anthropic).replace(
    /\/+$/,
    '',
  );
  const batches = `${base}/messages/batches`;
  const headers = (json: boolean): Record<string, string> => ({
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    ...(json ? { 'content-type': 'application/json' } : {}),
  });
  /** A refusal names what was asked and the status only: never the key or the provider's text. */
  const refused = (what: string, status: number) =>
    new Error(`Anthropic batch ${what}: HTTP ${status}`);

  return {
    async submit(requests) {
      for (const r of requests) {
        if (!CUSTOM_ID.test(r.customId)) {
          throw new Error('Anthropic batch submit: a custom id Anthropic does not take');
        }
      }
      const body = {
        requests: await Promise.all(
          requests.map(async (r) => ({
            custom_id: r.customId,
            params: await liveBody(policy, r.request),
          })),
        ),
      };
      const res = await doFetch(batches, {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw refused('submit', res.status);
      const batch = (await res.json()) as unknown;
      if (!isRecord(batch) || typeof batch.id !== 'string') {
        throw new Error('Anthropic batch submit: an unexpected answer');
      }
      return { batchId: batch.id };
    },

    async state(batchId): Promise<BatchState> {
      const res = await doFetch(`${batches}/${encodeURIComponent(batchId)}`, {
        method: 'GET',
        headers: headers(false),
      });
      if (res.status === 404) return 'gone';
      if (!res.ok) throw refused('state', res.status);
      const batch = (await res.json()) as unknown;
      const status = isRecord(batch) ? batch.processing_status : undefined;
      if (status === 'in_progress' || status === 'canceling') return 'in_progress';
      if (status === 'ended') return 'ended';
      throw new Error('Anthropic batch state: an unexpected processing_status');
    },

    async results(batchId) {
      // The documented results endpoint on the operator's own base URL, never a results_url a
      // response names: the key goes nowhere a response could point it.
      const res = await doFetch(`${batches}/${encodeURIComponent(batchId)}/results`, {
        method: 'GET',
        headers: headers(false),
      });
      if (!res.ok) throw refused('results', res.status);
      const items: BatchResultItem[] = [];
      for (const raw of (await res.text()).split('\n')) {
        if (raw.trim() === '') continue;
        let line: unknown;
        try {
          line = JSON.parse(raw);
        } catch {
          line = undefined;
        }
        const item = resultItem(line);
        // One line not understood is an unexpected answer, so the collect job tries again later
        // rather than dropping the request as if it had no result.
        if (item === null) throw new Error('Anthropic batch results: an unexpected line');
        items.push(item);
      }
      return items;
    },
  };
}
