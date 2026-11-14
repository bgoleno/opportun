// Assisted apply on the public demo fills only the visitor's own data
// (https://github.com/bgoleno/opportun/issues/544, slice 1 of #542; tl and sec's design note,
// https://github.com/bgoleno/opportun/issues/542#issuecomment-6875801710). The demo never fills
// an application with its own test data: the seeded accounts' identities, the invented candidate,
// or a seeded resume. A visitor's own values, typed into the draft, may be filled.
//
// Server-side and on the demo only: off the demo nothing here runs. The checks run at review,
// at handoff and when the extension asks for the attempt (/connector/apply/current), so a fixture
// value put back behind the server's back is still never sent.
import { DEMO_IDENTITY_VALUES } from '../cli/seedDemoFixture';
import { HttpError } from './errors';

/**
 * Case, runs of whitespace and Unicode's compatibility forms (a full-width letter, a ligature) do
 * not make a value someone else's (NFKC, tl on #550).
 */
const normalise = (v: string): string =>
  v.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
/** A phone number is the same number however it is punctuated. */
const digits = (v: string): string => v.replace(/\D/g, '');

const IDENTITY = new Set(DEMO_IDENTITY_VALUES.map(normalise));
const IDENTITY_DIGITS = new Set(DEMO_IDENTITY_VALUES.map(digits).filter((d) => d.length >= 7));
/**
 * The demo's own mail domain: every email the seed writes is at it, and no visitor's own address
 * is, so any address there is the demo's (tl on #550), not only the ones the seed lists today.
 */
const DEMO_MAIL_DOMAIN = '@opportun-demo.example';

/** Whether `value`, in field `key`, is one of the demo's own identity values. */
export function isFixtureIdentity(key: string, value: string): boolean {
  const v = normalise(value);
  if (IDENTITY.has(v) || v.endsWith(DEMO_MAIL_DOMAIN)) return true;
  return key === 'phone' && digits(value).length >= 7 && IDENTITY_DIGITS.has(digits(value));
}

/**
 * The first field, by name, whose value is a fixture identity value, or null. A name split over
 * firstName and lastName is compared as one name too (qa and tl on #550), and named by firstName.
 * A first name alone is not refused: it names nobody.
 */
export function fixtureField(fields: Readonly<Record<string, string>>): string | null {
  const entries = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [key, value] of entries) {
    if (isFixtureIdentity(key, value)) return key;
  }
  const first = fields['firstName'];
  const last = fields['lastName'];
  if (
    first !== undefined &&
    last !== undefined &&
    isFixtureIdentity('fullName', `${first} ${last}`)
  ) {
    return 'firstName';
  }
  return null;
}

export const DEMO_RESUME_MESSAGE =
  'On the demo an application carries no resume: attach your own on the employer’s form.';
export const DEMO_FIXTURE_MESSAGE =
  'This value came with the demo. Enter your own, or leave the field empty.';

/** 422 naming the field that holds a fixture identity value. */
export const fixtureValueRefused = (field: string): HttpError =>
  new HttpError(422, 'demo_fixture_value', DEMO_FIXTURE_MESSAGE, { field });

/**
 * 422 for any resume on a demo attempt. Every resume on the demo is the seed's, or a copy tailored
 * from one: there is no upload path. So none is allowed, rather than telling seeded ones apart by
 * walking parentResumeId, which fails open: that column is ON DELETE SET NULL, so deleting the
 * seeded base orphans its copies (tl on #550). When an upload path arrives, record where a resume
 * came from at creation, as a flag a tailored copy carries forward; never derive it from parents.
 */
export const demoResumeRefused = (): HttpError =>
  new HttpError(422, 'resume_unavailable_on_demo', DEMO_RESUME_MESSAGE, { field: 'resume' });

/**
 * The backstop for review, handoff and /connector/apply/current: throws while any field holds a
 * fixture identity value, or while the attempt carries a resume at all (demoResumeRefused). Pure:
 * it reads only the attempt, so nothing it depends on can be missing and let it pass.
 */
export function refuseFixtureData(attempt: {
  fields: Readonly<Record<string, string>>;
  resumeId: string | null;
  resumeStore: string | null;
}): void {
  const field = fixtureField(attempt.fields);
  if (field !== null) throw fixtureValueRefused(field);
  if (attempt.resumeId !== null || attempt.resumeStore !== null) throw demoResumeRefused();
}
