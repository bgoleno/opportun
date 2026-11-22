// Queueing a company's homepage resolution (https://github.com/bgoleno/opportun/issues/763): the
// job's kind, its dedupe key and the enqueue call, in lib/ so the opportunities repo queues it
// without importing the job module (jobs/companyDomainResolve.ts), which reaches that repo back
// through opportunityEnrich.
import type { Db } from '../db/client';
import { enqueue } from '../jobs/runner';

export const COMPANY_DOMAIN_RESOLVE_KIND = 'company.domain_resolve'; // payload {companyId}
export const companyDomainResolveDedupeKey = (companyId: string): string =>
  `${COMPANY_DOMAIN_RESOLVE_KIND}:${companyId}`;

/** Queues resolution for one company, deduped so a flurry of stage moves costs one job. */
export async function enqueueCompanyDomainResolve(
  db: Db,
  userId: string,
  companyId: string,
): Promise<void> {
  await enqueue(
    db,
    COMPANY_DOMAIN_RESOLVE_KIND,
    { companyId },
    { dedupeKey: companyDomainResolveDedupeKey(companyId), userId },
  );
}
