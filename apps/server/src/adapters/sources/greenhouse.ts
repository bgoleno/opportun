// Greenhouse job board adapter (FR-D1). One request lists every open job of a board with its
// content; the API does not paginate this endpoint. Greenhouse HTML-escapes `content` once
// (`&lt;p&gt;`), which is undone here so the engine's sanitizer sees ordinary markup.
import type { NormalizedPosting } from '@opportun/core';
import { registerBuiltinSource, type DiscoverySource } from '../discoverySource';
import { arr, atsOrg, fetchBoardJson, obj, remoteFromLocation, str, timeMs } from './atsCommon';

export const GREENHOUSE_HOST = 'boards-api.greenhouse.io';

export const greenhouseBoardUrl = (org: string): string =>
  `https://${GREENHOUSE_HOST}/v1/boards/${org}/jobs?content=true`;

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

export const greenhouseSource: DiscoverySource = {
  kind: 'ats_greenhouse',
  async *fetchPostings(sctx, config) {
    const org = atsOrg(config);
    const body = await fetchBoardJson(
      sctx,
      greenhouseBoardUrl(org),
      GREENHOUSE_HOST,
      'Greenhouse',
      org,
    );
    for (const job of arr(obj(body).jobs)) {
      yield { posting: mapGreenhouseJob(job, org), nextCursor: null };
    }
  },
};

registerBuiltinSource(greenhouseSource);
