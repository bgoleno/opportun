// The time limit of each batch client call (https://github.com/bgoleno/opportun/issues/686).
/**
 * How long one batch client call may take (#686, qa's third pass): with no limit of its own, a
 * provider that hung held a job worker for the fetch's own 300 s on every attempt. A control call
 * (a batch create, a state, a delete) is small. A transfer (the requests' upload, a results
 * download) carries up to a batch's whole text: at most RANK_BATCH_MAX (500) postings of a few
 * tens of KB each, about 10 MB, which 120 s moves at a slow uplink's 1 Mbit/s with room to spare
 * (tl on #715: not the 300 s hang the issue was about).
 */
export const BATCH_CONTROL_LIMIT_MS = 60_000;
export const BATCH_TRANSFER_LIMIT_MS = 120_000;

/** Tests set short ones; production uses the two above. */
export interface BatchCallLimits {
  controlMs: number;
  transferMs: number;
}

const DEFAULT_LIMITS: BatchCallLimits = {
  controlMs: BATCH_CONTROL_LIMIT_MS,
  transferMs: BATCH_TRANSFER_LIMIT_MS,
};

/**
 * A provider's fetch with a time limit on each call: control or transfer, the signal ending the
 * request and the reading of its body alike.
 */
export function timedFetches(doFetch: typeof fetch, limits: BatchCallLimits = DEFAULT_LIMITS) {
  const timed =
    (ms: number) =>
    (url: string, init: RequestInit): Promise<Response> =>
      doFetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  return { control: timed(limits.controlMs), transfer: timed(limits.transferMs) };
}

/**
 * A batch call the provider answered with a non-2xx status (#784, tl): it refused, so nothing was
 * made by that call. Anything else (a timeout, a dropped or cut-short body after a 2xx) is no
 * answer: the provider may have made the batch. The message names the call and the status only,
 * never the key or the provider's text.
 */
export class BatchRefusedError extends Error {
  constructor(
    readonly call: string,
    readonly status: number,
    provider: string,
  ) {
    super(`${provider} batch ${call}: HTTP ${status}`);
    this.name = 'BatchRefusedError';
  }
}
