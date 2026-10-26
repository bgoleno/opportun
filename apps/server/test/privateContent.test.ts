// Rule 3a, the private-content veto's sender half (spec D1, decision D-2).
//
// Every address here is an invented .example archetype: a dental practice, a hospital group, a
// bank. None of them is an alias for a real sender, and nothing in this file was taken from a
// real mailbox, including the choice of which categories appear.
//
// What the test set encodes:
//   - a private sender's domain is usually a COMPOUND (`<x>medical`, `<x>bank`, `patient<x>`),
//     so matching whole labels only would catch almost nothing;
//   - a term that is a common English fragment (`vision` in television, `dds` in adds) is still
//     label-only, because that risk is real and those two terms are worth keeping.
//
// Rule 3a is not what stops an appointment reminder: rule 7 drops anything with no job signal.
// 3a exists to beat rules 4, 5 and 6, so its false positives cost a real job email while its
// false negatives usually cost nothing. That asymmetry is why the hiring-mailbox rescue below
// exists.
import { describe, expect, it } from 'vitest';
import { privateSenderSignal } from '../src/lib/privateContent';

describe('privateSenderSignal', () => {
  it('names the signal in a compound medical domain', () => {
    expect(privateSenderSignal('info@uppercervicalhealth.example')).toBe('health');
    // Health terms are ordered ahead of the money ones, so a medical biller reads as medical:
    // "dropped as medical" is the more useful sentence in the Blocked view.
    expect(privateSenderSignal('billing@valleymedicalgroup.example')).toBe('medical');
    expect(privateSenderSignal('noreply@mercyhospitalgroup.example')).toBe('hospital');
    expect(privateSenderSignal('hello@smiledentalcare.example')).toBe('dental');
  });

  it('names the signal in a compound financial domain', () => {
    expect(privateSenderSignal('noreply@firstnationalbank.example')).toBe('bank');
    expect(privateSenderSignal('service@summitcreditunion.example')).toBe('creditunion');
    expect(privateSenderSignal('claims@statefarminsurance.example')).toBe('insurance');
  });

  it('reads the local part too, since that is where a billing mailbox announces itself', () => {
    expect(privateSenderSignal('patientportal@thepracticegroup.example')).toBe('patient');
    expect(privateSenderSignal('billing@thepracticegroup.example')).toBe('billing');
  });

  it('leaves ordinary job mail alone', () => {
    expect(privateSenderSignal('recruiter@northwind-systems.example')).toBeNull();
    expect(privateSenderSignal('no-reply@candidate.example')).toBeNull();
    expect(privateSenderSignal('jane.smith@acme.example')).toBeNull();
    expect(privateSenderSignal('notifications@greenhouse-mail.example')).toBeNull();
  });

  it('does not fire on a hiring mailbox, however private the domain looks', () => {
    // The over-veto that would cost the most: a bank, hospital or insurer recruiting directly.
    // Their own domain says "private content" and their mailbox says "hiring"; the mailbox wins.
    expect(privateSenderSignal('careers@firstnationalbank.example')).toBeNull();
    expect(privateSenderSignal('recruiting@mercyhospitalgroup.example')).toBeNull();
    expect(privateSenderSignal('talent-acquisition@valleymedicalgroup.example')).toBeNull();
    // But a no-reply mailbox on the same domain is still private content.
    expect(privateSenderSignal('noreply@firstnationalbank.example')).toBe('bank');
  });

  it('does not match a term inside a word that means something else', () => {
    // The known false positive of substring matching, excluded by name rather than by hoping.
    expect(privateSenderSignal('hello@healthyfoods.example')).toBeNull();
    expect(privateSenderSignal('news@healthyliving.example')).toBeNull();
  });

  it('keeps a term that is a common English fragment to whole labels', () => {
    expect(privateSenderSignal('info@televisionnetwork.example')).toBeNull();
    expect(privateSenderSignal('sales@divisionsoftware.example')).toBeNull();
    expect(privateSenderSignal('team@buildersadds.example')).toBeNull();
    // As its own label it is the signal it looks like.
    expect(privateSenderSignal('appointments@vision.example')).toBe('vision');
    expect(privateSenderSignal('front.desk@brightsmile.dds.example')).toBe('dds');
  });

  it('is indifferent to case and surrounding whitespace', () => {
    expect(privateSenderSignal('  NoReply@FirstNationalBank.Example ')).toBe('bank');
  });

  it('returns null for an address it cannot read', () => {
    expect(privateSenderSignal('')).toBeNull();
    expect(privateSenderSignal('not-an-address')).toBeNull();
  });
});
