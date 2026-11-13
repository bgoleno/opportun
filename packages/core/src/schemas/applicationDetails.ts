// The detail fields of an application and what a new draft is filled with (#411, slice 1 of
// https://github.com/bgoleno/opportun/issues/401; tl's design note issuecomment-6794002888).
//
// The rule: the profile is where these values live, a new draft starts as a copy of them, and
// after that the draft is its own. One list says which detail lives where, so the server, the
// details step and Settings > Profile read the same one.
import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common';
import { parseUrl, submissionFieldProblem } from './submission';

/**
 * Every detail field, in the order the details step shows them, and its home in the profile:
 * one of the profile's own columns, or `details`, the profile's Application details (one JSON
 * column, so a form that adds a key needs no migration). The keys follow the draft's field-name
 * rule; firstName, lastName, linkedinUrl and websiteUrl are what prefill fills by name (#181).
 */
export const APPLICATION_DETAIL_FIELDS = [
  { key: 'firstName', label: 'First name', home: 'details' },
  { key: 'lastName', label: 'Last name', home: 'details' },
  { key: 'fullName', label: 'Full name', home: 'fullName' },
  { key: 'email', label: 'Email', home: 'email' },
  { key: 'phone', label: 'Phone', home: 'phone' },
  // #435 (slice 1 of #402): country, school and degree are lists on most forms, and "how did you
  // hear" a list or a text question. They are text here, written as the form's list shows them.
  // `country` fills only the phone's country code on Greenhouse, so it is named that, never read
  // as where the user lives (sec on #402, issuecomment-6808114453 point 2.3); the key is kept.
  { key: 'country', label: 'Phone country code', home: 'details' },
  { key: 'location', label: 'Location (city)', home: 'location' },
  { key: 'workAuthorization', label: 'Work authorisation', home: 'workAuth' },
  { key: 'school', label: 'School', home: 'details' },
  { key: 'degree', label: 'Degree', home: 'details' },
  { key: 'linkedinUrl', label: 'LinkedIn profile', home: 'details' },
  { key: 'websiteUrl', label: 'Website', home: 'details' },
  { key: 'links', label: 'Links', home: 'details' },
  { key: 'heardFrom', label: 'How did you hear about this role?', home: 'details' },
] as const;

export type ApplicationDetailField = (typeof APPLICATION_DETAIL_FIELDS)[number];
export type ApplicationDetailKey = ApplicationDetailField['key'];
/** The profile columns a detail can live in. */
export type ProfileDetailColumn = Exclude<ApplicationDetailField['home'], 'details'>;

export const APPLICATION_DETAIL_KEYS = APPLICATION_DETAIL_FIELDS.map((f) => f.key) as [
  ApplicationDetailKey,
  ...ApplicationDetailKey[],
];

/** The keys the profile's Application details column holds (the rest live in columns). */
export const PROFILE_DETAIL_KEYS: readonly ApplicationDetailKey[] =
  APPLICATION_DETAIL_FIELDS.filter((f) => f.home === 'details').map((f) => f.key);

export function isApplicationDetailKey(key: string): key is ApplicationDetailKey {
  return (APPLICATION_DETAIL_KEYS as readonly string[]).includes(key);
}

export function applicationDetailField(key: ApplicationDetailKey): ApplicationDetailField {
  // The list holds every key, so this always finds one.
  return APPLICATION_DETAIL_FIELDS.find((f) => f.key === key) as ApplicationDetailField;
}

/** The longest value a draft field may hold (SubmissionFieldsSchema), and so a detail too. */
export const APPLICATION_DETAIL_MAX_LENGTH = 2_000;

/**
 * True when `value` may be copied into a draft as `key`: within the draft's length and passing
 * today's checks for that field (submissionFieldProblem). The same test the start-again
 * carry-over applies (#186).
 */
export function detailValuePasses(key: string, value: string): boolean {
  return (
    value.length <= APPLICATION_DETAIL_MAX_LENGTH &&
    submissionFieldProblem(Object.fromEntries([[key, value]])) === null
  );
}

/**
 * The profile's Application details as stored and as written: only the keys the list gives the
 * details home (never a key a user made up, so a name in an audit record is always one of these
 * constants; tl on #411), each value passing the draft's checks.
 */
export const ApplicationDetailsSchema = z
  .record(z.string(), z.string().max(APPLICATION_DETAIL_MAX_LENGTH))
  .superRefine((details, ctx) => {
    for (const [key, value] of Object.entries(details)) {
      if (!(PROFILE_DETAIL_KEYS as readonly string[]).includes(key)) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'not an application detail' });
      } else if (!detailValuePasses(key, value)) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'fails the check for this field' });
      }
    }
  });
export type ApplicationDetails = Record<string, string>;

/** Where a value on the details step came from. */
export const DetailSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('profile') }),
  z.object({ kind: z.literal('account') }),
  z.object({
    kind: z.literal('application'),
    submissionId: IdSchema,
    opportunityId: IdSchema,
    companyName: z.string(),
    reviewedAt: TimestampSchema,
  }),
]);
export type DetailSource = z.infer<typeof DetailSourceSchema>;

