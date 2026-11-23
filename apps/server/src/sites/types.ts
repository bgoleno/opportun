// The job-site contract's network half (https://github.com/bgoleno/opportun/issues/769): what the
// server does for each route a site's identity (packages/core/src/sites) declares. A route the
// identity does not declare has nothing here, and the contract test
// (test/siteContract.test.ts) fails if the two disagree.
import type { NormalizedPosting, SiteIdentity } from '@opportun/core';
import type { DiscoverySource, SourceContext } from '../adapters/discoverySource';

export interface SiteApi {
  /** The API's URLs, each built only from a slug and id of the shapes a real board uses. */
  readonly urls: {
    /** A board's listing; with `content`, each job's description too. */
    board(slug: string, opts?: { content?: boolean }): string;
    /** One job of a board. */
    job?(slug: string, id: string): string;
  };
  /** Every open job of a board (the `boardListing` and `description` supplies). */
  readonly listBoard?: DiscoverySource['fetchPostings'];
  /** One job of the API's answer, as a posting. */
  mapPosting?(raw: unknown, board: string): NormalizedPosting;
  /** Whether board `slug` holds job `id` (the `byId` supply); 'unknown' when no answer came. */
  holdsJob?(
    sctx: Pick<SourceContext, 'fetch' | 'log'>,
    slug: string,
    id: string,
    timeoutMs: number | undefined,
  ): Promise<'yes' | 'no' | 'unknown'>;
}

export interface SiteModule {
  readonly identity: SiteIdentity;
  readonly api?: SiteApi;
  /** Through #777: the site's own MCP server. */
  readonly mcp?: never;
  /** Moved here at step 3: the server half of capture, today's recognizer for the site. */
  readonly capture?: never;
  /** Moved here at step 3: the site's alert parser. */
  readonly alertEmail?: never;
}
