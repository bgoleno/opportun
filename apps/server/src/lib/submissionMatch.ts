// Does one inbound email confirm exactly one submitted application? (Assisted apply M2b-1,
// https://github.com/bgoleno/opportun/issues/126; the design's Part A 5.3 step 2.)
//
// A pure function: no IO and no clock. The caller (the ingest wiring, a later part of #119)
// passes the message as ingest sees it, the user's submitted candidates, and the ATS sender
// domains per ATS kind (the real list comes from M0 item 4; none ships here).
//
// Four signals, per candidate:
//   A  the message's ATS job refs (extracted at ingest) name the candidate's ATS kind and its
//      external id, with the same board org when both carry one (a Workday requisition id is
//      only unique within its tenant);
//   B  the sender's address (never its display name) is at the company's domain, or at an ATS
//      sender domain for the candidate's ATS kind, or a subdomain of either;
//   C  the subject or text carries the role title and the company name, as whole words,
//      normalised the way @opportun/core's dedupe normalises them;
//   D  the message was sent no earlier than 5 minutes before the submission (clock skew) and no
//      later than 14 days after it.
// A candidate matches on D and (A, or B and C), unless the message links only OTHER jobs at the
// candidate's board: every extracted ref carries a job id, so such a link says the message is
// about another job there (a rejection for job 1, "you may also like" job 3), and it never
// confirms this one, whatever else holds (tl on https://github.com/bgoleno/opportun/pull/173).
// One match: that candidate, with every signal
// that held. Two or more: none, ambiguous, naming them; a person decides. Nothing here changes
// any state: this only answers the question.
import {
  companyMatchKey,
  matchText,
  titleMatchKey,
  type SubmissionConfirmationSignal,
} from '@opportun/core';

export interface ConfirmationMessage {
  /** The From header as received: a display name may precede the address. */
  fromAddress: string;
  subject: string | null;
  /** The body, read transiently by the caller; never stored by this function. */
  text: string;
  sentAt: number;
  /** ATS job references extracted from the body at ingest (lib/atsJobRef). */
  atsJobRefs: readonly { kind: string; org: string | null; externalId: string }[];
}

export interface ConfirmationCandidate {
  /** The submission's id. */
  id: string;
  atsKind: string;
  atsRef: string | null;
  atsExternalId: string;
  companyName: string;
  /** The company's known domain, when one has been resolved. */
  companyDomain: string | null;
  roleTitle: string;
  submittedAt: number;
}

/** Sender domains each ATS sends from, by ATS kind (the caller's list). */
export type AtsSenderDomains = Readonly<Partial<Record<string, readonly string[]>>>;

/**
 * The ATS sender domains the ingest wiring uses (#119): evidence policy, so a reviewed constant,
 * never configuration. Empty until the owner supplies the observed list (M0 item 4 of
 * https://github.com/bgoleno/opportun/issues/79); that change lands as its own PR, reviewed by
 * sec. Empty, signal B holds only for a sender under the company's own domain, and a
 * confirmation sent from an ATS's mail domain is matched only by an ATS ref with the job id (A),
 * or not at all: a missed confirmation, never a false one (tl on #119).
 */
export const ATS_SENDER_DOMAINS: AtsSenderDomains = {};

/** One list with the API's (@opportun/core SUBMISSION_CONFIRMATION_SIGNALS), so they cannot drift. */
export type ConfirmationSignal = SubmissionConfirmationSignal;

export type ConfirmationMatch =
  | { kind: 'match'; submissionId: string; signals: ConfirmationSignal[] }
  | { kind: 'none'; reason: 'no_candidates' | 'no_match' | 'ambiguous'; candidateIds: string[] };

/** How long before the recorded submission a confirmation may be sent (clocks disagree). */
export const CONFIRMATION_SKEW_MS = 5 * 60 * 1000;
/** How long after the submission a confirmation is still looked for. */
export const CONFIRMATION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const lower = (s: string): string => s.trim().toLowerCase();
const bareDomain = (d: string): string => lower(d).replace(/\.+$/, '');

