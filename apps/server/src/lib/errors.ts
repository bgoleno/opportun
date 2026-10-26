/** An expected failure with a client-facing status and code; the central handler renders it. */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  /** Extra client-facing fields rendered next to `code` (never secrets). */
  readonly details: Record<string, string | number> | undefined;

  constructor(
    statusCode: number,
    code: string,
    message?: string,
    details?: Record<string, string | number>,
  ) {
    super(message ?? code);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const unauthorized = (): HttpError => new HttpError(401, 'unauthorized');
export const notFound = (): HttpError => new HttpError(404, 'not_found');

/** 409 for a create or rename that collides with an existing row the caller owns. */
export const duplicate = (existingId: string): HttpError =>
  new HttpError(409, 'duplicate', undefined, { existingId });

export const forbidden = (): HttpError => new HttpError(403, 'forbidden');
