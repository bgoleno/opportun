// OpenAI's batch client for ranking (#510, slice B of https://github.com/bgoleno/opportun/issues/358;
// tl's slice text issuecomment-6871513480). The Batch API is plain HTTP, so this is a small client
// of it rather than a new dependency, as Anthropic's is (anthropicBatch.ts):
//   - POST {base}/files                   the requests, as one JSON Lines file (purpose `batch`)
//   - POST {base}/batches                 the batch, on the live call's endpoint, in 24 hours
//   - GET  {base}/batches/{id}            state
//   - GET  {base}/files/{id}/content      the output file and the error file
//   - DELETE {base}/files/{id}            cleanup: the three files, once the results are applied (#634)
// Built as every provider client here is (#334, #344): the server's explicit fetch and the
// operator's base URL, never the environment and never a global fetch; the key only in the
// Authorization header, and never in an error, a log or a span. Written against OpenAI's
// documentation (see openaiBatch.fixtures.ts for the pages and the date read): no call to the real
// API was made to build it, and the owner's own batch confirms it (slice C, #511).
//
// Only OpenAI's own API: a line of the batch file names its endpoint as an OpenAI path
// (`/v1/responses`), which a gateway or proxy at another base URL need not serve, so with the
// operator's OPENAI_BASE_URL set elsewhere batchProviderFor has no client and ranking is live
// (criterion 1; isOpenAiBatchBase).
import { generateText, Output } from 'ai';
import type { BatchProvider, BatchRequest, BatchResultItem, BatchState, BatchUsage } from './batch';
import { createLanguageModel } from './providers';
import { SDK_TELEMETRY_OFF } from './telemetry';
import { OFFICIAL_BASE_URLS, type ModelPolicy, type ProviderFetchOptions } from './types';

/**
 * The endpoints a batch line may name (the guide's list). The live call's own must be one of
 * them, or there is no batch for it.
 */
const BATCH_ENDPOINTS: ReadonlySet<string> = new Set([
  '/v1/responses',
  '/v1/chat/completions',
  '/v1/embeddings',
  '/v1/completions',
  '/v1/moderations',
  '/v1/images/generations',
  '/v1/images/edits',
]);

/** The only completion window the Batch API takes (the create reference). */
export const COMPLETION_WINDOW = '24h';

/** The guide's limit: a batch holds at most this many requests. */
export const MAX_BATCH_REQUESTS = 50_000;

/**
 * How long OpenAI keeps a batch's output and error files when cleanup cannot remove them (#634):
 * the create reference's `output_expires_after`, from the file's creation, 1 hour to 30 days, 30
 * by default. A week leaves the collect job, which looks every 30 minutes, days to read them even
 * while a key is missing, and bounds what stays at OpenAI if every delete fails. The input file
 * keeps OpenAI's default for `purpose=batch`, 30 days: it must outlive the 24-hour window, and the
 * upload's own expiry is a multipart field whose encoding the reference does not show.
 */
export const OUTPUT_EXPIRES_SECONDS = 7 * 24 * 60 * 60;

/** The key the SDK is given while it builds a request's body: never a real key (see liveBody). */
const PLACEHOLDER_KEY = 'sk-placeholder-for-a-batch-body';

