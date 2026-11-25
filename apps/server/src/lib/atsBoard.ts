// What an ATS board link names (https://github.com/bgoleno/opportun/issues/763): the board kinds,
// a board's slug, and reading a board from a URL or a source config. Pure, so repos and lib use
// it without importing the detection job (jobs/atsDetect.ts), which imports the repos back.
import {
  ATS_SITES,
  type BoardRef,
  type DiscoverySourceKind,
  type SiteIdentity,
} from '@opportun/core';
import { SourceConfigError } from '../adapters/discoverySource';

export const SLUG = /^[a-z0-9-]{1,100}$/;

export type AtsKind = Extract<DiscoverySourceKind, `ats_${string}`>;

/**
 * A board a link points at. `slug` is the board key: the org slug, or for Workday
 * `<tenant>/<site>`, whose `host` (carrying the datacenter label) is kept beside it.
 */
export interface AtsBoard {
  kind: AtsKind;
  slug: string;
  host?: string;
}

const siteOf = (kind: string): SiteIdentity | undefined =>
  ATS_SITES.find((s) => s.sourceKind === kind);

const refOf = (site: SiteIdentity, { slug, host }: Pick<AtsBoard, 'slug' | 'host'>): BoardRef => ({
  site: site.id,
  slug,
  ...(host === undefined ? {} : { host }),
});

const atsBoardOf = (site: SiteIdentity, { slug, host }: BoardRef): AtsBoard => ({
  kind: site.sourceKind as AtsKind,
  slug,
  ...(host === undefined ? {} : { host }),
});

/**
 * The source config of a board, its site's: `{org}`, or Workday's `{host, tenant, site}`. A board that
 * is none of its site's is a wrong config, as its adapter would say, so a job does not retry it.
 */
export function boardConfig(board: AtsBoard): Record<string, unknown> {
  const site = siteOf(board.kind);
  try {
    if (site !== undefined) return site.board!.configOf(refOf(site, board));
  } catch {
    // Below. The parse error is not passed on: it quotes the value.
  }
  throw new SourceConfigError(`not a board of ${site?.label ?? 'any site'}`);
}

/** The board a source config names; null when it names none (an invalid or foreign config). */
export function boardOfSource(kind: string, config: Record<string, unknown>): AtsBoard | null {
  const site = siteOf(kind);
  const board = site?.board?.fromConfig(config) ?? null;
  return site === undefined || board === null ? null : atsBoardOf(site, board);
}

export function isAtsKind(kind: string | null): kind is AtsKind {
  return kind !== null && siteOf(kind) !== undefined;
}

/** The ATS board a link points at, if any. Each site reads its own links (#769). */
export function boardFromUrl(raw: string): AtsBoard | null {
  let url: URL;
  try {
    url = new URL(raw.replace(/&amp;/g, '&'), 'https://invalid.invalid/');
  } catch {
    return null;
  }
  for (const site of ATS_SITES) {
    const board = site.board!.fromUrl(url);
    if (board !== null) return atsBoardOf(site, board);
  }
  return null;
}
