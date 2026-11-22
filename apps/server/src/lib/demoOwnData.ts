// Assisted apply on the public demo fills only the visitor's own data
// (https://github.com/bgoleno/opportun/issues/544, slice 1 of #542; tl and sec's design note,
// https://github.com/bgoleno/opportun/issues/542#issuecomment-6875801710). The demo never fills
// an application with its own test data: the seeded accounts' identities, the invented candidate,
// or a seeded resume. A visitor's own values, typed into the draft, may be filled.
//
// Server-side, for the demo's shared accounts only (lib/demoAccounts.ts, decision 133): an account
// made for one person on a demo server, and every account off the demo, is untouched. The checks run at review,
// at handoff and when the extension asks for the attempt (/connector/apply/current), so a fixture
// value put back behind the server's back is still never sent.
import { DEMO_IDENTITY_VALUES } from './demo/fixture';
import type { Config } from '../config';
import { isSharedDemoAccount } from './demoAccounts';
import { HttpError } from './errors';

/**
 * Case, runs of whitespace and Unicode's compatibility forms (a full-width letter, a ligature) do
 * not make a value someone else's (NFKC, tl on #550).
 */
const normalise = (v: string): string =>
  v.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
/** A phone number is the same number however it is punctuated. */
const digits = (v: string): string => v.replace(/\D/g, '');

/**
 * A phone's national number (#682, qa on #676): its digits, less the international prefix (00)
 * and North America's country code (1) on an 11-digit number, so the seeded +1 number typed as
 * 415-555-0134, 1-415-555-0134 or 00 1 415 555 0134 is the same number. The seed's numbers are
 * North American; another country's code stays, so +44 415 555 0134 is another number.
 */
function nationalDigits(v: string): string {
  let d = digits(v);
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d;
}

const IDENTITY = new Set(DEMO_IDENTITY_VALUES.map(normalise));
const IDENTITY_DIGITS = new Set(
  DEMO_IDENTITY_VALUES.map(nationalDigits).filter((d) => d.length >= 7),
);
/**
 * The demo's own mail domain: every email the seed writes is at it, and no visitor's own address
 * is, so any address there, or at a subdomain of it (qa on #550), is the demo's (tl on #550), not
 * only the ones the seed lists today.
 */
const DEMO_MAIL_DOMAIN = 'opportun-demo.example';

function atDemoDomain(v: string): boolean {
  const at = v.lastIndexOf('@');
  if (at < 0) return false;
  const domain = v.slice(at + 1);
  return domain === DEMO_MAIL_DOMAIN || domain.endsWith(`.${DEMO_MAIL_DOMAIN}`);
}

/** Whether `value`, in field `key`, is one of the demo's own identity values. */
export function isFixtureIdentity(key: string, value: string): boolean {
  const v = normalise(value);
  if (IDENTITY.has(v) || atDemoDomain(v)) return true;
  const phone = nationalDigits(value);
  return key === 'phone' && phone.length >= 7 && IDENTITY_DIGITS.has(phone);
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

/**
 * Whether an attempt belongs to `actor` (#545): on the demo, a device token is given only the
 * attempts its own visitor started. An attempt or a token with no actor (from before the binding)
 * belongs to nobody, so null never matches null.
 */
export function sameVisitor(attemptActor: string | null, actor: string | null): boolean {
  return attemptActor !== null && actor !== null && attemptActor === actor;
}

/**
 * Whether assisted apply is switched off for this user: a shared demo account while the operator
 * has set OPPORTUN_DEMO_SHARED_ASSISTED_APPLY=0 (decision 133). Everyone else follows
 * OPPORTUN_SUBMISSIONS alone.
 */
export function sharedAssistedApplyOff(
  cfg: Pick<Config, 'demo' | 'demoSharedAssistedApply'>,
  userId: string,
): boolean {
  return cfg.demoSharedAssistedApply === false && isSharedDemoAccount(cfg, userId);
}
