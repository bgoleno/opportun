// What ATS sites share (https://github.com/bgoleno/opportun/issues/769): a board slug, a job id as
// a board link carries it, and the `{ org }` config of a board source.
import { z } from 'zod';
import type { BoardRef } from './types';

/** A board slug, as the board's public API names it. */
export const ATS_SLUG = /^[a-z0-9-]{1,100}$/;

/** A job id as a board link carries it, by any provider. */
export const ATS_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** The source config of a Greenhouse, Lever or Ashby board. */
export const AtsOrgConfig = z.object({ org: z.string().regex(ATS_SLUG) }).strict();

/** `board.configOf` and `board.fromConfig` of a site whose boards are a slug on one host. */
export const orgBoards = (site: string) => ({
  configOf: (board: BoardRef): Record<string, unknown> => AtsOrgConfig.parse({ org: board.slug }),
  fromConfig: ({ org }: Record<string, unknown>): BoardRef | null =>
    typeof org === 'string' && ATS_SLUG.test(org) ? { site, slug: org } : null,
});