/** What Opportun holds for the user's next application (GET /profile/application-details). */
export const ApplicationDetailsPrefillSchema = z.object({
  values: z.array(
    z.object({
      key: z.enum(APPLICATION_DETAIL_KEYS),
      value: z.string(),
      source: DetailSourceSchema,
    }),
  ),
  /** Values a source holds that fail today's checks: left out, named so the step can say so. */
  leftOut: z.array(z.object({ key: z.enum(APPLICATION_DETAIL_KEYS), source: DetailSourceSchema })),
});
export type ApplicationDetailsPrefill = z.infer<typeof ApplicationDetailsPrefillSchema>;

/** The three sources, as the server loads them for one user. */
export interface DetailSources {
  profile: {
    fullName: string | null;
    email: string | null;
    phone: string | null;
    location: string | null;
    workAuth: string | null;
    links: readonly { label: string; url: string }[];
    applicationDetails: Readonly<Record<string, string>>;
  };
  /** The sign-in email and the display name. */
  account: { email: string | null; displayName: string | null };
  /** The user's one most recently reviewed attempt, other than the draft being filled. */
  lastApplication: {
    submissionId: string;
    opportunityId: string;
    companyName: string;
    reviewedAt: number;
    fields: Readonly<Record<string, string>>;
  } | null;
}

/** A link's host is linkedin.com or one of its subdomains (www., uk., ...). */
function isLinkedIn(url: string): boolean {
  const host = parseUrl(url)?.hostname.toLowerCase();
  return host === 'linkedin.com' || (host?.endsWith('.linkedin.com') ?? false);
}

/** The profile links' addresses as one text value, in order, stopping before the length cap. */
function linksText(links: DetailSources['profile']['links']): string {
  let text = '';
  for (const { url } of links) {
    const next = text === '' ? url : `${text}, ${url}`;
    if (next.length > APPLICATION_DETAIL_MAX_LENGTH) break;
    text = next;
  }
  return text;
}

const held = (value: string | null | undefined): value is string =>
  typeof value === 'string' && value.trim() !== '';

/**
 * What the profile holds for `key`, or null: the column or the saved detail, then for LinkedIn
 * profile the one link on linkedin.com (none, or two or more, give nothing), and for Links the
 * links as text. Website is never guessed from the links, and a full name is never split.
 */
function fromProfile(
  profile: DetailSources['profile'],
  field: ApplicationDetailField,
): string | null {
  if (field.home !== 'details') {
    const value = profile[field.home];
    return held(value) ? value : null;
  }
  const saved = profile.applicationDetails[field.key];
  if (held(saved)) return saved;
  if (field.key === 'linkedinUrl') {
    // A link the profile only lists is not a value the user saved: one that fails the LinkedIn
    // field's check is not held, and the next source decides (tl on #415). A saved detail that
    // fails is held, and left out with nothing in its place.
    const linkedIn = profile.links.filter((l) => isLinkedIn(l.url));
    const url = linkedIn.length === 1 ? (linkedIn[0]?.url ?? null) : null;
    return url !== null && detailValuePasses('linkedinUrl', url) ? url : null;
  }
  if (field.key === 'links') {
    const text = linksText(profile.links);
    return text === '' ? null : text;
  }
  return null;
}

/** The account fills two fields only: Email from the sign-in email, Full name from the name. */
function fromAccount(account: DetailSources['account'], key: ApplicationDetailKey): string | null {
  const value =
    key === 'email' ? account.email : key === 'fullName' ? account.displayName : undefined;
  return held(value) ? value : null;
}

/**
 * The values for a new draft, field by field in the list's order: the first source that holds
 * the field decides it (the profile, then the account, then the last reviewed application). A
 * value that fails today's checks is left out and named, and no other source is asked in its
 * place: an older application's value does not come back (tl on #411).
 */
export function resolveApplicationDetails(sources: DetailSources): ApplicationDetailsPrefill {
  const values: ApplicationDetailsPrefill['values'] = [];
  const leftOut: ApplicationDetailsPrefill['leftOut'] = [];
  const last = sources.lastApplication;
  for (const field of APPLICATION_DETAIL_FIELDS) {
    let found: { value: string; source: DetailSource } | null = null;
    const profileValue = fromProfile(sources.profile, field);
    const accountValue = fromAccount(sources.account, field.key);
    const lastValue = last?.fields[field.key];
    if (profileValue !== null) found = { value: profileValue, source: { kind: 'profile' } };
    else if (accountValue !== null) found = { value: accountValue, source: { kind: 'account' } };
    else if (last !== null && held(lastValue)) {
      const { submissionId, opportunityId, companyName, reviewedAt } = last;
      found = {
        value: lastValue,
        source: { kind: 'application', submissionId, opportunityId, companyName, reviewedAt },
      };
    }
    if (found === null) continue;
    if (detailValuePasses(field.key, found.value)) values.push({ key: field.key, ...found });
    else leftOut.push({ key: field.key, source: found.source });
  }
  return { values, leftOut };
}
