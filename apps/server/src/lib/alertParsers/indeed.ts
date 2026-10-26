// Indeed job alert digests (FR-D1 alert source). Parses the plain-text body: jobs are blank-line
// separated blocks of title, "Company - Location", an optional pay line, a snippet, and the
// job's tracking link (which carries the job key `jk`). Only links on the alert sender's own
// domain count; others are dropped. The link is kept as metadata only. Values are raw; the
// discovery engine sanitizes them. The body is capped before parsing.
import type { NormalizedPosting } from '@opportun/core';
import { MAX_ALERT_LEADS, MAX_DIGEST_CHARS, onDomain } from './linkedin';

/** The Indeed job alert sender (a mail address; the board domain is derived from it). */
export const INDEED_ALERT_SENDER = 'alert@indeed.com';
const BOARD_DOMAIN = INDEED_ALERT_SENDER.slice(INDEED_ALERT_SENDER.indexOf('@') + 1);

/** "$140,000 - $170,000 a year", "$65 an hour". */
function isPayLine(line: string): boolean {
  return (
    line.length <= 200 &&
    /^\$\d/.test(line) &&
    / (?:a|an|per) (?:year|hour|month|week|day)\b/i.test(line)
  );
}
const JOB_KEY = /^[0-9a-f]{8,32}$/i;

function jobLink(line: string): { url: string; key: string } | null {
  if (!/^https:\/\/\S{1,4000}$/i.test(line)) return null;
  let url: URL;
  try {
    url = new URL(line);
  } catch {
    return null;
  }
  if (!onDomain(url.hostname, BOARD_DOMAIN)) return null;
  const key = url.searchParams.get('jk');
  if (key === null || !JOB_KEY.test(key)) return null;
  const jk = key.toLowerCase();
  return { url: `https://www.${BOARD_DOMAIN}/viewjob?jk=${jk}`, key: jk };
}

/** "Company - City, ST" -> company and location (split at the last " - "). */
function companyAndLocation(line: string): { company: string; location: string | null } {
  const at = line.lastIndexOf(' - ');
  if (at <= 0) return { company: line, location: null };
  return { company: line.slice(0, at).trim(), location: line.slice(at + 3).trim() || null };
}

export function parseIndeedAlert(text: string): NormalizedPosting[] {
  const blocks = text
    .slice(0, MAX_DIGEST_CHARS)
    .split(/\r?\n\s*\r?\n/)
    .map((b) =>
      b
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
    );
  const out: NormalizedPosting[] = [];
  for (const lines of blocks) {
    if (out.length >= MAX_ALERT_LEADS) break;
    const link = lines.map(jobLink).find((l) => l !== null);
    const [title, second] = lines;
    if (link == null || title === undefined || second === undefined || jobLink(second) !== null) {
      continue;
    }
    const { company, location } = companyAndLocation(second);
    out.push({
      company,
      title,
      location,
      remote: location !== null && /\bremote\b/i.test(location) ? true : null,
      compNote: lines.slice(2).find(isPayLine) ?? null,
      descriptionMd: null,
      postingUrl: link.url,
      externalId: link.key,
    });
  }
  return out;
}
