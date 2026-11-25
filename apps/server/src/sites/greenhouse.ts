// Greenhouse's network half (https://github.com/bgoleno/opportun/issues/769), moved unchanged from
// adapters/sources/greenhouse.ts (the board listing, FR-D1) and lib/greenhouseEmbed.ts (the job
// check). Its identity is packages/core/src/sites/greenhouse.ts. The API's board listing is one
// request with every open job's content, not paginated. Greenhouse HTML-escapes `content` once
// (`&lt;p&gt;`), which is undone here so the engine's sanitizer sees ordinary markup.
import {
  ATS_JOB_ID,
  GREENHOUSE_API_HOST,
  greenhouse,
  type BoardRef,
  type NormalizedPosting,
} from '@opportun/core';
import {
  arr,
  ATS_MAX_BYTES,
  atsOrg,
  fetchBoardJson,
  obj,
  remoteFromLocation,
  str,
  timeMs,
} from '../adapters/sources/atsCommon';
import { askBoard, linksOf, segment, servesJobs, slugOf } from './boardApi';
import type { SiteModule } from './types';

const jobsUrl = (board: BoardRef): string =>
  `https://${GREENHOUSE_API_HOST}/v1/boards/${slugOf(board, 'Greenhouse')}/jobs`;

const urls = {
  board: (board: BoardRef, opts: { content?: boolean } = {}): string =>
    `${jobsUrl(board)}${opts.content === true ? '?content=true' : ''}`,
  // The jobs list rather than the board's metadata, which cannot show whether it is serving
  // anything. Without `content=true` the response carries titles and ids only.
  probe: jobsUrl,
  job: (board: BoardRef, id: string): string =>
    `${jobsUrl(board)}/${segment(id, ATS_JOB_ID, 'Greenhouse job id')}`,
};

const ESCAPES: ReadonlyMap<string, string> = new Map([
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&#39;', "'"],
  ['&amp;', '&'],
]);

/** Reverses one level of HTML escaping (a single pass, so `&amp;lt;` becomes `&lt;`). */
export function unescapeOnce(value: string): string {
  return value.replace(/&(?:lt|gt|quot|#39|amp);/g, (m) => ESCAPES.get(m) ?? m);
}

export function mapGreenhouseJob(raw: unknown, org: string): NormalizedPosting {
  const job = obj(raw);
  const location = str(obj(job.location).name);
  const content = str(job.content);
  return {
    company: str(job.company_name) ?? org,
    title: str(job.title) ?? '',
    descriptionMd: content === null ? null : unescapeOnce(content),
    postingUrl: str(job.absolute_url),
    location,
    remote: remoteFromLocation(location),
    compNote: null,
    externalId: str(job.id),
    postedAt: timeMs(job.first_published ?? job.updated_at),
  };
}

export const greenhouseModule: SiteModule = {
  identity: greenhouse,
  api: {
    urls,
    mapPosting: mapGreenhouseJob,
    slugAddressed: true,
    probe: (sctx, board) => askBoard(sctx, greenhouse, board, urls.probe, servesJobs),
    boardLinks: (body) =>
      linksOf(obj(body).jobs, (job) => ({ text: job.title, url: job.absolute_url })),
    async *listBoard(sctx, config) {
      const org = atsOrg(config);
      const body = await fetchBoardJson(
        sctx,
        urls.board({ site: greenhouse.id, slug: org }, { content: true }),
        greenhouse.fetchHosts[0]!,
        'Greenhouse',
        org,
      );
      for (const job of arr(obj(body).jobs)) {
        yield { posting: mapGreenhouseJob(job, org), nextCursor: null };
      }
    },
    /**
     * What Greenhouse's API says about board `token` and job `jid`: it holds it, it does not, or no
     * answer came (the request failed, timed out, or the board was busy: #685, a later check can
     * ask again). `timeoutMs` undefined is the fetch's own limit.
     */
    async holdsJob(sctx, token, jid, timeoutMs) {
      let res;
      try {
        res = await sctx.fetch(urls.job({ site: greenhouse.id, slug: token }, jid), {
          allowHosts: greenhouse.fetchHosts,
          maxBytes: ATS_MAX_BYTES,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
      } catch (err) {
        // The token names the company's board: only the kind is logged (design 14.8).
        sctx.log.warn(
          { 'opportun.ats.kind': 'ats_greenhouse', err },
          'greenhouse job check failed',
        );
        return 'unknown';
      }
      if (res.status === 429 || res.status >= 500) return 'unknown';
      if (res.status !== 200) return 'no';
      try {
        const body = JSON.parse(res.body.toString('utf8')) as { id?: unknown };
        return String(body.id) === jid ? 'yes' : 'no';
      } catch {
        return 'no';
      }
    },
  },
};
