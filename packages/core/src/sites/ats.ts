// What ATS sites share (https://github.com/bgoleno/opportun/issues/769): a board slug, a job id as
// a board link carries it, and the `{ org }` config of a board source.
import { z } from 'zod';

/** A board slug, as the board's public API names it. */
export const ATS_SLUG = /^[a-z0-9-]{1,100}$/;

/** A job id as a board link carries it, by any provider. */
export const ATS_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** The source config of a Greenhouse, Lever or Ashby board. */
export const AtsOrgConfig = z.object({ org: z.string().regex(ATS_SLUG) }).strict();
