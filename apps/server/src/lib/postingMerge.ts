// Assembling the merged description (design D4, D5, D6, D27). Pure, unit-tested.
//
// The company's own ATS copy wins every conflict (D4), and the capture's extra content is kept
// rather than discarded (D5). Doing both without a model rewriting the employer's words means
// the stored document is the ATS text verbatim, followed by the passages the capture carries
// that the ATS does not: the `posting.merge` task selects those passages, and this module
// decides which of them survive.
//
// Nothing here trusts the model. A passage is kept only when the captured page actually
// contains it (isGroundedIn, the same check connectorCapture applies to profile fields), so a
// paraphrase or an invention is dropped. Redundancy is the acceptable failure mode: a passage
// kept that the ATS already covered is noise. An invented requirement is not acceptable,
// because the stored description is what resume tailoring and the match score read.
import { isGroundedIn, MAX_DESCRIPTION } from './linkedinCapture';

export interface MergeInput {
  /** The employer's own posting, stored verbatim and never rewritten. */
  atsText: string;
  /** The page the user captured, as the extension read it. */
  captureText: string;
  /** What the model selected out of `captureText`. */
  passages: readonly string[];
  /** The site the capture came from, e.g. 'LinkedIn'. */
  siteLabel: string;
  /** The hiring company, named in the note so the precedence is legible. */
  company: string;
  maxChars?: number;
}

/** Whitespace-insensitive, case-insensitive comparison, matching isGroundedIn's normalization. */
const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

export function mergePostingText(input: MergeInput): string {
  const ats = input.atsText.trim();
  const maxChars = input.maxChars ?? MAX_DESCRIPTION;
  const capture = input.captureText;

  const kept: string[] = [];
  const seen = new Set<string>();
  const atsNormalized = normalize(ats);
  for (const raw of input.passages) {
    const passage = raw.trim();
    const key = normalize(passage);
    if (key === '' || seen.has(key)) continue;
    // The model may only hand back what the page actually said.
    if (!isGroundedIn(passage, capture)) continue;
    // Already the employer's own words: the ATS copy wins, so this adds nothing.
    if (atsNormalized.includes(key)) continue;
    seen.add(key);
    kept.push(passage);
  }

  if (kept.length === 0) return ats;

  const extras = [
    '',
    '---',
    '',
    `## Also on the ${input.siteLabel} posting`,
    '',
    `*Not covered by ${input.company}'s own posting.*`,
    '',
    ...kept.map((p) => `- ${p.replace(/\n+/g, ' ')}`),
  ].join('\n');

  // The ATS text is never the part that is cut: an employer's words outrank an aggregator's
  // extras, so truncation eats the extras and, if they do not fit at all, drops them whole.
  if (ats.length >= maxChars) return ats;
  return (ats + extras).length <= maxChars ? ats + extras : ats;
}
