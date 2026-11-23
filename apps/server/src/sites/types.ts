// The job-site contract's network half (https://github.com/bgoleno/opportun/issues/769): what the
// server does for each route a site's identity (packages/core/src/sites) declares. A route the
// identity does not declare has nothing here, and the contract test
// (test/siteContract.test.ts) fails if the two disagree.
import type { NormalizedPosting, SiteIdentity } from '@opportun/core';
import type { DiscoverySource, SourceContext } from '../adapters/discoverySource';
import type { Recognition } from '../lib/linkedinCapture';

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

/** A tab the browser extension sent, as the capture route received it. */
export interface CaptureInputPage {
  url: string;
  title: string;
  text: string;
}

/** The server half of capture. It reads the text the user's own browser rendered (C-1). */
export interface SiteCapture {
  recognize(input: CaptureInputPage): Recognition;
  /**
   * The job description in a capture's stored text, or null when there is none to find. It is
   * deterministic and never calls AI: re-derive holds itself to the bar of a live capture with
   * no AI key (see lib/postingRederive.ts).
   */
  storedDescriptionOf(text: string): string | null;
}

/** The site's job-alert mail. */
export interface SiteAlertEmail {
  /** The addresses the alerts come from (mail only, never fetched). */
  readonly senders: readonly string[];
  /** The leads in an alert's text; none when it is not this site's alert. */
  parse(text: string): NormalizedPosting[];
}

export interface SiteModule {
  readonly identity: SiteIdentity;
  readonly api?: SiteApi;
  /** Through #777: the site's own MCP server. */
  readonly mcp?: never;
  readonly capture?: SiteCapture;
  readonly alertEmail?: SiteAlertEmail;
}
