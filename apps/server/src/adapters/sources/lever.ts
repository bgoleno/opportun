// Lever postings adapter (FR-D1). The postings API pages with skip/limit; pages are read until
// one comes back short. Each posting's description is its intro plus its titled lists plus the
// closing section, as Lever renders them on the hosted page.
import type { NormalizedPosting } from '@opportun/core';
import { registerBuiltinSource, type DiscoverySource } from '../discoverySource';
import { arr, atsOrg, fetchBoardJson, obj, str, timeMs } from './atsCommon';

export const LEVER_HOST = 'api.lever.co';
export const LEVER_PAGE_SIZE = 100;
/** A runaway board (or a server ignoring skip) stops here. */
const MAX_PAGES = 50;

export const leverPostingsUrl = (org: string, skip: number): string =>
  `https://${LEVER_HOST}/v0/postings/${org}?mode=json&skip=${skip}&limit=${LEVER_PAGE_SIZE}`;

function description(p: Record<string, unknown>): string | null {
  const parts: string[] = [];
  const intro = str(p.description) ?? str(p.descriptionPlain);
  if (intro !== null) parts.push(intro);
  for (const raw of arr(p.lists)) {
    const list = obj(raw);
    const heading = str(list.text);
    const content = str(list.content);
    if (heading !== null) parts.push(`<h3>${heading}</h3>`);
    if (content !== null) parts.push(`<ul>${content}</ul>`);
  }
  const closing = str(p.additional) ?? str(p.additionalPlain);
  if (closing !== null) parts.push(closing);
  return parts.length === 0 ? null : parts.join('');
}

function compNote(raw: unknown): string | null {
  const range = obj(raw);
  const min = str(range.min);
  const max = str(range.max);
  if (min === null && max === null) return null;
  const amount = min !== null && max !== null ? `${min}-${max}` : (min ?? max);
  const interval = str(range.interval)
    ?.replace(/-salary$/, '')
    .replace(/-/g, ' ');
  return [str(range.currency), amount, interval].filter((x) => x != null).join(' ');
}

function remote(workplaceType: unknown): boolean | null {
  if (workplaceType === 'remote') return true;
  if (workplaceType === 'on-site') return false;
  return null;
}

export function mapLeverPosting(raw: unknown, org: string): NormalizedPosting {
  const p = obj(raw);
  return {
    company: org,
    title: str(p.text) ?? '',
    descriptionMd: description(p),
    postingUrl: str(p.hostedUrl),
    location: str(obj(p.categories).location),
    remote: remote(p.workplaceType),
    compNote: compNote(p.salaryRange),
    externalId: str(p.id),
    postedAt: timeMs(p.createdAt),
  };
}

export const leverSource: DiscoverySource = {
  kind: 'ats_lever',
  async *fetchPostings(sctx, config) {
    const org = atsOrg(config);
    for (let page = 0; page < MAX_PAGES; page++) {
      const skip = page * LEVER_PAGE_SIZE;
      const items = arr(
        await fetchBoardJson(sctx, leverPostingsUrl(org, skip), LEVER_HOST, 'Lever', org),
      );
      for (const item of items) yield { posting: mapLeverPosting(item, org), nextCursor: null };
      if (items.length < LEVER_PAGE_SIZE) return;
    }
  },
};

registerBuiltinSource(leverSource);
