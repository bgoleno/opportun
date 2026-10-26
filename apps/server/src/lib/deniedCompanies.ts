// Denylist matching (issue #199): denying a company must stop its postings from landing in the
// review queue, not just from being suggested to follow (companySuggest.ts was the only caller
// `denied` ever reached). This is the shared matching logic between ingest-time auto-suppression
// (discoveryRun.ts) and clearing a company's already-pending results on demand (routes/companies.ts).
import { companyMatchKey, type NormalizedPosting } from '@opportun/core';
import { and, eq } from 'drizzle-orm';
import { companies, discoveryResults, discoveryRuns, discoverySources } from '../db/schema';
import type { Exec, UserCtx } from '../repos/base';

export interface DeniedCompany {
  id: string;
  name: string;
  domain: string | null;
}

/** Every company this user has denied, for matching against postings. Loaded once per run or
 *  per request rather than once per posting: the denylist does not change mid-run. */
export async function loadDeniedCompanies(exec: Exec, ctx: UserCtx): Promise<DeniedCompany[]> {
  return await exec
    .select({ id: companies.id, name: companies.name, domain: companies.domain })
    .from(companies)
    .where(and(eq(companies.userId, ctx.userId), eq(companies.status, 'denied')))
    .all();
}

function urlHost(url: string | null | undefined): string | null {
  if (url == null) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** `host` matches `domain` itself or any of its subdomains, not merely contains it as a
 *  substring ("notmicrosoft.com" must not match a stored "microsoft.com"). */
function hostMatches(host: string, domain: string): boolean {
  const d = domain.toLowerCase();
  return host === d || host.endsWith(`.${d}`);
}

/**
 * Which denied company (if any) a posting matches. Checked in order:
 *
 * 1. `sourceCompanyId` -- the discovery source's own linked company, set when the source is a
 *    per-company board tracker (ats_greenhouse/lever/ashby/workday). A stored fact, not an
 *    inference, so it is checked first and wins even if the posting's own company text reads
 *    differently (a board occasionally mislabels its own employer in the feed).
 * 2. `companyMatchKey` on the posting's company text (packages/core/src/dedupe.ts): handles
 *    "Microsoft" vs "Microsoft Corporation" vs "microsoft, inc." the way the opportunity
 *    near-duplicate heuristic already does, reused rather than reinvented.
 * 3. The posting URL's host against the denied company's own stored `domain`, subdomains
 *    included. Mostly useful for alert-email/manual/extension postings whose link points
 *    directly at the employer's own careers page; board-aggregator sources' posting URLs are
 *    the board's own domain (boards.greenhouse.io, jobs.lever.co, ...), not the employer's, so
 *    this signal rarely fires for them -- (1) and (2) are what actually cover that case.
 *
 * Deliberately no subsidiary inference. Oracle owns NetSuite; Microsoft owns LinkedIn and
 * GitHub. Inferring that chain automatically is too easy to get wrong in either direction (a
 * false positive silently blocks a job the user might have wanted; a false negative gives false
 * confidence that denying the parent was enough) and would surprise the user either way.
 * Denial is per company, and the Companies tab says so, so the user can add the others
 * themselves if that is what they want.
 */
export function matchDeniedCompany(
  denied: readonly DeniedCompany[],
  sourceCompanyId: string | null,
  posting: Pick<NormalizedPosting, 'company' | 'postingUrl'>,
): DeniedCompany | undefined {
  if (sourceCompanyId !== null) {
    const bySource = denied.find((d) => d.id === sourceCompanyId);
    if (bySource !== undefined) return bySource;
  }
  const key = companyMatchKey(posting.company);
  const byName = denied.find((d) => companyMatchKey(d.name) === key);
  if (byName !== undefined) return byName;
  const host = urlHost(posting.postingUrl);
  if (host === null) return undefined;
  return denied.find((d) => d.domain !== null && hostMatches(host, d.domain));
}

/**
 * How many of the user's currently pending results match this one company (issue #199),
 * shown right after denying it: a count the user can act on themselves (via #184's bulk
 * triage, already shipped) rather than something this reads and silently drops. Deliberately
 * read-only -- no clearing, no bulk action here; see the issue this was cut from for why.
 */
export async function countPendingFromCompany(
  exec: Exec,
  ctx: UserCtx,
  company: DeniedCompany,
): Promise<number> {
  const rows = await exec
    .select({
      posting: discoveryResults.posting,
      sourceCompanyId: discoverySources.companyId,
    })
    .from(discoveryResults)
    .innerJoin(discoveryRuns, eq(discoveryRuns.id, discoveryResults.runId))
    .innerJoin(discoverySources, eq(discoverySources.id, discoveryRuns.sourceId))
    .where(
      and(eq(discoveryResults.userId, ctx.userId), eq(discoveryResults.disposition, 'pending')),
    )
    .all();
  let n = 0;
  for (const row of rows) {
    const posting = row.posting as Pick<NormalizedPosting, 'company' | 'postingUrl'>;
    if (matchDeniedCompany([company], row.sourceCompanyId, posting) !== undefined) n += 1;
  }
  return n;
}