/**
 * The sender's domain from a From header: the address in the last `<...>` when the header ends
 * with it, or else the whole value. A display name is never read, so `"careers@example" <x@evil>`
 * is evil's mail, and `Careers <careers@example> x@evil` is no address at all (qa on #128): a
 * bracket that does not end the header is not the address. Null when there is no single plain
 * address.
 */
export function senderDomain(from: string): string | null {
  const header = from.trim();
  const open = header.lastIndexOf('<');
  const address = header.endsWith('>') && open !== -1 ? header.slice(open + 1, -1) : header;
  const trimmed = address.trim();
  if (trimmed === '' || /\s/.test(trimmed)) return null;
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return null;
  const domain = bareDomain(trimmed.slice(at + 1));
  return domain === '' ? null : domain;
}

/** `domain` is `entry` or a subdomain of it (never a look-alike that only ends the same way). */
function underDomain(domain: string, entry: string): boolean {
  const e = bareDomain(entry);
  return e !== '' && (domain === e || domain.endsWith(`.${e}`));
}

/** `needle` occurs in `haystack` as whole words (both already normalised by matchText). */
function hasWords(haystack: string, needle: string): boolean {
  // A key with no Latin letters is a hash (see titleMatchKey): free text never contains it.
  if (needle === '' || needle.startsWith('#')) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

interface Assessment {
  signals: ConfirmationSignal[];
  /** The message links another job at this candidate's board, and not this one. */
  otherJob: boolean;
}

function assess(
  message: ConfirmationMessage,
  candidate: ConfirmationCandidate,
  sender: string | null,
  text: string,
  senders: AtsSenderDomains,
): Assessment {
  const signals: ConfirmationSignal[] = [];
  const board = candidate.atsRef === null ? null : lower(candidate.atsRef);
  const id = lower(candidate.atsExternalId);
  const sameKind = message.atsJobRefs.filter((r) => r.kind === candidate.atsKind);
  const orgAgrees = (org: string | null) => org === null || board === null || lower(org) === board;
  const thisJob = sameKind.some((r) => lower(r.externalId) === id && orgAgrees(r.org));
  if (thisJob) signals.push('ats_job_ref');
  const otherJob =
    !thisJob &&
    sameKind.some(
      (r) =>
        r.org !== null && board !== null && lower(r.org) === board && lower(r.externalId) !== id,
    );
  if (sender !== null) {
    const domains = [
      ...(candidate.companyDomain === null ? [] : [candidate.companyDomain]),
      ...(senders[candidate.atsKind] ?? []),
    ];
    if (domains.some((d) => underDomain(sender, d))) signals.push('sender_domain');
  }
  if (
    hasWords(text, titleMatchKey(candidate.roleTitle)) &&
    hasWords(text, companyMatchKey(candidate.companyName))
  ) {
    signals.push('role_and_company');
  }
  if (
    message.sentAt >= candidate.submittedAt - CONFIRMATION_SKEW_MS &&
    message.sentAt <= candidate.submittedAt + CONFIRMATION_WINDOW_MS
  ) {
    signals.push('time_window');
  }
  return { signals, otherJob };
}

const matches = ({ signals, otherJob }: Assessment): boolean =>
  !otherJob &&
  signals.includes('time_window') &&
  (signals.includes('ats_job_ref') ||
    (signals.includes('sender_domain') && signals.includes('role_and_company')));

export function matchConfirmation(
  message: ConfirmationMessage,
  candidates: readonly ConfirmationCandidate[],
  atsSenderDomains: AtsSenderDomains,
): ConfirmationMatch {
  if (candidates.length === 0) return { kind: 'none', reason: 'no_candidates', candidateIds: [] };
  const sender = senderDomain(message.fromAddress);
  const text = matchText(`${message.subject ?? ''}\n${message.text}`);
  const found = candidates
    .map((c) => ({ id: c.id, ...assess(message, c, sender, text, atsSenderDomains) }))
    .filter(matches);
  if (found.length === 0) return { kind: 'none', reason: 'no_match', candidateIds: [] };
  if (found.length > 1) {
    return { kind: 'none', reason: 'ambiguous', candidateIds: found.map((c) => c.id).sort() };
  }
  const only = found[0]!;
  return { kind: 'match', submissionId: only.id, signals: only.signals };
}
