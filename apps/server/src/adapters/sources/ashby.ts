// Ashby job board adapter (FR-D1). One request lists the board's jobs (no pagination); jobs the
// company marks unlisted are skipped.
import type { NormalizedPosting } from '@opportun/core';
import { registerBuiltinSource, type DiscoverySource } from '../discoverySource';
import { arr, atsOrg, fetchBoardJson, obj, str, timeMs } from './atsCommon';

export const ASHBY_HOST = 'api.ashbyhq.com';

export const ashbyBoardUrl = (org: string): string =>
  `https://${ASHBY_HOST}/posting-api/job-board/${org}?includeCompensation=true`;

function remote(job: Record<string, unknown>): boolean | null {
  if (job.isRemote === true) return true;
  if (job.workplaceType === 'OnSite') return false;
  return null;
}

export function mapAshbyJob(raw: unknown, org: string): NormalizedPosting {
  const job = obj(raw);
  return {
    company: org,
    title: str(job.title) ?? '',
    descriptionMd: str(job.descriptionHtml) ?? str(job.descriptionPlain),
    postingUrl: str(job.jobUrl),
    location: str(job.location),
    remote: remote(job),
    compNote: str(obj(job.compensation).compensationTierSummary),
    externalId: str(job.id),
    postedAt: timeMs(job.publishedAt),
  };
}

export const ashbySource: DiscoverySource = {
  kind: 'ats_ashby',
  async *fetchPostings(sctx, config) {
    const org = atsOrg(config);
    const body = await fetchBoardJson(sctx, ashbyBoardUrl(org), ASHBY_HOST, 'Ashby', org);
    for (const job of arr(obj(body).jobs)) {
      if (obj(job).isListed === false) continue;
      yield { posting: mapAshbyJob(job, org), nextCursor: null };
    }
  },
};

registerBuiltinSource(ashbySource);
