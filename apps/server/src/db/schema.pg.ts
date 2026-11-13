// Database schema, Postgres twin of schema.sqlite.ts (ADR-4, iteration 4 Task 7).
//
// Same tables, column names, nullability, defaults, foreign keys (with onDelete), unique
// constraints and indexes (names, uniqueness, partial predicates) as the SQLite schema, and
// identical row types: repos are typed against the SQLite tables and receive these at runtime
// when DB_DIALECT=postgres (db/schema.ts). test/schemaConformance.test.ts pins all of it.
//
// Type decisions (one rule per SQLite column kind; no per-column exceptions):
//
// | SQLite                         | Postgres                   | Why                                                                                         |
// | ------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------- |
// | text (ids, names, enums)       | text                       | UUIDv7 ids stay text; enums are text with the same { enum } list, no CREATE TYPE (simple migrations) |
// | integer                        | bigint, mode 'number'      | SQLite INTEGER is 64-bit. Epoch-ms timestamps need it, and several user-entered integers (comp_min/comp_max, seniority, sort_order) are validated only as nonnegative/any int, so int4 would turn input SQLite accepts into an overflow error. int8 arrives as a JS number (db/client.ts type parser, refusing values beyond 2^53). |
// | integer, mode 'boolean'        | boolean                    | Native booleans; raw SQL must compare with TRUE/FALSE or bare columns, never = 1 (Task 13 sweep) |
// | real                           | double precision           | Same IEEE double as SQLite REAL                                                             |
// | text, mode 'json'              | jsonb                      | See "JSON" below                                                                             |
//
// JSON: jsonb, not json or text. The recovery-code compare-and-set (lib/twoFactor.ts,
// `eq(users.totpRecovery, previous)`) binds the previous array through the column encoder
// (JSON.stringify) and compares it to the stored value. On SQLite that is text equality of
// two JSON.stringify outputs of the same array; on Postgres the untyped parameter is cast to
// jsonb and compared with jsonb equality, which is semantic (whitespace and key order do not
// matter; array order and every element do). For a string array that only ever shrinks, both
// mean "unchanged since it was read", so the CAS keeps its exactly-once outcome; a text column
// would also work there but would lose the ->> / @> operators db/dialect.ts uses for JSON
// lookups. Known jsonb differences, none relied on by the app: object key order is not
// preserved (affects byte-identical exports, Wave 4), duplicate keys collapse to the last, and
// "\u0000" is rejected (as it is in any Postgres text value).
//
// Defaults: the same literal values as SQLite (json defaults render as '[]'::jsonb / '{}'::jsonb).
// The FTS `search_index` table is not here (Task 11 defines the tsvector design).
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  ACTIVITY_KINDS,
  BODY_SOURCES,
  CLOSED_REASONS,
  COMM_CHANNELS,
  COMM_CLASSIFICATIONS,
  COMPANY_STATUSES,
  DISCOVERY_SOURCE_KINDS,
  DISMISS_REASONS,
  DISPOSITIONS,
  OPPORTUNITY_STAGES,
  OUTREACH_KINDS,
  POSTING_STATE_DETAILS,
  POSTING_STATES,
  REMOTE_PREFS,
  PREFILTER_OUTCOMES,
  PREFILTER_RULES,
  RANK_SKIP_REASONS,
  RESOLUTIONS,
  RESUME_KINDS,
  RESUME_RULE_CATEGORIES,
  RESUME_STATUSES,
  RESUME_STORES,
  SOURCE_KINDS,
  SUBMISSION_CONFIRMATION_KINDS,
  SUBMISSION_FAILURE_REASONS,
  SUBMISSION_SNAPSHOT_ERRORS,
  SUBMISSION_SNAPSHOT_STATES,
  SUBMISSION_STATUSES,
  ATS_REF_KINDS,
  type AtsJobRef,
  type Participant,
  type SubmissionAnswer,
  type SubmissionFields,
  INDUSTRY_SOURCES,
  INDUSTRY_TAG_SOURCES,
  NAICS_TIERS,
} from '@opportun/core';
import {
  type AtsJobRefRecord,
  CONTACT_SOURCES,
  DEDUPE_CANDIDATE_DECIDED_BY,
  DEDUPE_CANDIDATE_DECISIONS,
  type DeviceTokenScope,
  DISCOVERY_SOURCE_STATUSES,
  FEEDBACK_KINDS,
  JOB_STATUSES,
  MAIL_FILTER_EFFECTS,
  MAIL_FILTER_SOURCES,
  type MatchReport,
  OBS_SPAN_KINDS,
  OBS_SPAN_STATUSES,
  RANK_BATCH_STATES,
  type ProfileLinkRow,
  REJECTION_REASONS,
  SECRET_KINDS,
  SESSION_KINDS,
  TASK_RUN_STATUSES,
  type TranscriptTurn,
} from './schema.shared';

/** Every SQLite INTEGER: 64-bit, read as a JS number. */
const int = (name: string) => bigint(name, { mode: 'number' });
const id = () => text('id').primaryKey();
const createdAt = () => int('created_at').notNull();
const updatedAt = () => int('updated_at').notNull();
const userRef = () =>
  text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' });
const bool = (name: string) => boolean(name);
const json = <T>(name: string) => jsonb(name).$type<T>();

// ---------------------------------------------------------------------------
// 4.1 Identity and access