/** A base URL without its trailing slashes, by a loop (CodeQL js/polynomial-redos on #534). */
function trimmed(base: string): string {
  let out = base;
  while (out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

/**
 * Whether batches go to this OpenAI base URL: OpenAI's own API only. Unset is OpenAI's own; the
 * operator's OPENAI_BASE_URL anywhere else (a gateway, a proxy) is not.
 */
export function isOpenAiBatchBase(providerFetch: ProviderFetchOptions): boolean {
  const base = providerFetch.baseUrls?.openai;
  return base === undefined || trimmed(base) === OFFICIAL_BASE_URLS.openai;
}

/**
 * A request's line: the endpoint and body the live call sends for it, built by the very code that
 * sends the live call (the AI SDK's OpenAI provider, called as runStructured calls it), and
 * captured on its way out instead of sent. So a batch asks exactly what a live call would, the
 * structured output format and the SDK's rewriting of the schema included, and a later SDK change
 * to the live call changes the batch's too (criterion 3; openaiBatch.test.ts pins the equality).
 */
async function liveRequest(
  policy: ModelPolicy,
  request: BatchRequest['request'],
): Promise<{ url: string; body: Record<string, unknown> }> {
  let sent: { url: string; body: Record<string, unknown> } | null = null;
  const capture = (async (input: string | URL | Request, init?: RequestInit) => {
    sent = {
      url: new URL(input instanceof Request ? input.url : String(input)).pathname,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    // An answer the SDK takes as a refusal, so it stops here and nothing else is attempted.
    return new Response(
      JSON.stringify({
        error: { message: 'captured for a batch', type: 'invalid_request_error', code: null },
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  // OpenAI's own base URL, as batchProviderFor allows no other: the path is then the endpoint.
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
  const captured = sent as { url: string; body: Record<string, unknown> } | null;
  if (captured === null) throw new Error('OpenAI batch: the request body could not be built');
  if (!BATCH_ENDPOINTS.has(captured.url)) {
    throw new Error('OpenAI batch: the live call is on an endpoint batches do not take');
  }
  // Only the endpoint and the body are carried: a batch line has no headers of its own. Today the
  // live call sends none that changes the answer; if a later SDK does, look here.
  return captured;
}

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** A provider's code or type as a ledger detail: a short word, or `unknown`, never its text. */
function codeOf(v: unknown): string {
  return typeof v === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(v) ? v : 'unknown';
}

/** A Response object's answer, as the live call reads it: the output_text parts, joined. */
function answerOf(body: Json): { text: string; usage: BatchUsage } | null {
  if (!Array.isArray(body.output) || !isRecord(body.usage)) return null;
  const text = body.output
    .filter((item): item is Json => isRecord(item) && item.type === 'message')
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((part): part is Json => isRecord(part) && part.type === 'output_text')
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('');
  const u = body.usage;
  const details = isRecord(u.input_tokens_details) ? u.input_tokens_details : {};
  // input_tokens counts the cached ones too (the Response object's usage), as BatchUsage.input
  // and the live path's usage do. A refusal, or an answer cut short, leaves text that does not
  // parse: the caller counts it invalid_output, as the live call's second invalid answer is.
  return {
    text,
    usage: {
      input: count(u.input_tokens),
      output: count(u.output_tokens),
      cacheRead: count(details.cached_tokens),
      cacheWrite: count(details.cache_write_tokens),
    },
  };
}

/** One line of the output or the error file, as the guide gives them; null if not understood. */
function resultItem(line: unknown): BatchResultItem | null {
  if (!isRecord(line) || typeof line.custom_id !== 'string' || line.custom_id === '') return null;
  const customId = line.custom_id;
  if (isRecord(line.error)) {
    const code = codeOf(line.error.code);
    // The guide's line for a request the window closed on. Anything else named only by an error
    // is that request errored, and tried again in a later batch.
    if (code === 'batch_expired') return { customId, kind: 'expired' };
    return { customId, kind: 'errored', invalidRequest: false, detail: code };
  }
  const response = line.response;
  if (!isRecord(response) || typeof response.status_code !== 'number') return null;
  const body = isRecord(response.body) ? response.body : {};
  if (response.status_code === 200) {
    const answer = answerOf(body);
    if (answer === null) return null;
    return { customId, kind: 'succeeded', ...answer };
  }
  // The endpoint refused this request: its error's type only, never its message, which is the
  // provider's words and can quote the request; and it goes to the ledger.
  const error = isRecord(body.error) ? body.error : {};
  const type = codeOf(error.type);
  return {
    customId,
    kind: 'errored',
    invalidRequest: type === 'invalid_request_error',
    detail: type === 'unknown' ? `http_${String(response.status_code)}` : type,
  };
}

/** OpenAI's Batch API, for one policy and key. See the file's top for what it may reach. */
export function createOpenAiBatchProvider(target: {
  policy: ModelPolicy;
  apiKey: string;
  providerFetch: ProviderFetchOptions;
}): BatchProvider {
  const { policy, apiKey, providerFetch } = target;
  // The same fetch and base URL as the live OpenAI client (providers.ts createLanguageModel).
  const doFetch = providerFetch.officialFetch ?? providerFetch.fetch;
  const base = trimmed(providerFetch.baseUrls?.openai ?? OFFICIAL_BASE_URLS.openai);
  const auth = { authorization: `Bearer ${apiKey}` };
  /** A refusal names what was asked and the status only: never the key or the provider's text. */
  const refused = (what: string, status: number) =>
    new Error(`OpenAI batch ${what}: HTTP ${status}`);
  const id = (v: string) => encodeURIComponent(v);

  async function getBatch(batchId: string): Promise<Json | 'gone'> {
    const res = await doFetch(`${base}/batches/${id(batchId)}`, { method: 'GET', headers: auth });
    if (res.status === 404) return 'gone';
    if (!res.ok) throw refused('state', res.status);
    const batch = (await res.json()) as unknown;
    if (!isRecord(batch)) throw new Error('OpenAI batch state: an unexpected answer');
    return batch;
  }

  /**
   * A file's lines, parsed; a line that is not JSON is kept as undefined for the caller. A file
   * OpenAI no longer has (404: past its expiry, OUTPUT_EXPIRES_SECONDS, or deleted) has no lines:
   * its requests then have no result, and the collect job returns them to waiting, as expired
   * ones (tl on #657). Throwing instead would keep the batch in flight, and the user's next one
   * unsent, for ever.
   */
  async function fileLines(fileId: string, what: string): Promise<unknown[]> {
    const res = await doFetch(`${base}/files/${id(fileId)}/content`, {
      method: 'GET',
      headers: auth,
    });
    if (res.status === 404) return [];
    if (!res.ok) throw refused(what, res.status);
    const out: unknown[] = [];
    for (const raw of (await res.text()).split('\n')) {
      if (raw.trim() === '') continue;
      try {
        out.push(JSON.parse(raw));
      } catch {
        out.push(undefined);
      }
    }
    return out;
  }

  return {
    async submit(requests) {
      if (requests.length === 0 || requests.length > MAX_BATCH_REQUESTS) {
        throw new Error('OpenAI batch submit: a batch holds 1 to 50,000 requests');
      }
      // Every custom_id unique (the guide), so each result names one request.
      const ids = new Set(requests.map((r) => r.customId));
      if (ids.size !== requests.length || ids.has('')) {
        throw new Error('OpenAI batch submit: custom ids must be unique and not empty');
      }
      const lines = await Promise.all(
        requests.map(async (r) => {
          const live = await liveRequest(policy, r.request);
          return { custom_id: r.customId, method: 'POST', url: live.url, body: live.body };
        }),
      );
      // One file, one endpoint: every line is the same policy's, so the same live endpoint.
      const endpoint = lines[0]!.url;
      if (lines.some((l) => l.url !== endpoint)) {
        throw new Error('OpenAI batch submit: the requests are on different endpoints');
      }
      const form = new FormData();
      form.append('purpose', 'batch');
      form.append(
        'file',
        new Blob([lines.map((l) => JSON.stringify(l)).join('\n') + '\n'], {
          type: 'application/jsonl',
        }),
        'batch.jsonl',
      );
      const upload = await doFetch(`${base}/files`, { method: 'POST', headers: auth, body: form });
      if (!upload.ok) throw refused('upload', upload.status);
      const file = (await upload.json()) as unknown;
      if (!isRecord(file) || typeof file.id !== 'string') {
        throw new Error('OpenAI batch upload: an unexpected answer');
      }
      const res = await doFetch(`${base}/batches`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          input_file_id: file.id,
          endpoint,
          completion_window: COMPLETION_WINDOW,
          output_expires_after: { anchor: 'created_at', seconds: OUTPUT_EXPIRES_SECONDS },
        }),
      });
      if (!res.ok) {
        // No batch will read it: the uploaded requests go too (tl on #657), best effort, and the
        // refusal is what the caller hears either way. Kept otherwise, the 30-day default ends it.
        await doFetch(`${base}/files/${id(file.id)}`, { method: 'DELETE', headers: auth }).catch(
          () => undefined,
        );
        throw refused('submit', res.status);
      }
      const batch = (await res.json()) as unknown;
      if (!isRecord(batch) || typeof batch.id !== 'string') {
        throw new Error('OpenAI batch submit: an unexpected answer');
      }
      return { batchId: batch.id };
    },

    async state(batchId): Promise<BatchState> {
      const batch = await getBatch(batchId);
      if (batch === 'gone') return 'gone';
      switch (batch.status) {
        case 'validating':
        case 'in_progress':
        case 'finalizing':
          return 'in_progress';
        // Criterion 1: these five are ended, cancelling included; what each request got is
        // read from the files (results), and a request in neither counts as expired.
        case 'completed':
        case 'failed':
        case 'expired':
        case 'cancelling':
        case 'cancelled':
          return 'ended';
        default:
          throw new Error('OpenAI batch state: an unexpected status');
      }
    },

    async results(batchId) {
      // The file ids from the batch itself, read on the operator's own base URL: never a URL a
      // response names, so the key goes nowhere a response could point it.
      const batch = await getBatch(batchId);
      if (batch === 'gone') throw new Error('OpenAI batch results: the batch is gone');
      const items: BatchResultItem[] = [];
      const seen = new Set<string>();
      const files: [unknown, string][] = [
        [batch.output_file_id, 'results'],
        [batch.error_file_id, 'errors'],
      ];
      for (const [fileId, what] of files) {
        if (typeof fileId !== 'string') continue;
        for (const line of await fileLines(fileId, what)) {
          const item = resultItem(line);
          // One line not understood is an unexpected answer, so the collect job tries again
          // later rather than dropping the request as if it had no result.
          if (item === null) throw new Error(`OpenAI batch ${what}: an unexpected line`);
          if (seen.has(item.customId)) continue;
          seen.add(item.customId);
          items.push(item);
        }
      }
      // A request in neither file (a batch that failed validation, or one cancelled before it
      // ran) has no item here, and the collect job returns it to waiting exactly as an expired one
      // (rankBatch.ts: every posting still linked after the results is unlinked), which is how it
      // counts as expired (criterion 1). Its ids would be the input file's, but the documentation
      // does not say a `batch` input file may be downloaded, so this does not ask for it.
      return items;
    },

    async cleanup(batchId) {
      // The batch's three files, deleted (DELETE /files/{id}, the files reference): the requests
      // (the input file) and the results (output and error). The batch object itself cannot be
      // deleted. Each is tried even when another is refused, and gone already is removed.
      const batch = await getBatch(batchId);
      if (batch === 'gone') return;
      const ids = [batch.input_file_id, batch.output_file_id, batch.error_file_id].filter(
        (v): v is string => typeof v === 'string' && v !== '',
      );
      let refusal: Error | null = null;
      for (const fileId of ids) {
        const res = await doFetch(`${base}/files/${id(fileId)}`, {
          method: 'DELETE',
          headers: auth,
        });
        if (res.status === 404 || res.ok) continue;
        refusal ??= refused('delete', res.status);
      }
      if (refusal !== null) throw refusal;
    },
  };
}
