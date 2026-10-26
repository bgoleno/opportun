// Rule 3a of the mail funnel (spec D1): does this SENDER deal in private content.
//
// A shipped default taxonomy, which is not the same thing as anyone's address book: these are
// the words a healthcare, pharmacy, insurance or banking sender puts in its own domain name. It
// is a starting point the user edits, and no list in this repository is derived from a real
// mailbox.
//
// Why the two matching modes exist:
//
//   - a private sender's domain is usually a compound word (`<x>medical`, `<x>bank`,
//     `patient<x>`), and a label named exactly `medical` is rare, so whole-label matching, which
//     is the safe-looking choice, would catch almost nothing;
//   - two terms are common English fragments (`vision` inside television, `dds` inside adds), so
//     they stay label-only rather than being dropped: an optometrist and a dentist announce
//     themselves with exactly those words.
//
// Rule 3a is NOT what keeps an appointment reminder out: rule 7 drops any message with no job
// signal. 3a exists only to beat rules 4, 5 and 6, which means a false positive here costs a
// real job email while a false negative usually costs nothing. Everything below is shaped by
// that asymmetry: a narrow list, named exclusions instead of hoping, and a hiring mailbox that
// cancels the veto outright.

export type TermMode = 'substring' | 'label';

export interface PrivateTerm {
  /** The signal name a filtered row reports, so the Blocked view can say which rule decided. */
  readonly name: string;
  readonly mode: TermMode;
  /**
   * Words that contain this term but mean something else. Checked before the term, so
   * `healthyfoods` is not a health provider while `healthpartners` still is.
   */
  readonly except?: readonly string[];
}

/**
 * Ordered: the first match names the signal, so the more specific terms come first. Health and
 * financial terms are deliberately separate names, because "dropped as medical" and "dropped as
 * financial" are different things to read in the Blocked view.
 *
 * A deployment with different correspondence replaces this wholesale, which is why it is one
 * exported constant rather than logic.
 */
export const PRIVATE_SENDER_TERMS: readonly PrivateTerm[] = [
  { name: 'chiropractic', mode: 'substring' },
  { name: 'orthodon', mode: 'substring' },
  { name: 'optometr', mode: 'substring' },
  { name: 'podiatr', mode: 'substring' },
  { name: 'dermatolog', mode: 'substring' },
  { name: 'radiolog', mode: 'substring' },
  { name: 'cardiolog', mode: 'substring' },
  { name: 'physicaltherap', mode: 'substring' },
  { name: 'physiotherap', mode: 'substring' },
  { name: 'urgentcare', mode: 'substring' },
  { name: 'dental', mode: 'substring' },
  { name: 'dentist', mode: 'substring' },
  { name: 'pharmacy', mode: 'substring' },
  { name: 'hospital', mode: 'substring' },
  { name: 'clinic', mode: 'substring' },
  { name: 'medical', mode: 'substring' },
  { name: 'patient', mode: 'substring' },
  { name: 'wellness', mode: 'substring' },
  { name: 'creditunion', mode: 'substring' },
  { name: 'insurance', mode: 'substring' },
  { name: 'billing', mode: 'substring' },
  { name: 'claims', mode: 'substring' },
  { name: 'benefits', mode: 'substring' },
  { name: 'health', mode: 'substring', except: ['healthy', 'healthier'] },
  { name: 'bank', mode: 'substring', except: ['banksy'] },
  // Label-only: as substrings these are inside television, division, adds, address.
  { name: 'vision', mode: 'label' },
  { name: 'dds', mode: 'label' },
];

/**
 * Mailboxes that mean "this is about hiring", which cancel rule 3a entirely.
 *
 * This is the veto's most expensive mistake, bought off cheaply: a hospital, bank or insurer
 * recruiting from its own domain has a domain that says private content and a mailbox that says
 * hiring, and the mailbox is the better evidence about the message. A `noreply@` on the same
 * domain gets no such rescue.
 */
export const HIRING_MAILBOXES: ReadonlySet<string> = new Set([
  'career',
  'careers',
  'hiring',
  'hr',
  'jobs',
  'people',
  'recruiter',
  'recruiters',
  'recruiting',
  'recruitment',
  'talent',
  'ta',
]);

const tokens = (text: string): string[] => text.split(/[^a-z0-9]+/).filter((t) => t !== '');

/**
 * The private-content signal this sender carries, or null.
 *
 * Both halves of the address are read: the domain says who they are, and the local part is where
 * a billing or patient-portal mailbox says what it sends.
 */
export function privateSenderSignal(address: string): string | null {
  const text = address.trim().toLowerCase();
  const at = text.lastIndexOf('@');
  if (at <= 0 || at === text.length - 1) return null;
  const local = text.slice(0, at);
  const domain = text.slice(at + 1);

  // A hiring mailbox outranks whatever the domain looks like.
  if (tokens(local).some((t) => HIRING_MAILBOXES.has(t))) return null;

  const labels = new Set([...tokens(local), ...tokens(domain)]);
  for (const term of PRIVATE_SENDER_TERMS) {
    if (term.mode === 'label') {
      if (labels.has(term.name)) return term.name;
      continue;
    }
    const excluded = (term.except ?? []).some((word) => text.includes(word));
    if (!excluded && text.includes(term.name)) return term.name;
  }
  return null;
}
