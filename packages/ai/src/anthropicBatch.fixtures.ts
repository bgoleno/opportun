// Anthropic Message Batches responses, for the batch client's tests (#509, slice A of
// https://github.com/bgoleno/opportun/issues/358). Written from Anthropic's API reference, read on
// 2026-11-13, never from a call: no test and no step of building this slice calls the real API.
//   - Create a Message Batch: https://platform.claude.com/docs/en/api/messages/batches/create
//   - Retrieve a Message Batch: https://platform.claude.com/docs/en/api/messages/batches/retrieve
//   - Retrieve Message Batch results: https://platform.claude.com/docs/en/api/messages/batches/results
// The shapes, field names and values are the reference's; the ids, times and texts are made up.

export const BATCH_ID = 'msgbatch_013Zva2CMHLNnXjNJJKqJ2EF';

/** A MessageBatch object as the create and retrieve endpoints return it. */
export function messageBatch(
  processingStatus: 'in_progress' | 'canceling' | 'ended',
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  const ended = processingStatus === 'ended';
  return {
    id: BATCH_ID,
    type: 'message_batch',
    processing_status: processingStatus,
    request_counts: {
      processing: ended ? 0 : 5,
      succeeded: ended ? 2 : 0,
      errored: ended ? 1 : 0,
      canceled: ended ? 1 : 0,
      expired: ended ? 1 : 0,
    },
    created_at: '2026-11-13T18:37:24.100435Z',
    ended_at: ended ? '2026-11-13T19:02:11.481920Z' : null,
    expires_at: '2026-11-14T18:37:24.100435Z',
    archived_at: null,
    cancel_initiated_at: processingStatus === 'canceling' ? '2026-11-13T18:40:00.000000Z' : null,
    // Specified only once processing ends (the reference). The client never fetches it: it calls
    // the documented results endpoint on the operator's own base URL instead.
    results_url: ended ? `https://api.anthropic.com/v1/messages/batches/${BATCH_ID}/results` : null,
    ...over,
  };
}

/** One line of the results file: a succeeded request, its text and its usage. */
export function succeededLine(
  customId: string,
  text: string,
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number | null;
    cache_read_input_tokens: number | null;
  },
): Record<string, unknown> {
  return {
    custom_id: customId,
    result: {
      type: 'succeeded',
      message: {
        id: 'msg_01FqfsLoHwgeFbguDgpz48m7',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        stop_details: null,
        container: null,
        usage: {
          ...usage,
          cache_creation: null,
          inference_geo: null,
          output_tokens_details: null,
          server_tool_use: null,
          service_tier: 'batch',
          speed: 'standard',
        },
      },
    },
  };
}

/** An errored request: the error response the Messages API would have answered with. */
export function erroredLine(
  customId: string,
  type: 'invalid_request_error' | 'overloaded_error' | 'api_error',
  message: string,
): Record<string, unknown> {
  return {
    custom_id: customId,
    result: {
      type: 'errored',
      error: {
        type: 'error',
        error: { type, message },
        request_id: 'req_011CZkZaBF1tNoB5wlCeusgy',
      },
    },
  };
}

export const expiredLine = (customId: string) => ({
  custom_id: customId,
  result: { type: 'expired' },
});
export const canceledLine = (customId: string) => ({
  custom_id: customId,
  result: { type: 'canceled' },
});

/** The results file: JSON Lines, not in request order (the reference). */
export const jsonl = (lines: Record<string, unknown>[]): string =>
  lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

/** A Messages API response for the live call, for the test that captures its request body. */
export function liveMessage(text: string): Record<string, unknown> {
  return {
    id: 'msg_01Ab2Cd3Ef4Gh5Ij6Kl7Mn8O',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5-5',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 812,
      output_tokens: 64,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}
