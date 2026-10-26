// Request and response building blocks shared by the /api/v1 resource routes.
import { z } from 'zod';

export const IdParams = z.object({ id: z.string().min(1).max(64) });

export const MAX_LIMIT = 200;
export const DEFAULT_LIMIT = 50;

/**
 * ?limit= (default 50, max 200), ?offset= and ?sort=, where sort is one of `sortKeys`,
 * optionally prefixed with '-' for descending. Extend it with resource filters.
 */
export function listQuery(sortKeys: readonly string[]) {
  const allowed = new Set(sortKeys);
  return z.object({
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    offset: z.coerce.number().int().min(0).default(0),
    sort: z
      .string()
      .refine((s) => allowed.has(s.startsWith('-') ? s.slice(1) : s), {
        message: `sort must be one of: ${sortKeys.join(', ')} (prefix '-' for descending)`,
      })
      .optional(),
  });
}

export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), total: z.number().int().nonnegative() });
}

/** http(s) only: a stored URL is rendered as a link, so javascript: and data: are out. */
export const HttpUrl = z.httpUrl().max(2048);

/** https only: a URL the server will fetch (safeFetch refuses anything else anyway). */
export const HttpsUrl = z
  .url()
  .max(2048)
  .refine((u) => u.startsWith('https://'), { message: 'must be an https URL' });

/** A nullable optional text field: trims, and an empty string clears it. */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s.length === 0 ? null : s))
    .nullish();
