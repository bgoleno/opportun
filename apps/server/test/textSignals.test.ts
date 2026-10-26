// Rules 3b and 5 of the mail funnel (spec D1): what the TEXT of a message says about itself.
//
// The two lists pull in opposite directions, and the tests below are shaped by that:
//
//   rule 3b (private content) DROPS, so a false positive costs a real job email. Its terms are
//     specific, and several are phrases, because "claim" alone is a word job mail uses too.
//   rule 5 (job vocabulary) PASSES, so a false negative costs a real job email while a false
//     positive only sends the message on to Stage 2, which is what Stage 2 is for. Its terms are
//     stems, so recruiter, recruiting and recruitment are all one term.
//
// Neither may match inside a longer word, and neither may be the reason a 5 MB attachment takes
// the sync down.
import { describe, expect, it } from 'vitest';
import {
  jobVocabularySignal,
  MAX_SCANNED_CHARS,
  privateContentSignal,
} from '../src/lib/textSignals';

describe('privateContentSignal', () => {
  it('names the medical signal it found', () => {
    expect(privateContentSignal('Your superbill is attached.')).toBe('superbill');
    expect(privateContentSignal('A copay of $40 is due.')).toBe('copay');
    expect(privateContentSignal('Appointment Reminder: Tuesday at 9.')).toBe(
      'appointment reminder',
    );
    expect(privateContentSignal('Refill your prescriptions online.')).toBe('prescription');
  });

  it('names the financial signal it found', () => {
    expect(privateContentSignal('Claim number 11-22-33 was processed.')).toBe('claim number');
    expect(privateContentSignal('From the account ending 4321.')).toBe('account ending');
    expect(privateContentSignal('Policy number QX-9 renews in May.')).toBe('policy number');
  });

  it('reads a phrase that a line break split in two', () => {
    // Mail bodies wrap wherever the sender's client decided to wrap.
    expect(privateContentSignal('your claim\n  number is enclosed')).toBe('claim number');
  });

  it('leaves job mail alone, including the words it shares with a clinic', () => {
    expect(privateContentSignal('Can we schedule an interview on Tuesday?')).toBeNull();
    expect(privateContentSignal('I am following up on my application.')).toBeNull();
    // "claim" on its own is a word job mail uses: this is why the term is the phrase.
    expect(privateContentSignal('They claim to be the fastest growing team.')).toBeNull();
  });

  it('does not match inside a longer word', () => {
    expect(privateContentSignal('precopay adjustments')).toBeNull();
    expect(privateContentSignal('nondeductible expenses')).toBeNull();
  });
});

describe('jobVocabularySignal', () => {
  it('matches the whole family of a stem', () => {
    expect(jobVocabularySignal('the recruiter will call')).toBe('recruit');
    expect(jobVocabularySignal('we are recruiting for this')).toBe('recruit');
    expect(jobVocabularySignal('our recruitment team')).toBe('recruit');
    expect(jobVocabularySignal('interviewing next week')).toBe('interview');
  });

  it('matches the plain job words', () => {
    expect(jobVocabularySignal('please send your resume')).toBe('resume');
    expect(jobVocabularySignal('we are hiring')).toBe('hiring');
    expect(jobVocabularySignal('the job description is attached')).toBe('job description');
    expect(jobVocabularySignal('compensation is competitive')).toBe('compensation');
  });

  it('matches the recruiter phrases the backtest said were missing', () => {
    // Added from measured misses: four job-labelled messages carried no term in the first list.
    expect(jobVocabularySignal('this is a fully remote role')).toBe('remote');
    expect(jobVocabularySignal('I came across your background')).toBe('your background');
    expect(jobVocabularySignal('we are looking for someone to lead')).toBe('looking for');
  });

  it('does not read "looking forward" as someone looking for a candidate', () => {
    // The sign-off of half the mail ever written, including an appointment confirmation. Rule 5
    // is what sends a message to a model, so a term this common would undo rule 7.
    expect(jobVocabularySignal('Looking forward to seeing you Tuesday.')).toBeNull();
    expect(jobVocabularySignal('looking forwards to it')).toBeNull();
  });

  it('does not match a term inside a longer word', () => {
    // Review Focus 5: the whole point of anchoring the start of the stem.
    expect(jobVocabularySignal('the meeting is at 1pm')).toBeNull();
    expect(jobVocabularySignal('fresh coffee in the kitchen')).toBeNull();
    expect(jobVocabularySignal('unhiring is not a word')).toBeNull();
  });

  it('is null for text with nothing job-related in it', () => {
    expect(jobVocabularySignal('Your package was delivered.')).toBeNull();
    expect(jobVocabularySignal('')).toBeNull();
  });
});

describe('scanning is bounded', () => {
  // Review Focus 2: a body that is huge, binary or base64 must not take the sync with it.
  const huge = `${'lorem ipsum '.repeat(450_000)}please send your resume`;

  it('scans only the first MAX_SCANNED_CHARS, so a term past the cap is not found', () => {
    expect(huge.length).toBeGreaterThan(5_000_000);
    expect(jobVocabularySignal(huge)).toBeNull();
    expect(jobVocabularySignal(`please send your resume ${huge}`)).toBe('resume');
  });

  it('returns in well under 250 ms on a 5 MB body', () => {
    const started = performance.now();
    jobVocabularySignal(huge);
    privateContentSignal(huge);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('is capped at a size that still covers a real message', () => {
    // A long job description is a few thousand characters; the cap is an order of magnitude up.
    expect(MAX_SCANNED_CHARS).toBe(100_000);
  });
});
