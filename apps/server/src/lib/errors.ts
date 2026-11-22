/**
 * An expected failure with a client-facing status and code; the central handler renders it.
 *
 * Which text reaches the client (https://github.com/bgoleno/opportun/issues/750): the code and
 * the details always, the message only when the thrower marks it `userFacing`. Mark a message
 * only when it is a sentence written for the person using the app. It may echo values that person
 * sent or owns (their pattern, a file name of theirs). It must never be another error's text (a
 * caught error, a provider's or a library's message), a stack, a path, an id of someone else's
 * data, or anything from configuration. When in doubt, leave it unmarked and word the code on the
 * client. A marked message is cut to USER_MESSAGE_MAX characters, and the details may not carry
 * a `message` key: the handler drops one. test/userFacingErrors.test.ts checks both on every
 * `new HttpError(...)` in this package.
 */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  /** Extra client-facing fields rendered next to `code` (never secrets). */
  readonly details: Record<string, string | number> | undefined;
  /** Sent as the retry-after header (seconds), for a refusal the client may try again. */
  readonly retryAfterSec: number | undefined;
  /**
   * The sentence the client is sent, set only for a marked error that was given one. Not
   * `message`, which is the code when no sentence was given: a marked error without a sentence
   * sends no message rather than its code twice.
   */
  readonly userMessage: string | undefined;

  constructor(
    statusCode: number,
    code: string,
    message?: string,
    details?: Record<string, string | number>,
    opts: { retryAfterSec?: number; userFacing?: boolean } = {},
  ) {
    super(message ?? code);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.retryAfterSec = opts.retryAfterSec;
    this.userMessage = opts.userFacing === true ? message : undefined;
  }
}

/** The most of a marked message the client is sent, so a huge echoed input is not sent whole. */
export const USER_MESSAGE_MAX = 300;

export const unauthorized = (): HttpError => new HttpError(401, 'unauthorized');
export const notFound = (): HttpError => new HttpError(404, 'not_found');

/** 409 for a create or rename that collides with an existing row the caller owns. */
export const duplicate = (existingId: string): HttpError =>
  new HttpError(409, 'duplicate', undefined, { existingId });

export const forbidden = (): HttpError => new HttpError(403, 'forbidden');
