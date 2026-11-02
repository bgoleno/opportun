// Does one inbound email confirm exactly one submitted application? (Assisted apply M2b-1,
// https://github.com/bgoleno/opportun/issues/126; the design's Part A 5.3 step 2.)
//
// A pure function: no IO and no clock. The caller (the ingest wiring, a later part of #119)
// passes the message as ingest sees it, the user's submitted candidates, and the ATS sender
// domains per ATS kind (the real list comes from M0 item 4; none ships here).
//
// Four signals, per candidate:
//   A  the message's ATS job refs (extracted at ingest) name the candidate's ATS kind and its
//      external id, or its board org;
//   B  the sender's address (never its display name) is at the company's domain, or at an ATS
//      sender domain for the candidate's ATS kind, or a subdomain of either;
//   C  the subject or text carries the role title and the company name, as whole words,
//      normalised the way @opportun/core's dedupe normalises them;
//   D  the message was sent no earlier than 5 minutes before the submission (clock skew) and no
//      later than 14 days after it.
// A candidate matches on D and (A, or B and C). One match: that candidate, with every signal
// that held. Two or more: none, ambiguous, naming them; a person decides. Nothing here changes
// any state: this only answers the question.
import { companyMatchKey, matchText, titleMatchKey } from '@opportun/core';

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

export type ConfirmationSignal =
  'ats_job_ref' | 'sender_domain' | 'role_and_company' | 'time_window';

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
 * The sender's domain from a From header: the address in the last `<...>`, or the whole value
 * when there are no brackets. A display name is never read, so `"careers@example" <x@evil>` is
 * evil's mail. Null when there is no single plain address.
 */
export function senderDomain(from: string): string | null {
  const open = from.lastIndexOf('<');
  const close = from.lastIndexOf('>');
  const address = open !== -1 && close > open ? from.slice(open + 1, close) : from;
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

function signalsFor(
  message: ConfirmationMessage,
  candidate: ConfirmationCandidate,
  sender: string | null,
  text: string,
  senders: AtsSenderDomains,
): ConfirmationSignal[] {
  const signals: ConfirmationSignal[] = [];
  const atsRef = candidate.atsRef === null ? null : lower(candidate.atsRef);
  if (
    message.atsJobRefs.some(
      (r) =>
        r.kind === candidate.atsKind &&
        (lower(r.externalId) === lower(candidate.atsExternalId) ||
          (r.org !== null && atsRef !== null && lower(r.org) === atsRef)),
    )
  ) {
    signals.push('ats_job_ref');
  }
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
  return signals;
}

const matches = (signals: readonly ConfirmationSignal[]): boolean =>
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
    .map((c) => ({ id: c.id, signals: signalsFor(message, c, sender, text, atsSenderDomains) }))
    .filter((c) => matches(c.signals));
  if (found.length === 0) return { kind: 'none', reason: 'no_match', candidateIds: [] };
  if (found.length > 1) {
    return { kind: 'none', reason: 'ambiguous', candidateIds: found.map((c) => c.id).sort() };
  }
  const [only] = found as [{ id: string; signals: ConfirmationSignal[] }];
  return { kind: 'match', submissionId: only.id, signals: only.signals };
}
