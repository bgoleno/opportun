// Ashby's network half (https://github.com/bgoleno/opportun/issues/769), moved unchanged from
// adapters/sources/ashby.ts (FR-D1). One request lists the board's jobs (no pagination); jobs the
// company marks unlisted are skipped. Its identity is packages/core/src/sites/ashby.ts.
import {
  ashby,
  ASHBY_API_HOST,
  exactHosts,
  type BoardRef,
  type NormalizedPosting,
} from '@opportun/core';
import { arr, atsOrg, fetchBoardJson, obj, str, timeMs } from '../adapters/sources/atsCommon';
import { askBoard, linksOf, servesJobs, slugOf } from './boardApi';
import type { SiteModule } from './types';

const boardUrl = (board: BoardRef): string =>
  `https://${ASHBY_API_HOST}/posting-api/job-board/${slugOf(board, 'Ashby')}`;

const urls = {
  board: (board: BoardRef, opts: { content?: boolean } = {}): string =>
    `${boardUrl(board)}${opts.content === true ? '?includeCompensation=true' : ''}`,
  probe: boardUrl,
};

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

export const ashbyModule: SiteModule = {
  identity: ashby,
  api: {
    urls,
    mapPosting: mapAshbyJob,
    slugAddressed: true,
    probe: (sctx, board) => askBoard(sctx, ashby, board, urls.probe, servesJobs),
    boardLinks: (body) => linksOf(obj(body).jobs, (job) => ({ text: job.title, url: job.jobUrl })),
    async *listBoard(sctx, config) {
      const org = atsOrg(config);
      const url = urls.board({ site: ashby.id, slug: org }, { content: true });
      const body = await fetchBoardJson(sctx, url, exactHosts(ashby.fetchHosts)[0]!, 'Ashby', org);
      for (const job of arr(obj(body).jobs)) {
        if (obj(job).isListed === false) continue;
        yield { posting: mapAshbyJob(job, org), nextCursor: null };
      }
    },
  },
};
