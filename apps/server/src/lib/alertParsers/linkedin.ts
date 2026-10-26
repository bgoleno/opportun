// LinkedIn job alert digests (FR-D1 alert source). Parses the plain-text body Gmail stored: each
// job is a run of lines (title, company, location, maybe badges) ending in a "View job: <url>"
// line. Only links on the alert sender's own domain under /comm/jobs/view/ count; anything else
// is not a job of this digest and is dropped. The job link is kept only as the lead's posting
// URL, as metadata: nothing here or later fetches it (C-1; safeFetch refuses the host
// regardless). Values are raw; the discovery engine sanitizes them like any other posting.
//
// Hostile input: the body is capped before parsing and each job's block is at most a few
// lines, so parsing is linear in the (capped) body size.
import type { NormalizedPosting } from '@opportun/core';

/** The LinkedIn job alert sender (a mail address; the board domain is derived from it). */
export const LINKEDIN_ALERT_SENDER = 'jobalerts-noreply@linkedin.com';
const BOARD_DOMAIN = LINKEDIN_ALERT_SENDER.slice(LINKEDIN_ALERT_SENDER.indexOf('@') + 1);

/** Most leads taken from one digest. */
export const MAX_ALERT_LEADS = 100;
/** Characters of a digest body that are parsed at all. */
export const MAX_DIGEST_CHARS = 300_000;
/** Lines above a job link that can belong to that job (title, company, location, badges). */
export const MAX_BLOCK_LINES = 8;

/** A host on the board's domain (the domain itself or a subdomain). */
export function onDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  return h === domain || h.endsWith(`.${domain}`);
}

const VIEW_JOB = /^View job:\s*(https:\/\/\S{1,2000})$/i;
const JOB_PATH = /^\/comm\/jobs\/view\/(\d{1,20})(?:\/|$)/;
const SEPARATOR = /^-{5,}$/;
/**
 * The digest's own header line ("Your job alert for <query> in <place>"). It sits directly
 * above the first job with no blank line, so without this it is swept into that job's block
 * and shifts every field by one: the header becomes the title, the title becomes the company
 * and the company becomes the location (observed live, 15 rows, 2026-10-19). Anchored at the
 * start so a posting legitimately titled "Manager, Your Job Alert Platform" still parses.
 */
export const ALERT_HEADER = /^Your job alert for\b/i;
/** Badge lines between the location and the link, not part of the job's identity. */
const BADGES: readonly RegExp[] = [
  /^actively recruiting$/i,
  /^actively hiring$/i,
  /^easy apply$/i,
  /^promoted$/i,
  /^new$/i,
  /^be an early applicant$/i,
  /^apply with resume/i,
  /^\d+ (?:company )?alum(?:ni|nus|na)\b/i,
  /^\d+\s+connections?\b/i,
  /^\d+\s+applicants?\b/i,
  /^(?:posted|reposted)\b/i,
];

function jobLink(line: string): { url: string; id: string } | null {
  const m = VIEW_JOB.exec(line);
  if (m === null) return null;
  let url: URL;
  try {
    url = new URL(m[1] as string);
  } catch {
    return null;
  }
  if (!onDomain(url.hostname, BOARD_DOMAIN)) return null;
  const id = JOB_PATH.exec(url.pathname)?.[1];
  if (id === undefined) return null;
  // The canonical job page on the board's own origin, without tracking parameters.
  return { url: `https://www.${BOARD_DOMAIN}/jobs/view/${id}/`, id };
}

export function parseLinkedInAlert(text: string): NormalizedPosting[] {
  const lines = text
    .slice(0, MAX_DIGEST_CHARS)
    .split(/\r?\n/)
    .map((l) => l.trim());
  const out: NormalizedPosting[] = [];
  lines.forEach((line, i) => {
    if (out.length >= MAX_ALERT_LEADS) return;
    const link = jobLink(line);
    if (link === null) return;
    const block: string[] = [];
    for (let j = i - 1; j >= 0 && block.length < MAX_BLOCK_LINES; j--) {
      const prev = lines.at(j) ?? '';
      if (prev === '' || SEPARATOR.test(prev) || ALERT_HEADER.test(prev)) break;
      block.push(prev);
    }
    block.reverse();
    const content = block.filter(
      (l) => !BADGES.some((re) => re.test(l)) && !/^https?:\/\//i.test(l),
    );
    const [title, company, location] = content;
    if (title === undefined || company === undefined) return;
    // A header that still reaches a job's identity means the digest format moved under us:
    // drop the lead so the change surfaces as missing leads, never as silently wrong ones.
    if (ALERT_HEADER.test(title) || ALERT_HEADER.test(company)) return;
    out.push({
      company,
      title,
      location: location ?? null,
      remote: location !== undefined && /\bremote\b/i.test(location) ? true : null,
      descriptionMd: null,
      postingUrl: link.url,
      externalId: link.id,
    });
  });
  return out;
}
