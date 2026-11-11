// What Opportun holds for the user's next application (#411, slice 1 of
// https://github.com/bgoleno/opportun/issues/401; tl's design note issuecomment-6794002888): the
// three sources loaded for the caller only, and core's resolveApplicationDetails deciding each
// field. Used to fill a new draft (repos/submissions.ts) and by GET /profile/application-details.
import {
  resolveApplicationDetails,
  type ApplicationDetailsPrefill,
  type DetailSources,
} from '@opportun/core';
import { and, desc, eq, isNotNull, ne } from 'drizzle-orm';
import { applicationSubmissions, companies, opportunities, profiles, users } from '../db/schema';
import type { Exec, UserCtx } from './base';

/**
 * The caller's sources. `excluding` is the draft being filled, which is never its own "last
 * application" even after a review: the one most recently reviewed attempt is any other of the
 * caller's attempts, on any opportunity, and each field comes from that attempt alone (tl).
 * Every read is filtered by the caller's user id (FR-S5).
 */
export async function detailSourcesFor(
  exec: Exec,
  ctx: UserCtx,
  opts: { excluding: string | null },
): Promise<DetailSources> {
  const profile = await exec.select().from(profiles).where(eq(profiles.userId, ctx.userId)).get();
  const account = await exec
    .select({ email: users.email, displayName: users.displayName })
    .from(users)
    .where(eq(users.id, ctx.userId))
    .get();
  const reviewed = and(
    eq(applicationSubmissions.userId, ctx.userId),
    isNotNull(applicationSubmissions.reviewedAt),
    ...(opts.excluding === null ? [] : [ne(applicationSubmissions.id, opts.excluding)]),
  );
  const last = await exec
    .select({
      submissionId: applicationSubmissions.id,
      opportunityId: applicationSubmissions.opportunityId,
      companyName: companies.name,
      reviewedAt: applicationSubmissions.reviewedAt,
      fields: applicationSubmissions.fields,
    })
    .from(applicationSubmissions)
    .innerJoin(
      opportunities,
      and(
        eq(opportunities.id, applicationSubmissions.opportunityId),
        eq(opportunities.userId, ctx.userId),
      ),
    )
    .innerJoin(
      companies,
      and(eq(companies.id, opportunities.companyId), eq(companies.userId, ctx.userId)),
    )
    .where(reviewed)
    .orderBy(desc(applicationSubmissions.reviewedAt), desc(applicationSubmissions.id))
    .limit(1)
    .get();
  return {
    profile: {
      fullName: profile?.fullName ?? null,
      email: profile?.email ?? null,
      phone: profile?.phone ?? null,
      location: profile?.location ?? null,
      workAuth: profile?.workAuth ?? null,
      links: profile?.links ?? [],
      applicationDetails: profile?.applicationDetails ?? {},
    },
    account: { email: account?.email ?? null, displayName: account?.displayName ?? null },
    lastApplication:
      last === undefined || last.reviewedAt === null
        ? null
        : { ...last, reviewedAt: last.reviewedAt },
  };
}

/** Each value Opportun holds for the caller's next application, with its source. */
export async function applicationDetailsFor(
  exec: Exec,
  ctx: UserCtx,
  opts: { excluding: string | null } = { excluding: null },
): Promise<ApplicationDetailsPrefill> {
  return resolveApplicationDetails(await detailSourcesFor(exec, ctx, opts));
}