export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  isAdmin: bool('is_admin').notNull().default(false),
  totpSecret: text('totp_secret'),
  totpEnabled: bool('totp_enabled').notNull().default(false),
  /** jsonb: the recovery-code compare-and-set relies on jsonb equality (see the header). */
  totpRecovery: json<string[]>('totp_recovery'),
  totpLastStep: int('totp_last_step'),
  /** See schema.sqlite.ts: null until first sign-in, never cleared on sign-out (issue #320),
   *  accurate to within TOUCH_INTERVAL_MS (60s), not to the second. */
  lastSeenAt: int('last_seen_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: userRef(),
    expiresAt: int('expires_at').notNull(),
    lastSeenAt: int('last_seen_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    kind: text('kind', { enum: SESSION_KINDS }).notNull().default('session'),
    failedAttempts: int('failed_attempts').notNull().default(0),
    usedAt: int('used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)],
);

export const deviceTokens = pgTable(
  'device_tokens',
  {
    id: id(),
    userId: userRef(),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    scopes: json<DeviceTokenScope[]>('scopes').notNull(),
    lastUsedAt: int('last_used_at'),
    revokedAt: int('revoked_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('device_tokens_user_id_idx').on(t.userId)],
);

export const oauthAccounts = pgTable(
  'oauth_accounts',
  {
    id: id(),
    userId: userRef(),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    tokens: text('tokens'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('oauth_accounts_user_id_idx').on(t.userId),
    uniqueIndex('oauth_accounts_provider_account_uq').on(t.provider, t.providerAccountId),
  ],
);

export const secrets = pgTable(
  'secrets',
  {
    id: id(),
    userId: userRef(),
    kind: text('kind', { enum: SECRET_KINDS }).notNull(),
    label: text('label').notNull(),
    ciphertext: text('ciphertext').notNull(),
    iv: text('iv').notNull(),
    tag: text('tag').notNull(),
    keyVersion: int('key_version').notNull(),
    displayName: text('display_name'),
    expiresAt: int('expires_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('secrets_user_id_idx').on(t.userId)],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    event: text('event').notNull(),
    detail: json<Record<string, unknown>>('detail'),
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_log_user_id_idx').on(t.userId),
    index('audit_log_created_at_idx').on(t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// 4.5 (prompts first: role_targets references it)

export const prompts = pgTable(
  'prompts',
  {
    id: id(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    taskKey: text('task_key').notNull(),
    name: text('name').notNull(),
    body: text('body').notNull(),
    version: int('version').notNull(),
    parentId: text('parent_id').references((): AnyPgColumn => prompts.id, {
      onDelete: 'set null',
    }),
    isActive: bool('is_active').notNull().default(false),
    proposed: bool('proposed').notNull().default(false),
    proposalSummary: text('proposal_summary'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('prompts_user_id_idx').on(t.userId),
    uniqueIndex('prompts_task_version_user_uq').on(t.taskKey, t.version, t.userId),
    // NULLs are distinct in unique indexes on both engines; system defaults need their own.
    uniqueIndex('prompts_task_version_system_uq')
      .on(t.taskKey, t.version)
      .where(sql`${t.userId} IS NULL`),
  ],
);

// ---------------------------------------------------------------------------
// 4.2 Profile

export const profiles = pgTable('profiles', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  fullName: text('full_name'),
  headline: text('headline'),
  email: text('email'),
  phone: text('phone'),
  location: text('location'),
  workAuth: text('work_auth'),
  links: json<ProfileLinkRow[]>('links').notNull().default([]),
  /**
   * The application details with no column of their own (#411): keys from core's
   * APPLICATION_DETAIL_FIELDS whose home is `details`, values under the draft's checks
   * (ApplicationDetailsSchema). One JSON column, so a form that adds a key needs no migration.
   */
  applicationDetails: json<Record<string, string>>('application_details').notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const roleTargets = pgTable(
  'role_targets',
  {
    id: id(),
    userId: userRef(),
    name: text('name').notNull(),
    titleFamily: text('title_family').notNull(),
    seniorityMin: int('seniority_min'),
    seniorityMax: int('seniority_max'),
    industries: json<string[]>('industries').notNull().default([]),
    keywords: json<string[]>('keywords').notNull().default([]),
    /** Equivalent job titles for the discovery pre-filter (#217); AI-made, user-editable. */
    titleVariants: json<string[]>('title_variants').notNull().default([]),
    /**
     * Whether this target still wants a list from the AI (#217): true until one is written, and
     * again after a new name or title family. A list the user saves, an empty one included, sets
     * it false, so a call already under way cannot overwrite it and the sweep leaves it alone.
     */
    titleVariantsNeeded: bool('title_variants_needed').notNull().default(true),
    locations: json<string[]>('locations').notNull().default([]),
    remotePref: text('remote_pref', { enum: REMOTE_PREFS }).notNull().default('any'),
    compMin: int('comp_min'),
    compMax: int('comp_max'),
    currency: text('currency'),
    active: bool('active').notNull().default(true),
    discoveryPromptId: text('discovery_prompt_id').references(() => prompts.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('role_targets_user_id_idx').on(t.userId)],
);

export const resumeRules = pgTable(
  'resume_rules',
  {
    id: id(),
    userId: userRef(),
    ruleText: text('rule_text').notNull(),
    category: text('category', { enum: RESUME_RULE_CATEGORIES }).notNull(),
    active: bool('active').notNull().default(true),
    sortOrder: int('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('resume_rules_user_id_idx').on(t.userId)],
);

// ---------------------------------------------------------------------------
// 4.3 Pipeline

export const companies = pgTable(
  'companies',
  {
    id: id(),
    userId: userRef(),
    name: text('name').notNull(),
    domain: text('domain'),
    careersUrl: text('careers_url'),
    status: text('status', { enum: COMPANY_STATUSES }).notNull().default('none'),
    suggestionRationale: text('suggestion_rationale'),
    atsKind: text('ats_kind'),
    atsRef: text('ats_ref'),
    atsVerifiedAt: int('ats_verified_at'),
    notes: text('notes'),
    /** companyMatchKey(name) from @opportun/core, kept in step with name (issue #193). Null
     *  for a row written before this column existed, until the one-shot repair backfills it
     *  (companyMatchKeyRepair.ts); the near-miss dedupe scan simply finds no match for such a
     *  row's opportunities until then, the same way it would for a brand-new company whose
     *  heuristic has not run yet. */
    companyMatchKey: text('company_match_key'),
    /**
     * A NAICS 2022 industry group, from the discovery.company_tags task or the user's correction
     * (#220). industry_at set with no code means the model was asked and could not place it. Set
     * either way, the task does not ask again, so a correction is never overwritten.
     */
    naicsCode: text('naics_code'),
    industrySource: text('industry_source', { enum: INDUSTRY_TAG_SOURCES }),
    industryAt: int('industry_at'),
    /**
     * When the model last failed on this company asked alone (a refusal or an unusable answer,
     * #291), so the nightly run asks it after the rest: a name it always fails on must not stand
     * at the head of the queue, ahead of the companies behind it, every night. Ordering only: unlike
     * industry_at it does not stop the task asking again. Cleared when the company is tagged.
     */
    industryFailedAt: int('industry_failed_at'),
    /**
     * The tier of the confirmed profile row a suggestion was found for (#221, company.suggest v2),
     * and the one board probe made after it (company.board_probe): when it ran, how many postings
     * the board had open, and how many of them the pre-filter passes for the user's role targets.
     * Null until the probe has run, and where the company has no board to count.
     */
    suggestionTier: text('suggestion_tier', { enum: NAICS_TIERS }),
    boardProbedAt: int('board_probed_at'),
    boardOpenJobs: int('board_open_jobs'),
    boardPrefilterMatches: int('board_prefilter_matches'),
    /**
     * Up to 10 different job titles the board probe read from the listing, newest first (#301). The
     * tagging asks about a company with these when it has no postings stored from its board, and a
     * probe that came after a "tried, no code" answer counts as titles arriving. Null until a probe
     * has read a listing with a title in it.
     */
    boardTitles: json<string[]>('board_titles'),
    /**
     * How many nights the nightly network probe (#296) found the company's board provider failing.
     * At NETWORK_PROBE_FAILED_NIGHTS the company is recorded as having no board, so it stops holding
     * a place in each night's picks.
     */
    boardProbeFailedNights: int('board_probe_failed_nights').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('companies_user_id_idx').on(t.userId),
    index('companies_user_name_idx').on(t.userId, t.name),
    index('companies_user_match_key_idx').on(t.userId, t.companyMatchKey),
  ],
);

export const opportunities = pgTable(
  'opportunities',
  {
    id: id(),
    userId: userRef(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    roleTargetId: text('role_target_id').references(() => roleTargets.id, {
      onDelete: 'set null',
    }),
    title: text('title').notNull(),
    descriptionMd: text('description_md'),
    postingUrl: text('posting_url'),
    sourceKind: text('source_kind', { enum: SOURCE_KINDS }).notNull(),
    sourceRef: text('source_ref'),
    location: text('location'),
    remote: bool('remote'),
    compNote: text('comp_note'),
    stage: text('stage', { enum: OPPORTUNITY_STAGES }).notNull(),
    stageDetail: text('stage_detail'),
    closedReason: text('closed_reason', { enum: CLOSED_REASONS }),
    dismissedReason: text('dismissed_reason', { enum: DISMISS_REASONS }),
    priority: int('priority').notNull().default(2),
    /** Manual position within a stage (issue #240); see schema.sqlite.ts for the shape note. */
    sortOrder: int('sort_order').notNull().default(0),
    dedupeKey: text('dedupe_key'),
    /** Set once, when `force` bypasses a live dedupe match at create (#9): the opportunity this
     *  one was created as an override of. Null on the override's own row once merged or
     *  dismissed; auto-null on either row when the opportunity it names is deleted. */
    possibleDuplicateOf: text('possible_duplicate_of').references(
      (): AnyPgColumn => opportunities.id,
      { onDelete: 'set null' },
    ),
    /** Which req on which ATS board this is, once a board search confirmed it (design D16). */
    atsJobRef: json<AtsJobRef>('ats_job_ref'),
    /** How far the board search got, and why it needs review (design D17). */
    postingState: text('posting_state', { enum: POSTING_STATES }),
    postingStateDetail: text('posting_state_detail', { enum: POSTING_STATE_DETAILS }),
    /** SHA-256 of the description as the system last wrote it, so a user edit is detectable
     *  and never overwritten by a board (design D11). Null: the system never wrote it. */
    descriptionFingerprint: text('description_fingerprint'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('opportunities_user_id_idx').on(t.userId),
    index('opportunities_company_id_idx').on(t.companyId),
    index('opportunities_user_stage_idx').on(t.userId, t.stage),
    uniqueIndex('opportunities_user_dedupe_uq')
      .on(t.userId, t.dedupeKey)
      .where(sql`${t.dedupeKey} IS NOT NULL`),
    index('opportunities_user_possible_dup_idx').on(t.userId, t.possibleDuplicateOf),
  ],
);

/**
 * A near-miss duplicate pair the cheap heuristic found, or that a user ruled out directly
 * (issue #94). One row per unordered pair (opportunity_id_a < opportunity_id_b by string
 * compare, so detecting from either side finds the same row). This is what makes a decision
 * sticky: a 'rejected' row (from dismiss-duplicate, or a future AI pass saying no) is checked
 * before the heuristic ever writes `opportunities.possible_duplicate_of` again for that exact
 * pair, which #102's dismiss route could not do on its own (it only ever nulled the column,
 * leaving no record that the pair had been looked at and rejected rather than never evaluated).
 * A 'confirmed' row is bookkeeping for the same reason, not the source of truth for display:
 * the possible-duplicate badge/banner still reads `possible_duplicate_of` as #102 built it.
 */
export const opportunityDedupeCandidates = pgTable(
  'opportunity_dedupe_candidates',
  {
    id: id(),
    userId: userRef(),
    opportunityIdA: text('opportunity_id_a')
      .notNull()
      .references((): AnyPgColumn => opportunities.id, { onDelete: 'cascade' }),
    opportunityIdB: text('opportunity_id_b')
      .notNull()
      .references((): AnyPgColumn => opportunities.id, { onDelete: 'cascade' }),
    /** The heuristic's title-overlap score (0-1) at detection time, for the AI pass to
     *  prioritize its queue. Null for a row the user rejected directly: no heuristic score
     *  exists for a pair that was only ever linked via createOpportunity's exact-key force
     *  override (#9), and none is computed solely to fill this in. */
    score: doublePrecision('score'),
    decision: text('decision', { enum: DEDUPE_CANDIDATE_DECISIONS }).notNull(),
    /** Null while decision is 'pending'. */
    decidedBy: text('decided_by', { enum: DEDUPE_CANDIDATE_DECIDED_BY }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('opportunity_dedupe_candidates_user_id_idx').on(t.userId),
    uniqueIndex('opportunity_dedupe_candidates_pair_uq').on(t.opportunityIdA, t.opportunityIdB),
    index('opportunity_dedupe_candidates_decision_idx').on(t.userId, t.decision),
  ],
);

export const stageHistory = pgTable(
  'stage_history',
  {
    id: id(),
    userId: userRef(),
    opportunityId: text('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    fromStage: text('from_stage', { enum: OPPORTUNITY_STAGES }),
    toStage: text('to_stage', { enum: OPPORTUNITY_STAGES }).notNull(),
    note: text('note'),
    at: int('at').notNull(),
  },
  (t) => [
    index('stage_history_user_id_idx').on(t.userId),
    index('stage_history_opportunity_idx').on(t.opportunityId, t.at),
  ],
);

export const activities = pgTable(
  'activities',
  {
    id: id(),
    userId: userRef(),
    opportunityId: text('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ACTIVITY_KINDS }).notNull(),
    title: text('title').notNull(),
    bodyMd: text('body_md'),
    occurredAt: int('occurred_at').notNull(),
    participants: json<Participant[]>('participants').notNull().default([]),
    externalUrl: text('external_url'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('activities_user_id_idx').on(t.userId),
    index('activities_opportunity_idx').on(t.opportunityId, t.occurredAt),
  ],
);

export const nextSteps = pgTable(
  'next_steps',
  {
    id: id(),
    userId: userRef(),
    opportunityId: text('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    action: text('action').notNull(),
    dueAt: int('due_at'),
    doneAt: int('done_at'),
    owner: text('owner'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('next_steps_user_id_idx').on(t.userId),
    index('next_steps_opportunity_idx').on(t.opportunityId),
  ],
);

export const attachments = pgTable(
  'attachments',
  {
    id: id(),
    userId: userRef(),
    /**
     * Nullable, load-bearing: a resume document's content (store local_file, #284) is a row
     * here with no opportunity, since a base resume is not attached to one and a tailored
     * resume's own opportunity link lives on `resumes.opportunity_id`, not here. Nothing in
     * repos/attachments.ts can produce such a row (every function there requires one), so
     * adding `.notNull()` later would silently break the resume store rather than fail loudly
     * where the break happens.
     */
    opportunityId: text('opportunity_id').references(() => opportunities.id, {
      onDelete: 'cascade',
    }),
    filename: text('filename').notNull(),
    mime: text('mime').notNull(),
    bytes: int('bytes').notNull(),
    sha256: text('sha256').notNull(),
    storedPath: text('stored_path').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('attachments_user_id_idx').on(t.userId),
    index('attachments_opportunity_idx').on(t.opportunityId),
  ],
);

// ---------------------------------------------------------------------------
// 4.4 Resumes

export const resumes = pgTable(
  'resumes',
  {
    id: id(),
    userId: userRef(),
    kind: text('kind', { enum: RESUME_KINDS }).notNull(),
    opportunityId: text('opportunity_id').references(() => opportunities.id, {
      onDelete: 'set null',
    }),
    title: text('title').notNull(),
    store: text('store', { enum: RESUME_STORES }).notNull(),
    docRef: text('doc_ref').notNull(),
    parentResumeId: text('parent_resume_id').references((): AnyPgColumn => resumes.id, {
      onDelete: 'set null',
    }),
    status: text('status', { enum: RESUME_STATUSES }).notNull().default('draft'),
    submittedAt: int('submitted_at'),
    submittedTo: text('submitted_to'),
    /** Set instead of deleting a submitted resume (#70); status is untouched. */
    archivedAt: int('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('resumes_user_id_idx').on(t.userId),
    index('resumes_opportunity_idx').on(t.opportunityId),
  ],
);

export const tailoringSessions = pgTable(
  'tailoring_sessions',
  {
    id: id(),
    userId: userRef(),
    resumeId: text('resume_id')
      .notNull()
      .references(() => resumes.id, { onDelete: 'cascade' }),
    taskRunIds: json<string[]>('task_run_ids').notNull().default([]),
    transcript: json<TranscriptTurn[]>('transcript').notNull().default([]),
    acceptedAt: int('accepted_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('tailoring_sessions_user_id_idx').on(t.userId),
    index('tailoring_sessions_resume_idx').on(t.resumeId),
  ],
);

/** See schema.sqlite.ts for the issue #175 reasoning (latest-only, both FKs cascade). */
export const resumeMatchReports = pgTable(
  'resume_match_reports',
  {
    userId: userRef(),
    resumeId: text('resume_id')
      .notNull()
      .references(() => resumes.id, { onDelete: 'cascade' }),
    opportunityId: text('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    report: json<MatchReport>('report').notNull(),
    scoredAt: int('scored_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.resumeId, t.opportunityId] }),
    index('resume_match_reports_user_id_idx').on(t.userId),
  ],
);

// ---------------------------------------------------------------------------
// 4.5 Discovery and AI

export const discoverySources = pgTable(
  'discovery_sources',
  {
    id: id(),
    userId: userRef(),
    kind: text('kind', { enum: DISCOVERY_SOURCE_KINDS }).notNull(),
    config: json<Record<string, unknown>>('config').notNull().default({}),
    enabled: bool('enabled').notNull().default(true),
    prefilterEnabled: bool('prefilter_enabled').notNull().default(true),
    scheduleCron: text('schedule_cron'),
    roleTargetId: text('role_target_id').references(() => roleTargets.id, {
      onDelete: 'set null',
    }),
    companyId: text('company_id').references(() => companies.id, { onDelete: 'set null' }),
    lastRunAt: int('last_run_at'),
    status: text('status', { enum: DISCOVERY_SOURCE_STATUSES }).notNull().default('ok'),
    statusDetail: text('status_detail'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('discovery_sources_user_id_idx').on(t.userId)],
);

export const discoveryRuns = pgTable(
  'discovery_runs',
  {
    id: id(),
    userId: userRef(),
    sourceId: text('source_id')
      .notNull()
      .references(() => discoverySources.id, { onDelete: 'cascade' }),
    roleTargetId: text('role_target_id').references(() => roleTargets.id, {
      onDelete: 'set null',
    }),
    startedAt: int('started_at').notNull(),
    finishedAt: int('finished_at'),
    stats: json<Record<string, unknown>>('stats'),
    error: text('error'),
  },
  (t) => [
    index('discovery_runs_user_id_idx').on(t.userId),
    index('discovery_runs_source_idx').on(t.sourceId),
  ],
);

/**
 * A batch of ranking requests sent to the provider together (#441, tl's design on
 * https://github.com/bgoleno/opportun/issues/358). One in flight for each user at most. The
 * estimate is held against the discovery budget, for each posting still linked, until that
 * posting's result is applied (repos/rankBatches.ts).
 */
export const rankBatches = pgTable(
  'rank_batches',
  {
    id: id(),
    userId: userRef(),
    /** The provider and the policy the requests were built with: their cost is priced from it. */
    provider: text('provider').notNull(),
    policy: json<Record<string, unknown>>('policy').notNull(),
    /** The provider's id for the batch; null while it is being sent (state submitting). */
    providerBatchId: text('provider_batch_id'),
    state: text('state', { enum: RANK_BATCH_STATES }).notNull(),
    requestCount: int('request_count').notNull(),
    /** What the batch is estimated to cost, in dollars, all its requests together. */
    estCostUsd: doublePrecision('est_cost_usd').notNull(),
    submittedAt: int('submitted_at'),
    /** When collecting last asked the provider about it (every 10 minutes, then 30). */
    lastCheckedAt: int('last_checked_at'),
    collectedAt: int('collected_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('rank_batches_user_state_idx').on(t.userId, t.state)],
);

export const discoveryResults = pgTable(
  'discovery_results',
  {
    id: id(),
    userId: userRef(),
    runId: text('run_id')
      .notNull()
      .references(() => discoveryRuns.id, { onDelete: 'cascade' }),
    posting: json<Record<string, unknown>>('posting').notNull(),
    dedupeKey: text('dedupe_key'),
    aiScore: doublePrecision('ai_score'),
    aiRationale: text('ai_rationale'),
    /** The pre-filter's verdict, rule and title score (#217, shadow mode); null when not judged. */
    prefilterOutcome: text('prefilter_outcome', { enum: PREFILTER_OUTCOMES }),
    prefilterRule: text('prefilter_rule', { enum: PREFILTER_RULES }),
    prefilterScore: doublePrecision('prefilter_score'),
    /** Why ranking was skipped, until it is ranked (#210); null otherwise. */
    rankSkipReason: text('rank_skip_reason', { enum: RANK_SKIP_REASONS }),
    /**
     * When ranking began waiting for the discovery budget (#214), or when a provider failure last
     * used its turn (setRankTurnUsed); null when it is not waiting.
     */
    rankDeferredAt: int('rank_deferred_at'),
    /**
     * The batch this posting's ranking was sent in (#441), until its result is applied; with the
     * fingerprint of the text that was sent, and the prompt version it was sent with.
     */
    rankBatchId: text('rank_batch_id').references(() => rankBatches.id, { onDelete: 'set null' }),
    rankBatchBasis: text('rank_batch_basis'),
    rankBatchPromptId: text('rank_batch_prompt_id'),
    resolution: text('resolution', { enum: RESOLUTIONS }).notNull(),
    resolvedSourceRef: text('resolved_source_ref'),
    disposition: text('disposition', { enum: DISPOSITIONS }).notNull().default('pending'),
    opportunityId: text('opportunity_id').references(() => opportunities.id, {
      onDelete: 'set null',
    }),
    /**
     * The message this lead was parsed out of, for a channel that delivers postings by mail
     * (design D3b). Set null when that message goes, because the lead may still be in use.
     */
    sourceCommunicationId: text('source_communication_id').references(() => communications.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('discovery_results_user_id_idx').on(t.userId),
    index('discovery_results_run_idx').on(t.runId),
    index('discovery_results_user_dedupe_idx').on(t.userId, t.dedupeKey),
    index('discovery_results_user_deferred_idx').on(t.userId, t.rankDeferredAt),
    index('discovery_results_rank_batch_idx').on(t.rankBatchId),
  ],
);

/**
 * The user's own mail filter rules (spec D1 rules 0, 1 and 4; D7). The consumer-domain veto of
 * rule 2 is NOT stored here: it is a built-in list behind one per-user toggle, so this table
 * holds only what the user wrote or what rejection added on their behalf.
 *
 * `effect` carries precedence as well as action: allow is rule 0 and beats every heuristic,
 * deny is rule 1, and job_sender is rule 4, which passes a sender but only after the vetoes at
 * rules 2 and 3 have had their say. That distinction is load-bearing: a job_sender entry that
 * could override the private-content veto would expose, for example, the unemployment-claim
 * mail that shares state-benefits.example with its hiring-event mail.
 */
export const mailFilterRules = pgTable(
  'mail_filter_rules',
  {
    id: id(),
    userId: userRef(),
    /** A sender pattern as parseMailPattern accepts it (exact address, *@domain, *@*.domain). */
    pattern: text('pattern').notNull(),
    effect: text('effect', { enum: MAIL_FILTER_EFFECTS }).notNull(),
    enabled: bool('enabled').notNull().default(true),
    source: text('source', { enum: MAIL_FILTER_SOURCES }).notNull().default('user'),
    /** Why this rule exists, shown in settings so a rejection-added entry can be undone. */
    note: text('note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('mail_filter_rules_user_id_idx').on(t.userId),
    uniqueIndex('mail_filter_rules_user_effect_pattern_uq').on(t.userId, t.effect, t.pattern),
  ],
);

export const dismissalFeedback = pgTable(
  'dismissal_feedback',
  {
    id: id(),
    userId: userRef(),
    kind: text('kind', { enum: FEEDBACK_KINDS }).notNull().default('dismissal'),
    opportunityId: text('opportunity_id').references(() => opportunities.id, {
      onDelete: 'set null',
    }),
    resultId: text('result_id').references(() => discoveryResults.id, { onDelete: 'set null' }),
    communicationId: text('communication_id').references(() => communications.id, {
      onDelete: 'set null',
    }),
    reason: text('reason'),
    note: text('note'),
    /** The user opted this one note in to prompt refinement; off by default (spec D4). */
    shareNote: bool('share_note').notNull().default(false),
    at: int('at').notNull(),
  },
  (t) => [
    index('dismissal_feedback_user_id_idx').on(t.userId),
    index('dismissal_feedback_user_kind_at_idx').on(t.userId, t.kind, t.at),
  ],
);

/**
 * The user's industry profile (https://github.com/bgoleno/opportun/issues/219): NAICS 2022 codes
 * from the table in @opportun/core, proposed by the discovery.industry_profile task or added by
 * the user. Only a confirmed row counts.
 */
export const industryProfile = pgTable(
  'industry_profile',
  {
    id: id(),
    userId: userRef(),
    naicsCode: text('naics_code').notNull(),
    tier: text('tier', { enum: NAICS_TIERS }).notNull(),
    source: text('source', { enum: INDUSTRY_SOURCES }).notNull(),
    /** The model's one line; null on a row the user added. */
    reason: text('reason'),
    confirmed: bool('confirmed').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('industry_profile_user_code_uq').on(t.userId, t.naicsCode)],
);

export const taskRuns = pgTable(
  'task_runs',
  {
    id: id(),
    userId: userRef(),
    taskKey: text('task_key').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    promptId: text('prompt_id').references(() => prompts.id, { onDelete: 'set null' }),
    promptVersion: int('prompt_version'),
    inputTokens: int('input_tokens').notNull().default(0),
    outputTokens: int('output_tokens').notNull().default(0),
    estCost: doublePrecision('est_cost').notNull().default(0),
    fallbackPricing: bool('fallback_pricing').notNull().default(false),
    durationMs: int('duration_ms').notNull().default(0),
    status: text('status', { enum: TASK_RUN_STATUSES }).notNull(),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [
    index('task_runs_user_id_idx').on(t.userId),
    index('task_runs_user_task_created_idx').on(t.userId, t.taskKey, t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// 4.6 Network and communications

export const networkContacts = pgTable(
  'network_contacts',
  {
    id: id(),
    userId: userRef(),
    name: text('name').notNull(),
    emails: json<string[]>('emails').notNull().default([]),
    linkedinUrl: text('linkedin_url'),
    currentCompanyId: text('current_company_id').references(() => companies.id, {
      onDelete: 'set null',
    }),
    history: json<Record<string, unknown>[]>('history').notNull().default([]),
    strength: int('strength'),
    notes: text('notes'),
    source: text('source', { enum: CONTACT_SOURCES }).notNull().default('manual'),
    tags: json<string[]>('tags').notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('network_contacts_user_id_idx').on(t.userId),
    index('network_contacts_user_company_idx').on(t.userId, t.currentCompanyId),
  ],
);

export const communications = pgTable(
  'communications',
  {
    id: id(),
    userId: userRef(),
    channel: text('channel', { enum: COMM_CHANNELS }).notNull(),
    externalId: text('external_id').notNull(),
    threadKey: text('thread_key'),
    from: text('from').notNull(),
    to: json<string[]>('to').notNull().default([]),
    subject: text('subject'),
    snippet: text('snippet'),
    bodyRef: text('body_ref'),
    sentAt: int('sent_at').notNull(),
    classification: text('classification', { enum: COMM_CLASSIFICATIONS }),
    outreachKind: text('outreach_kind', { enum: OUTREACH_KINDS }),
    mismatchReason: text('mismatch_reason'),
    confidence: doublePrecision('confidence'),
    /** What the classifier actually read (issue #149); null for a message never classified,
     * or classified before this column existed. */
    bodySource: text('body_source', { enum: BODY_SOURCES }),
    opportunityId: text('opportunity_id').references(() => opportunities.id, {
      onDelete: 'set null',
    }),
    contactId: text('contact_id').references(() => networkContacts.id, { onDelete: 'set null' }),
    needsReview: bool('needs_review').notNull().default(false),
    proposedTransition: text('proposed_transition', { enum: OPPORTUNITY_STAGES }),
    /** Stage 1 verdict (spec D1): 'passed' reached the classifier, 'filtered' never did. */
    triageDecision: text('triage_decision'),
    /** Which rule decided, so the blocked view can say why without storing the message. */
    triageRule: text('triage_rule'),
    /**
     * ATS job references extracted from the body at ingest (design D-5). Stored because the
     * body is not: find-posting reads these instead of re-reading a message that no longer
     * exists on disk, and unlike re-fetching it works for Apple Mail and LinkedIn too.
     */
    atsJobRefs: json<AtsJobRefRecord[]>('ats_job_refs'),
    /** Set when the user rejected this message as out of scope (spec D4). */
    rejectedAt: int('rejected_at'),
    rejectionReason: text('rejection_reason', { enum: REJECTION_REASONS }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('communications_user_id_idx').on(t.userId),
    uniqueIndex('communications_user_channel_external_uq').on(t.userId, t.channel, t.externalId),
    index('communications_user_thread_idx').on(t.userId, t.threadKey),
    index('communications_opportunity_idx').on(t.opportunityId),
  ],
);

// ---------------------------------------------------------------------------
// Assisted apply (https://github.com/bgoleno/opportun/issues/79, design Part A section 4.2)

/**
 * One attempt to apply to one opportunity. Opportun never transmits an application: this
 * records what the user prepared, reviewed and later says they submitted themselves, so the
 * timeline can tell the truth about it. Status rules: @opportun/core submissionStateMachine.
 */
export const applicationSubmissions = pgTable(
  'application_submissions',
  {
    id: id(),
    userId: userRef(),
    opportunityId: text('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    /** The resume chosen; it may later be edited or deleted, so its facts are copied below. */
    resumeId: text('resume_id').references(() => resumes.id, { onDelete: 'set null' }),
    /** The opportunity's ATS identity when the attempt began (opportunities.ats_job_ref). */
    atsKind: text('ats_kind', { enum: ATS_REF_KINDS }).notNull(),
    /** Board org, or Workday `<tenant>/<site>`. */
    atsRef: text('ats_ref'),
    atsExternalId: text('ats_external_id').notNull(),
    /** The employer's posting, https only; the server never fetches it. */
    destinationUrl: text('destination_url').notNull(),
    status: text('status', { enum: SUBMISSION_STATUSES }).notNull().default('draft'),
    /** Client-generated per attempt: a repeated create returns the same row. */
    idempotencyKey: text('idempotency_key').notNull(),
    /** The immutable resume snapshot, and what it was, kept even if the attachment goes. */
    resumeAttachmentId: text('resume_attachment_id').references(() => attachments.id, {
      onDelete: 'set null',
    }),
    resumeSha256: text('resume_sha256'),
    resumeTitle: text('resume_title'),
    resumeStore: text('resume_store', { enum: RESUME_STORES }),
    resumeDocRef: text('resume_doc_ref'),
    resumeRevision: text('resume_revision'),
    /**
     * Where the snapshot stands (#115): pending until the export job writes it, then ready,
     * unsupported (the store has no PDF) or failed. A failed export leaves the draft a draft.
     */
    snapshotState: text('snapshot_state', { enum: SUBMISSION_SNAPSHOT_STATES })
      .notNull()
      .default('pending'),
    /** Why there is no snapshot (unsupported or failed): the store's code, never its message. */
    snapshotError: text('snapshot_error', { enum: SUBMISSION_SNAPSHOT_ERRORS }),
    /** The profile values the user approved, by field name. */
    fields: json<SubmissionFields>('fields').notNull(),
    /** The user's answers to the form's questions; user-authored, treated like notes. */
    answers: json<SubmissionAnswer[]>('answers').notNull(),
    reviewDigest: text('review_digest'),
    reviewExpiresAt: int('review_expires_at'),
    reviewedAt: int('reviewed_at'),
    handedOffAt: int('handed_off_at'),
    /**
     * When the extension first read this attempt to fill it (#403 slice 2): set once, by the
     * first GET /connector/apply/current that returns it, in the statement that checks it is
     * still null. The popup fills on open only for that first read; after it, the button.
     */
    prefillReadAt: int('prefill_read_at'),
    submittedAt: int('submitted_at'),
    confirmedAt: int('confirmed_at'),
    /** 'user_attested' is the only basis: only the user's word makes an attempt submitted. */
    submittedBasis: text('submitted_basis'),
    confirmationKind: text('confirmation_kind', { enum: SUBMISSION_CONFIRMATION_KINDS }),
    confirmationCommId: text('confirmation_comm_id').references(() => communications.id, {
      onDelete: 'set null',
    }),
    /** Which signals matched, never message content. */
    confirmationBasis: json<unknown>('confirmation_basis'),
    failureReason: text('failure_reason', { enum: SUBMISSION_FAILURE_REASONS }),
    submittedActivityId: text('submitted_activity_id').references(() => activities.id, {
      onDelete: 'set null',
    }),
    confirmationActivityId: text('confirmation_activity_id').references(() => activities.id, {
      onDelete: 'set null',
    }),
    /**
     * Why the user is applying again to a requisition they already applied to (owner decision 6,
     * #118): typed by the user at review, required then, and kept with the attempt.
     */
    reapplyReason: text('reapply_reason'),
    /**
     * The next step the follow-up created when no confirmation was seen (M2a, #118), so recording
     * an outcome can close it (#148). Cleared if the user deletes the step.
     */
    followupNextStepId: text('followup_next_step_id').references(() => nextSteps.id, {
      onDelete: 'set null',
    }),
    /**
     * When the opportunity's posting URL or ATS identity last changed while this attempt was
     * live and not yet opened (#144). The attempt keeps its pinned destination; the review digest
     * covers this, so a review screen shown before the change cannot be confirmed.
     */
    postingChangedAt: int('posting_changed_at'),
    /** A re-application to the same requisition names the attempt it repeats. */
    reapplyOf: text('reapply_of').references((): AnyPgColumn => applicationSubmissions.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('application_submissions_user_id_idx').on(t.userId),
    index('application_submissions_opportunity_idx').on(t.opportunityId, t.createdAt),
    uniqueIndex('application_submissions_user_idem_uq').on(t.userId, t.idempotencyKey),
    // One live attempt per opportunity (draft, reviewed or handed_off).
    uniqueIndex('application_submissions_live_uq')
      .on(t.userId, t.opportunityId)
      .where(sql`${t.status} IN ('draft', 'reviewed', 'handed_off')`),
    // Not unique: a re-application to the same requisition must be insertable.
    index('application_submissions_requisition_idx').on(
      t.userId,
      t.atsKind,
      t.atsRef,
      t.atsExternalId,
    ),
  ],
);

// Resume sends (https://github.com/bgoleno/opportun/issues/158, option A): one row per time a
// resume, base or tailored, was sent for an opportunity. A send never writes the resume row:
// the resume's status and submitted_at/submitted_to as the API shows them are derived from
// its sends and its own stored record (repos/resumeSends.ts, effectiveSubmission).
export const resumeSends = pgTable(
  'resume_sends',
  {
    id: id(),
    userId: userRef(),
    opportunityId: text('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    /** CASCADE, not RESTRICT (tl): deleteResume archives a resume that has sends, so a normal
     *  delete keeps them; RESTRICT would break deletes cascading from above (a user). */
    resumeId: text('resume_id')
      .notNull()
      .references(() => resumes.id, { onDelete: 'cascade' }),
    sentAt: int('sent_at').notNull(),
    /** How it was sent, in the user's words ("Indeed"), or the ATS name for assisted apply. */
    sentVia: text('sent_via').notNull(),
    /** The assisted-apply attempt whose "I submitted it" recorded this send, if any. */
    submissionId: text('submission_id').references(() => applicationSubmissions.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (t) => [
    index('resume_sends_user_id_idx').on(t.userId),
    index('resume_sends_opportunity_idx').on(t.opportunityId, t.sentAt),
    index('resume_sends_resume_idx').on(t.resumeId, t.sentAt),
  ],
);

export const syncState = pgTable(
  'sync_state',
  {
    userId: userRef(),
    integration: text('integration').notNull(),
    cursor: json<unknown>('cursor'),
    lastSyncAt: int('last_sync_at'),
    status: text('status'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.integration] })],
);

// ---------------------------------------------------------------------------
// Section 8: background jobs, and settings

export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    kind: text('kind').notNull(),
    payload: json<unknown>('payload').notNull(),
    runAt: int('run_at').notNull(),
    attempts: int('attempts').notNull().default(0),
    maxAttempts: int('max_attempts').notNull(),
    lockedBy: text('locked_by'),
    lockedAt: int('locked_at'),
    lastError: text('last_error'),
    status: text('status', { enum: JOB_STATUSES }).notNull().default('pending'),
    dedupeKey: text('dedupe_key'),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    result: json<unknown>('result'),
    traceContext: text('trace_context'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('jobs_status_run_at_idx').on(t.status, t.runAt),
    index('jobs_kind_dedupe_idx').on(t.kind, t.dedupeKey),
    uniqueIndex('jobs_unfinished_dedupe_uq')
      .on(t.kind, t.dedupeKey)
      .where(sql`${t.dedupeKey} IS NOT NULL AND ${t.status} IN ('pending', 'running')`),
    index('jobs_user_id_idx').on(t.userId),
  ],
);

export const settings = pgTable(
  'settings',
  {
    key: text('key').primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    value: json<unknown>('value').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [index('settings_user_id_idx').on(t.userId)],
);

// ---------------------------------------------------------------------------
// Section 9: observability (design.md 14.7; https://github.com/bgoleno/opportun/issues/353). The
// local store the in-app dashboards read. Written only while the Collect switch is on (off by
// default), pruned hourly by obs.prune (jobs/obsPrune.ts), deleted with their user, and left out
// of the data export (lib/exporter.ts): derived operating data, like jobs.

/**
 * One series in one time bucket. A series is a metric, its owner and its attributes; `series`
 * is their hash (obs/metrics.ts seriesId), so the key needs no row id. `metric` and
 * `attributes` are kept readable beside it for the dashboards' filters and breakdowns (FR-T6).
 */
export const obsMetricPoints = pgTable(
  'obs_metric_points',
  {
    series: text('series').notNull(),
    metric: text('metric').notNull(),
    attributes: json<Record<string, unknown>>('attributes').notNull(),
    /** The user the point belongs to (a user-scoped metric), or null for the instance's. */
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    /** The bucket's length in ms: 60,000 (kept 48 hours) or 3,600,000 (kept 30 days). */
    resolution: int('resolution').notNull(),
    bucketStart: int('bucket_start').notNull(),
    count: int('count').notNull(),
    sum: doublePrecision('sum').notNull(),
    min: doublePrecision('min').notNull(),
    max: doublePrecision('max').notNull(),
    /** A histogram's per-bucket counts (the catalog's boundaries, plus one); null for a counter. */
    bucketCounts: json<number[]>('bucket_counts'),
  },
  (t) => [
    primaryKey({ columns: [t.series, t.resolution, t.bucketStart] }),
    index('obs_metric_points_metric_idx').on(t.metric, t.resolution, t.bucketStart),
    index('obs_metric_points_age_idx').on(t.resolution, t.bucketStart),
    index('obs_metric_points_user_id_idx').on(t.userId),
  ],
);

/** One kept trace (14.7): always a user's, kept up to date as its spans arrive. */
export const obsTraces = pgTable(
  'obs_traces',
  {
    /** The W3C trace id: 32 lowercase hex digits. */
    traceId: text('trace_id').primaryKey(),
    userId: userRef(),
    startedAt: int('started_at').notNull(),
    durationMs: doublePrecision('duration_ms').notNull(),
    /** What contained the first Gen AI span: a route template, or `job {kind}`. */
    origin: text('origin').notNull(),
    workflow: text('workflow'),
    feature: text('feature'),
    /** The tailoring session id, on a chat's trace only. */
    conversationId: text('conversation_id'),
    tasks: json<string[]>('tasks').notNull().default([]),
    models: json<string[]>('models').notNull().default([]),
    providers: json<string[]>('providers').notNull().default([]),
    inputTokens: int('input_tokens').notNull().default(0),
    outputTokens: int('output_tokens').notNull().default(0),
    estCost: doublePrecision('est_cost').notNull().default(0),
    spanCount: int('span_count').notNull().default(0),
    errorCount: int('error_count').notNull().default(0),
    status: text('status', { enum: OBS_SPAN_STATUSES }).notNull(),
    /** The trace reached its span limit (14.11) and stopped growing. */
    truncated: bool('truncated').notNull().default(false),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('obs_traces_user_started_idx').on(t.userId, t.startedAt),
    index('obs_traces_user_conversation_idx').on(t.userId, t.conversationId),
    index('obs_traces_started_idx').on(t.startedAt),
  ],
);

/** One kept span (14.7), with its inference span's task, model and provider in columns. */
export const obsSpans = pgTable(
  'obs_spans',
  {
    traceId: text('trace_id')
      .notNull()
      .references(() => obsTraces.traceId, { onDelete: 'cascade' }),
    /** The W3C span id: 16 lowercase hex digits. */
    spanId: text('span_id').notNull(),
    parentSpanId: text('parent_span_id'),
    userId: userRef(),
    name: text('name').notNull(),
    kind: text('kind', { enum: OBS_SPAN_KINDS }).notNull(),
    startedAt: int('started_at').notNull(),
    durationMs: doublePrecision('duration_ms').notNull(),
    status: text('status', { enum: OBS_SPAN_STATUSES }).notNull(),
    errorType: text('error_type'),
    /** The span's attributes, every one checked by obs/gate.ts. */
    attributes: json<Record<string, unknown>>('attributes').notNull(),
    task: text('task'),
    model: text('model'),
    provider: text('provider'),
  },
  (t) => [
    primaryKey({ columns: [t.traceId, t.spanId] }),
    index('obs_spans_user_started_idx').on(t.userId, t.startedAt),
    index('obs_spans_started_idx').on(t.startedAt),
  ],
);
