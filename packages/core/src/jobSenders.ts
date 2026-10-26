// Known job senders, the mail filter's rule 4 pass list (spec D1).
//
// Decision D-3: this is a built-in list in code, like CONSUMER_EMAIL_DOMAINS, rather than rows
// seeded by a migration. A migration seed would miss any user created after it ran, would need
// a new migration pair in both dialects every time the list changed, and would arrive in the
// settings page indistinguishable from rules the user wrote themselves, so deleting one would
// be permanent and invisible. In code, the list ships with the release, a user who disagrees
// switches an entry off (a disabled `job_sender` row naming the same pattern), and their own
// additions are ordinary rules.
//
// **The scope of each entry is load-bearing**, because a domain is a materially wider net than
// an address. LinkedIn is address-level precisely so that `security-noreply@linkedin.com` and
// the marketing sender stay out of the job search; a platform whose every address is hiring
// workflow is domain-level.
//
// These are industry platforms, the way CONSUMER_EMAIL_DOMAINS lists mail providers: a shipped
// default the user edits, not a record of anyone's correspondence.
import { matchesMailPattern, parseMailPattern } from './mailPattern';

export interface JobSenderSeed {
  /** Same syntax as the user's allow and deny lists. */
  readonly pattern: string;
  readonly platform: string;
  /** What it sends, shown in settings so the entry can be judged rather than trusted. */
  readonly sends: string;
}

export const JOB_SENDER_SEEDS: readonly JobSenderSeed[] = [
  // LinkedIn, address by address. These six carry recruiter contact; the rest of LinkedIn does
  // not, and a domain-level entry here would pass security alerts and product marketing.
  {
    pattern: 'inmail-hit-reply@linkedin.com',
    platform: 'LinkedIn',
    sends: 'recruiter InMail notifications, with the message text included',
  },
  {
    pattern: 'hit-reply@linkedin.com',
    platform: 'LinkedIn',
    sends: 'replies on a conversation already in progress',
  },
  {
    // Seeded although it carries no recruiter text: "a message is waiting" is the signal that
    // matters when the message itself is only readable on LinkedIn.
    pattern: 'messaging-digest-noreply@linkedin.com',
    platform: 'LinkedIn',
    sends: 'unread message nudges',
  },
  {
    pattern: 'messages-noreply@linkedin.com',
    platform: 'LinkedIn',
    sends: 'message notifications',
  },
  {
    pattern: 'career-interests-noreply@linkedin.com',
    platform: 'LinkedIn',
    sends: 'career interests product mail',
  },
  { pattern: 'jobs-noreply@linkedin.com', platform: 'LinkedIn', sends: 'jobs product mail' },

  // Platforms that exist only to run hiring workflow.
  {
    pattern: '*@interviews.modernloop.io',
    platform: 'ModernLoop',
    sends: 'interview scheduling and availability requests',
  },
  { pattern: '*@candidate.fyi', platform: 'candidate.fyi', sends: 'interview reminders' },

  // The ATS transactional mail domain, and its regional sending subdomains such as
  // us.greenhouse-mail.io. NOT greenhouse.io, which is the vendor's own site: that domain
  // sells recruiting software to companies, and its mail is marketing. The same distinction
  // applies to any ATS added later: seed the domain its notifications come from.
  {
    pattern: '*@greenhouse-mail.io',
    platform: 'Greenhouse',
    sends: 'ATS mail sent on an employer behalf',
  },
  {
    pattern: '*@*.greenhouse-mail.io',
    platform: 'Greenhouse',
    sends: 'ATS mail from a regional sending domain',
  },

  // Only the subdomain the digests come from. Bare wellfound.com is product mail.
  //
  // A digest sender on the wrong list, deliberately: it sends many real postings per message
  // and belongs in alert_senders, but only behind a Wellfound parser in parseAlertDigest. Until
  // that parser exists it sits here, where it is at least read.
  {
    pattern: '*@hi.wellfound.com',
    platform: 'Wellfound',
    sends: 'job digests and saved-job nudges',
  },
];

/** True when a string is a pattern this list can hold (the shared allow/deny syntax). */
export function isJobSenderPattern(pattern: string): boolean {
  return parseMailPattern(pattern) !== null;
}

/**
 * True when an address matches a built-in job sender the user has not switched off.
 *
 * `disabled` holds the patterns of built-ins the user turned off, which is how a code-shipped
 * list stays editable: switching one off is a disabled rule naming the same pattern, so the
 * next release can change the list without clobbering that choice.
 */
export function matchesJobSenderSeed(
  address: string,
  disabled: ReadonlySet<string> = new Set(),
): boolean {
  const text = address.trim().toLowerCase();
  if (text === '' || parseMailPattern(text) === null) return false;
  for (const seed of JOB_SENDER_SEEDS) {
    if (disabled.has(seed.pattern)) continue;
    const parsed = parseMailPattern(seed.pattern);
    if (parsed !== null && matchesMailPattern(text, parsed)) return true;
  }
  return false;
}
