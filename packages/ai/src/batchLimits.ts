// The time limit of each batch client call (https://github.com/bgoleno/opportun/issues/686).
/**
 * How long one batch client call may take (#686, qa's third pass): with no limit of its own, a
 * provider that hung held a job worker for the fetch's own 300 s on every attempt. A control call
 * (a batch create, a state, a delete) is small; a transfer (the requests' upload, a results
 * download) carries up to a batch's whole text, so it gets longer.
 */
export const BATCH_CONTROL_LIMIT_MS = 60_000;
export const BATCH_TRANSFER_LIMIT_MS = 300_000;

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
