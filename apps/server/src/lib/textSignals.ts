// Rules 3b and 5 of the mail funnel (spec D1): what the text of a message says about itself.
//
// The two lists are built to opposite tolerances, which is the whole design of this module:
//
//   rule 3b, private content, DROPS the message. A false positive costs a real job email, so its
//     terms are specific and several are phrases: "claim" alone is a word job mail uses, while
//     "claim number" is not.
//   rule 5, job vocabulary, PASSES the message to Stage 2. A false negative costs a real job
//     email; a false positive costs one cheap model call. So its terms are stems, and recruiter,
//     recruiting and recruitment are one term.
//
// Both scan at most MAX_SCANNED_CHARS of normalized text through one regex compiled at module
// load, so a 5 MB base64 attachment cannot make the sync quadratic, and neither can match
// inside a longer word.

/**
 * How much of a body is scanned. A long job description runs to a few thousand characters, so
 * this is an order of magnitude more than a real message needs; past it, a body is an
 * attachment, a quoted thread or machine noise.
 */
export const MAX_SCANNED_CHARS = 100_000;

/**
 * `word` matches the term and nothing longer; `stem` matches the term and anything built on it.
 * Both anchor the start of the term at a word boundary, so no term matches inside a word.
 */
export type TextMode = 'word' | 'stem';

export interface TextTerm {
  readonly name: string;
  readonly mode: TextMode;
}

/** Rule 3b. Specific by design: each of these is a sentence a job email does not write. */
export const PRIVATE_CONTENT_TERMS: readonly TextTerm[] = [
  { name: 'superbill', mode: 'stem' },
  { name: 'appointment reminder', mode: 'stem' },
  { name: 'copay', mode: 'stem' },
  { name: 'deductible', mode: 'stem' },
  { name: 'prescription', mode: 'stem' },
  { name: 'explanation of benefits', mode: 'stem' },
  { name: 'patient portal', mode: 'stem' },
  { name: 'claim number', mode: 'stem' },
  { name: 'policy number', mode: 'stem' },
  { name: 'routing number', mode: 'stem' },
  { name: 'account ending', mode: 'stem' },
  { name: 'card ending', mode: 'stem' },
  { name: 'statement is available', mode: 'stem' },
];

/** Rule 5. Generous by design: a missed term here hides a real job email. */
export const JOB_VOCABULARY_TERMS: readonly TextTerm[] = [
  { name: 'job description', mode: 'stem' },
  { name: 'job opening', mode: 'stem' },
  { name: 'cover letter', mode: 'stem' },
  { name: 'offer letter', mode: 'stem' },
  { name: 'hiring', mode: 'word' },
  { name: 'recruit', mode: 'stem' },
  { name: 'candidat', mode: 'stem' },
  { name: 'interview', mode: 'stem' },
  { name: 'compensation', mode: 'stem' },
  { name: 'resume', mode: 'stem' },
  { name: 'referral', mode: 'stem' },
  { name: 'applicant', mode: 'stem' },
  { name: 'application', mode: 'stem' },
  { name: 'sourcer', mode: 'stem' },
  { name: 'onboarding', mode: 'stem' },
  { name: 'salary', mode: 'stem' },
  // Cold-approach language. A recruiter's opening line often carries none of the words above:
  // it describes the arrangement and the reason they are writing, not the hiring process.
  { name: 'remote', mode: 'stem' },
  { name: 'your background', mode: 'stem' },
  // Word, not stem: as a stem this also matches "looking forward", which ordinary mail of
  // every kind is full of, and rule 5 is the rule that decides a message is worth a model.
  { name: 'looking for', mode: 'word' },
];

const escape = (term: string): string => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One regex for a whole list, built once: `\b(?:term|term)` with `\b` closing a word term. */
function compile(terms: readonly TextTerm[]): RegExp {
  const parts = terms.map((t) => escape(t.name) + (t.mode === 'word' ? '\\b' : ''));
  return new RegExp(`\\b(?:${parts.join('|')})`, 'i');
}

/**
 * The text as the scanners read it: lowercased, whitespace collapsed, and capped.
 *
 * Collapsing whitespace is what lets a phrase term survive the sender's line wrapping, which is
 * where "claim\n number" would otherwise read as neither "claim number" nor anything else.
 */
function scannable(text: string): string {
  return text.slice(0, MAX_SCANNED_CHARS).toLowerCase().replace(/\s+/g, ' ');
}

const PRIVATE_RE = compile(PRIVATE_CONTENT_TERMS);
const VOCABULARY_RE = compile(JOB_VOCABULARY_TERMS);

/** Which term a match belongs to: the first whose name the matched text starts with. */
function termOf(terms: readonly TextTerm[], matched: string): string | null {
  for (const t of terms) {
    if (matched.startsWith(t.name)) return t.name;
  }
  return null;
}

function signal(terms: readonly TextTerm[], re: RegExp, text: string): string | null {
  const found = re.exec(scannable(text));
  if (found === null) return null;
  // The match is at most as long as its own term plus the suffix a stem allowed, so naming it
  // by prefix is exact rather than a guess.
  return termOf(terms, found[0]);
}

/** Rule 3b: the private-content signal this text carries, or null. */
export function privateContentSignal(text: string): string | null {
  return signal(PRIVATE_CONTENT_TERMS, PRIVATE_RE, text);
}

/** Rule 5: the job-vocabulary signal this text carries, or null. */
export function jobVocabularySignal(text: string): string | null {
  return signal(JOB_VOCABULARY_TERMS, VOCABULARY_RE, text);
}
