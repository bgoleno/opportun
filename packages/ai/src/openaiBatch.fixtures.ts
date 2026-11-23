// OpenAI Batch API responses, for the batch client's tests (#510, slice B of
// https://github.com/bgoleno/opportun/issues/358). Written from OpenAI's documentation, read on
// 2026-11-20, never from a call: no test and no step of building this slice calls the real API.
//   - Batch API guide: https://developers.openai.com/api/docs/guides/batch
//   - Create batch: https://developers.openai.com/api/reference/resources/batches/methods/create
//   - Retrieve batch: https://developers.openai.com/api/reference/resources/batches/methods/retrieve
//   - The Batch object: https://developers.openai.com/api/reference/resources/batches
//   - Upload file: https://developers.openai.com/api/reference/resources/files/methods/create
//   - The Response object (a line's body):
//     https://developers.openai.com/api/reference/resources/responses/methods/retrieve
// (platform.openai.com/docs/... redirects to these pages.) The shapes, field names and values are
// the documentation's; the ids, times and texts are made up.

export const BATCH_ID = 'batch_abc123';
export const INPUT_FILE_ID = 'file-abc123';
export const OUTPUT_FILE_ID = 'file-cvaTdG';
export const ERROR_FILE_ID = 'file-HOWS94';

/** A File object, as the upload answers (the reference's fields). */
export function fileObject(id: string = INPUT_FILE_ID): Record<string, unknown> {
  return {
    id,
    object: 'file',
    bytes: 120000,
    created_at: 1795219200,
    filename: 'batch.jsonl',
    purpose: 'batch',
  };
}

export type Status =
  | 'validating'
  | 'failed'
  | 'in_progress'
  | 'finalizing'
  | 'completed'
  | 'expired'
  | 'cancelling'
  | 'cancelled';

/** A Batch object, as create and retrieve answer (the reference's fields). */
export function batchObject(
  status: Status,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  const done = status === 'completed' || status === 'expired' || status === 'cancelled';
  return {
    id: BATCH_ID,
    object: 'batch',
    endpoint: '/v1/responses',
    errors: null,
    input_file_id: INPUT_FILE_ID,
    completion_window: '24h',
    status,
    output_file_id: done ? OUTPUT_FILE_ID : null,
    error_file_id: done ? ERROR_FILE_ID : null,
    created_at: 1795219200,
    in_progress_at: status === 'validating' ? null : 1795219260,
    expires_at: 1795305600,
    finalizing_at: null,
    completed_at: status === 'completed' ? 1795222800 : null,
    failed_at: status === 'failed' ? 1795219230 : null,
    expired_at: status === 'expired' ? 1795305600 : null,
    cancelling_at: null,
    cancelled_at: status === 'cancelled' ? 1795220000 : null,
    request_counts: { total: 3, completed: done ? 2 : 0, failed: done ? 1 : 0 },
    metadata: null,
    ...over,
  };
}

/** A Response object (the Responses API's), with its output text and usage. */
export function responseBody(
  text: string,
  usage: { input?: number; cached?: number; output?: number } = {},
): Record<string, unknown> {
  const input = usage.input ?? 300;
  const output = usage.output ?? 20;
  return {
    id: 'resp_2',
    object: 'response',
    created_at: 1795219300,
    status: 'completed',
    error: null,
    incomplete_details: null,
    model: 'gpt-5-2025-08-07',
    output: [
      // A reasoning model's summary item comes first; it carries no answer text.
      { type: 'reasoning', id: 'rs_1', summary: [] },
      {
        type: 'message',
        id: 'msg_1',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
      },
    ],
    usage: {
      input_tokens: input,
      input_tokens_details: { cached_tokens: usage.cached ?? 0, cache_write_tokens: 0 },
      output_tokens: output,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: input + output,
    },
  };
}

/** One output-file line: a request that succeeded (the guide's shape). */
export function succeededLine(
  customId: string,
  text: string,
  usage?: Parameters<typeof responseBody>[1],
): Record<string, unknown> {
  return {
    id: 'batch_req_2',
    custom_id: customId,
    response: { status_code: 200, request_id: 'req_2', body: responseBody(text, usage) },
    error: null,
  };
}

/** One error-file line: a request the window closed on (the guide's example, verbatim). */
export function expiredLine(customId: string): Record<string, unknown> {
  return {
    id: 'batch_req_123',
    custom_id: customId,
    response: null,
    error: {
      code: 'batch_expired',
      message: 'This request could not be executed before the completion window expired.',
    },
  };
}

/**
 * One error-file line for a request the endpoint refused. The guide shows no example of this one,
 * only that a failed request's error goes to the error file; this is the line in the output's
 * own shape (a response with its status and the API's error body). The client also reads the
 * other shape the guide shows (`response: null` with `error`).
 */
export function refusedLine(
  customId: string,
  status = 400,
  type = 'invalid_request_error',
): Record<string, unknown> {
  return {
    id: 'batch_req_3',
    custom_id: customId,
    response: {
      status_code: status,
      request_id: 'req_3',
      body: {
        error: {
          message: 'Invalid schema for response_format: the request repeats sk-proj-QUOTED.',
          type,
          param: 'text.format.schema',
          code: null,
        },
      },
    },
    error: null,
  };
}

export const jsonl = (lines: readonly unknown[]): string =>
  lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
