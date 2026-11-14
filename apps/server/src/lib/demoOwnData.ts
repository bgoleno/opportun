// Assisted apply on the public demo fills only the visitor's own data
// (https://github.com/bgoleno/opportun/issues/544, slice 1 of #542; tl and sec's design note,
// https://github.com/bgoleno/opportun/issues/542#issuecomment-6875801710). The demo never fills
// an application with its own test data: the seeded accounts' identities, the invented candidate,
// or a seeded resume. A visitor's own values, typed into the draft, may be filled.
//
// Server-side and on the demo only: off the demo nothing here runs. The checks run at review,
// at handoff and when the extension asks for the attempt (/connector/apply/current), so a fixture
// value put back behind the server's back is still never sent.
import { and, eq, inArray } from 'drizzle-orm';
import type { Exec } from '../db/client';
import { resumes, settings } from '../db/schema';
import { DEMO_IDENTITY_VALUES } from '../cli/seedDemoFixture';
import type { UserCtx } from '../repos/base';
import { HttpError } from './errors';

/** The settings row (user null) where the demo seed records the ids of the resumes it made. */
export const DEMO_RESUME_IDS_KEY = 'demo_resume_ids';

/** Case and runs of whitespace do not make a value someone else's. */
const normalise = (v: string): string => v.trim().replace(/\s+/g, ' ').toLowerCase();
/** A phone number is the same number however it is punctuated. */
const digits = (v: string): string => v.replace(/\D/g, '');

const IDENTITY = new Set(DEMO_IDENTITY_VALUES.map(normalise));
const IDENTITY_DIGITS = new Set(DEMO_IDENTITY_VALUES.map(digits).filter((d) => d.length >= 7));

/** Whether `value`, in field `key`, is one of the demo's own identity values. */
export function isFixtureIdentity(key: string, value: string): boolean {
  if (IDENTITY.has(normalise(value))) return true;
  return key === 'phone' && digits(value).length >= 7 && IDENTITY_DIGITS.has(digits(value));
}

/** The first field, by name, whose value is a fixture identity value, or null. */
export function fixtureField(fields: Readonly<Record<string, string>>): string | null {
  const entries = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [key, value] of entries) {
    if (isFixtureIdentity(key, value)) return key;
  }
  return null;
}

/** The ids the demo seed recorded for its resumes, or none. */
async function seededResumeIds(exec: Exec): Promise<ReadonlySet<string>> {
  const row = await exec
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, DEMO_RESUME_IDS_KEY))
    .get();
  const ids = row?.value;
  return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []);
}

/**
 * Whether the resume is one the seed made, or tailored (at any depth) from one: its lineage root,
 * by parentResumeId, is a seeded resume. A content hash would miss the tailored copies.
 */
export async function isSeededResume(exec: Exec, ctx: UserCtx, resumeId: string): Promise<boolean> {
  const seeded = await seededResumeIds(exec);
  if (seeded.size === 0) return false;
  const seen = new Set<string>();
  let id: string | null = resumeId;
  // Bounded by the user's own resumes: a cycle cannot loop, since each id is visited once.
  while (id !== null && !seen.has(id)) {
    if (seeded.has(id)) return true;
    seen.add(id);
    const row: { parent: string | null } | undefined = await exec
      .select({ parent: resumes.parentResumeId })
      .from(resumes)
      .where(and(eq(resumes.userId, ctx.userId), inArray(resumes.id, [id])))
      .get();
    id = row?.parent ?? null;
  }
  return false;
}

export const DEMO_RESUME_MESSAGE =
  'This resume came with the demo. Apply without a resume here, and attach your own on the employer’s form.';
export const DEMO_FIXTURE_MESSAGE =
  'This value came with the demo. Enter your own, or leave the field empty.';

/** 422 naming the field that holds a fixture identity value. */
export const fixtureValueRefused = (field: string): HttpError =>
  new HttpError(422, 'demo_fixture_value', DEMO_FIXTURE_MESSAGE, { field });

/** 422 for a seeded or seeded-derived resume. */
export const fixtureResumeRefused = (): HttpError =>
  new HttpError(422, 'demo_fixture_resume', DEMO_RESUME_MESSAGE, { field: 'resume' });

/**
 * The backstop for review, handoff and /connector/apply/current: throws while any field holds a
 * fixture identity value, or while the attempt's resume is seeded or tailored from a seeded base.
 */
export async function refuseFixtureData(
  exec: Exec,
  ctx: UserCtx,
  attempt: { fields: Readonly<Record<string, string>>; resumeId: string | null },
): Promise<void> {
  const field = fixtureField(attempt.fields);
  if (field !== null) throw fixtureValueRefused(field);
  if (attempt.resumeId !== null && (await isSeededResume(exec, ctx, attempt.resumeId))) {
    throw fixtureResumeRefused();
  }
}
