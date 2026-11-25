// Lever's network half (https://github.com/bgoleno/opportun/issues/769), moved unchanged from
// adapters/sources/lever.ts (FR-D1). The postings API pages with skip/limit; pages are read until
// one comes back short. Each posting's description is its intro plus its titled lists plus the
// closing section, as Lever renders them on the hosted page. Its identity is
// packages/core/src/sites/lever.ts.
import {
  exactHosts,
  lever,
  LEVER_API_HOST,
  type BoardRef,
  type NormalizedPosting,
} from '@opportun/core';
import { arr, atsOrg, fetchBoardJson, obj, str, timeMs } from '../adapters/sources/atsCommon';
import { askBoard, linksOf, slugOf } from './boardApi';
import type { SiteModule } from './types';

export const LEVER_PAGE_SIZE = 100;
/** A runaway board (or a server ignoring skip) stops here. */
const MAX_PAGES = 50;

const postingsUrl = (board: BoardRef): string =>
  `https://${LEVER_API_HOST}/v0/postings/${slugOf(board, 'Lever')}?mode=json`;

const urls = {
  board: postingsUrl,
  page: (board: BoardRef, page: number): string =>
    `${postingsUrl(board)}&skip=${page * LEVER_PAGE_SIZE}&limit=${LEVER_PAGE_SIZE}`,
  probe: (board: BoardRef): string => `${postingsUrl(board)}&limit=1`,
};

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

export const leverModule: SiteModule = {
  identity: lever,
  api: {
    urls,
    mapPosting: mapLeverPosting,
    slugAddressed: true,
    probe: (sctx, board) =>
      askBoard(sctx, lever, board, urls.probe, (body) => arr(body).length > 0),
    boardLinks: (body) => linksOf(body, (job) => ({ text: job.text, url: job.hostedUrl })),
    async *listBoard(sctx, config) {
      const org = atsOrg(config);
      const board = { site: lever.id, slug: org };
      for (let page = 0; page < MAX_PAGES; page++) {
        const url = urls.page(board, page);
        const items = arr(
          await fetchBoardJson(sctx, url, exactHosts(lever.fetchHosts)[0]!, 'Lever', org),
        );
        for (const item of items) yield { posting: mapLeverPosting(item, org), nextCursor: null };
        if (items.length < LEVER_PAGE_SIZE) return;
      }
    },
  },
};
