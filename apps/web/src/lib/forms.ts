// Small helpers shared by the settings forms.
import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { z } from 'zod';
import { ApiError, errorMessage } from './api';

/** "a, b,\nc" -> ['a', 'b', 'c'] (blank entries dropped). */
export function splitList(s: string): string[] {
  return s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

export function joinList(items: readonly string[] | null | undefined): string {
  return (items ?? []).join(', ');
}

/**
 * Digits, optionally grouped in threes with commas: `210000` and `210,000` both parse, `1,23`
 * does not. The shape is checked before parsing because `Number()` is the wrong judge twice
 * over: it reads `'1e5'` as 100000, and it reads any thousands separator as NaN, which is how
 * people actually write a salary.
 */
const WHOLE_NUMBER = /^(?:\d+|\d{1,3}(?:,\d{3})+)$/;

/** Text input to optional whole number: '' -> null; anything else must be an integer >= 0. */
export const optionalWholeNumber = z
  .string()
  .trim()
  .transform((s, ctx): number | null => {
    if (s === '') return null;
    const n = WHOLE_NUMBER.test(s) ? Number(s.replaceAll(',', '')) : Number.NaN;
    if (!Number.isSafeInteger(n) || n < 0) {
      ctx.addIssue({ code: 'custom', message: 'Enter a whole number, 0 or more' });
      return z.NEVER;
    }
    return n;
  });

/** Text input to optional trimmed string: '' -> null. */
export const optionalString = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Use at most ${max} characters`)
    .transform((s) => (s === '' ? null : s));

export const numberText = (n: number | null | undefined): string =>
  n === null || n === undefined ? '' : String(n);

/**
 * Applies a server 400 validation error to the matching fields. Returns the message for
 * the form-level banner (null when every issue landed on a field).
 */
export function applyServerError<T extends FieldValues>(
  err: unknown,
  setError: UseFormSetError<T>,
  fields: readonly string[],
): string | null {
  if (err instanceof ApiError && err.code === 'validation' && err.issues !== undefined) {
    let unplaced = false;
    for (const issue of err.issues) {
      // Fastify schema errors prefix the path with "body".
      const path = issue.path[0] === 'body' ? issue.path.slice(1) : issue.path;
      const field = path[0];
      if (typeof field === 'string' && fields.includes(field)) {
        setError(field as Path<T>, { type: 'server', message: issue.message });
      } else {
        unplaced = true;
      }
    }
    return unplaced ? errorMessage(err) : null;
  }
  return errorMessage(err);
}
