import { z } from 'zod';

/**
 * One job posting as every discovery source reports it (FR-D1). Adapters return raw values;
 * the server's sanitizePosting strips markup and enforces these caps before anything is stored
 * or handed to a later consumer.
 */
export const NormalizedPostingSchema = z.object({
  company: z.string().min(1).max(300),
  title: z.string().min(1).max(300),
  descriptionMd: z.string().max(50_000).nullish(),
  postingUrl: z.string().url().max(2000).nullish(),
  location: z.string().max(300).nullish(),
  remote: z.boolean().nullish(),
  compNote: z.string().max(500).nullish(),
  /** Source-native id when the source has one. */
  externalId: z.string().max(500).nullish(),
  postedAt: z.number().int().nullish(),
});
export type NormalizedPosting = z.infer<typeof NormalizedPostingSchema>;

/**
 * Where discovery results come from. Named apart from the opportunity SOURCE_KINDS (manual,
 * import, discovery, communication), which say how an opportunity entered the pipeline.
 */
export const DISCOVERY_SOURCE_KINDS = [
  'ats_greenhouse',
  'ats_lever',
  'ats_ashby',
  'mcp',
  'alert_email',
  'manual',
  /** LinkedIn job pages the user captures with the browser extension (FR-C5). */
  'extension',
  /** A Workday tenant's career site, addressed by host plus site (FR-D10). */
  'ats_workday',
] as const;
export type DiscoverySourceKind = (typeof DISCOVERY_SOURCE_KINDS)[number];

/**
 * full: the source gave the whole posting. resolved_ats: a partial lead matched on an ATS.
 * needs_capture: no description yet, and nothing has given up trying. capture_failed (issue
 * #101): an automated retry window closed with the posting still bare, so the degradation is
 * recorded rather than left to look identical to a row nobody has tried yet — the user can still
 * capture it by hand, which is the one thing automation can no longer do for it.
 */
export const RESOLUTIONS = ['full', 'resolved_ats', 'needs_capture', 'capture_failed'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export const DISPOSITIONS = ['pending', 'accepted', 'dismissed'] as const;
export type Disposition = (typeof DISPOSITIONS)[number];
