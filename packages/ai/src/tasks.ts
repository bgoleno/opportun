// Task registry (FR-A2, A4): one entry per AI task, with its default policy (config data from
// policies.ts), the prompt variables it renders, and the structured output it must return.
// Prompt bodies live in the prompts table (seeded by apps/server/drizzle/0002_prompt_seeds.sql).
import { COMM_CLASSIFICATIONS, OPPORTUNITY_STAGES, OUTREACH_KINDS } from '@opportun/core';
import { z } from 'zod';
import { DEFAULT_POLICIES } from './policies';
import type { ModelPolicy, TaskKey } from './types';

export interface TaskDef<I, O> {
  key: TaskKey;
  description: string;
  defaultPolicy: ModelPolicy;
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
  defaultPromptName: string;
}

/** Prompt variables are strings; the object shape lists exactly what the template uses. */
function vars<const K extends string>(...names: K[]) {
  return z.strictObject(
    Object.fromEntries(names.map((n) => [n, z.string()])) as { [P in K]: z.ZodString },
  );
}

const DEFAULT_PROMPT_NAME = 'default';

// ---------------------------------------------------------------------------
// Inputs (prompt variables). A name ending in _untrusted is wrapped by renderPrompt. Anything a
// third party or a model can influence is _untrusted: posting and page text and URLs, mail,
// contacts, and opportunity or company names and titles (those can be created from model output
// on hostile mail, from imports, or from scraped postings). Unfenced variables are only what the
// user or the app writes; tasks.test.ts keeps that reviewed list.

const TailorInput = vars('resume_rules', 'base_resume', 'jd_untrusted', 'match_report');
const MatchInput = vars('resume_text', 'jd_untrusted');
const RankInput = vars('role_target', 'posting_untrusted');
const RefineInput = vars('current_prompt', 'feedback_summary');
/** Stage 2's gate: the sender, the subject and a 500-character head of the body, fenced. */
const TriageInput = vars('message_untrusted');
const ClassifyInput = vars('role_targets', 'open_opportunities_untrusted', 'message_untrusted');
const DedupeInput = vars('existing_opportunities_untrusted', 'candidate_untrusted');
const ReferralInput = vars('contacts_untrusted', 'opportunity_untrusted');
const CaptureInput = vars('page_url_untrusted', 'page_untrusted');
/** A LinkedIn page the user visited, pushed by the extension (FR-C5): URL, tab title and text. */
const LinkedInCaptureInput = vars('page_url_untrusted', 'page_title_untrusted', 'page_untrusted');
const PostingMergeInput = vars('ats_untrusted', 'capture_untrusted');
const SuggestInput = vars('role_targets', 'pipeline_untrusted', 'denied_companies_untrusted');
/** An error message the user pasted from Google's console or consent screen. */
const DiagnoseInput = vars('error_untrusted');

// ---------------------------------------------------------------------------
// Outputs. Optional values are nullable (not optional) so strict provider JSON modes work.

export const ResumeEditSchema = z.object({
  find: z.string().min(1),
  replace: z.string(),
  rationale: z.string(),
});
export const TailorOutputSchema = z.object({ edits: z.array(ResumeEditSchema) });

/**
 * A whole-number 0-100 quality score shown to the user as a percentage-style assessment
 * (resume.match, discovery.rank). This is NOT a confidence: the `confidence` fields below are a
 * genuinely different, legitimately 0-to-1 signal about how sure the model is in a classification
 * decision, never rendered to the user as a score. Keeping the two scales adjacent but distinct
 * (rather than collapsing everything to one scale) is deliberate; see tasks.test.ts.
 *
 * `.int()` is the fix for #228: both prompts already tell the model "score: 0 to 100" in plain
 * English (0002_prompt_seeds.sql, 0010_discovery_rank_per_posting.sql), so the gap was never the
 * wording, it was that `min(0).max(100)` alone accepts 0.82 exactly as well as 82 -- a model
 * defaulting to the more common 0-to-1 confidence convention passes validation and renders as a
 * confident, silently wrong answer. Nothing in either prompt asks for fractional precision, so
 * rejecting any non-integer here costs nothing and turns that specific mistake into a loud
 * schema failure the existing invalid_output retry path already handles. It does not resolve
 * every possible scale confusion (a model that happens to return a bare `1` is still
 * indistinguishable from a genuine 1%); that residual ambiguity is inherent to a unitless number
 * and not something this guard claims to close.
 */
const PercentScoreSchema = z.number().int().min(0).max(100);

export const MatchReportSchema = z.object({
  score: PercentScoreSchema,
  missingKeywords: z.array(z.string()),
  weakAreas: z.array(z.object({ area: z.string(), suggestion: z.string() })),
  summary: z.string(),
});

/** One posting scored against one role target (FR-D4). */
export const RankOutputSchema = z.object({
  score: PercentScoreSchema,
  rationale: z.string().max(1000),
  disqualifiers: z.array(z.string().max(200)).max(10),
});

export const RefineOutputSchema = z.object({
  proposedPrompt: z.string().min(1),
  changeSummary: z.string(),
});

/**
 * Stage 2's answer (spec D1): is this message part of a job search. `reason` exists so the
 * model has somewhere to put its thinking; it is read for debugging and never persisted on a
 * dropped row, because a dropped row keeps no content of any kind.
 */
export const TriageOutputSchema = z.object({
  jobRelated: z.boolean(),
  reason: z.string().max(200),
  confidence: z.number().min(0).max(1),
});
export type TriageOutput = z.infer<typeof TriageOutputSchema>;

export const ClassifyOutputSchema = z.object({
  classification: z.enum(COMM_CLASSIFICATIONS),
  outreachKind: z.enum(OUTREACH_KINDS).nullable(),
  mismatchReason: z.string().nullable(),
  opportunityMatch: z.object({ company: z.string(), title: z.string() }).nullable(),
  proposedTransition: z.enum(OPPORTUNITY_STAGES).nullable(),
  confidence: z.number().min(0).max(1),
  /**
   * Filled when the message itself states pay, location or an onsite/relocation requirement
   * that violates a role target; the server then refuses to auto-create an opportunity
   * whatever outreachKind says (defense against tie-break drift in the prompt).
   */
  hardConstraintViolation: z.string().nullable(),
});

export const DedupeOutputSchema = z.object({
  duplicateOfRef: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

/**
 * The deterministic candidate set ranked (FR-C3): contactId must echo an id from the input; the
 * server drops any id it did not send.
 */
export const ReferralOutputSchema = z.object({
  ranked: z
    .array(
      z.object({ contactId: z.string(), rank: z.number().int(), rationale: z.string().max(300) }),
    )
    .max(20),
});

export const CaptureOutputSchema = z.object({
  companyName: z.string().nullable(),
  title: z.string().nullable(),
  location: z.string().nullable(),
  remote: z.enum(['remote', 'hybrid', 'onsite']).nullable(),
  compNote: z.string().nullable(),
  descriptionMd: z.string().nullable(),
  postingUrl: z.string().nullable(),
});

/**
 * A LinkedIn page the user captured with the extension (FR-C5), read as a profile or a job.
 * The server has already checked the page's shape; the model only refines the fields, and
 * 'other' tells the server to keep its deterministic reading.
 */
/**
 * Passages lifted verbatim out of the captured page that the ATS text does not cover (design
 * D6). The model selects; it never writes. Every passage is checked against the captured text
 * before it is stored, so a paraphrase is dropped rather than kept.
 */
export const PostingMergeOutputSchema = z.object({
  passages: z.array(z.string().max(2_000)).max(40),
});

export const LinkedInCaptureOutputSchema = z.object({
  kind: z.enum(['profile', 'job', 'other']),
  /** Profile: the person's name. */
  name: z.string().max(300).nullable(),
  /** Profile: the headline under the name. */
  headline: z.string().max(500).nullable(),
  /** Profile: the current employer. Job: the hiring company. */
  company: z.string().max(300).nullable(),
  /** Profile: the current position. Job: the job title. */
  title: z.string().max(300).nullable(),
  location: z.string().max(300).nullable(),
  /** Job: the compensation text as stated. */
  compNote: z.string().max(500).nullable(),
  /** Job: the description as Markdown. */
  descriptionMd: z.string().max(50_000).nullable(),
});

/** Companies worth following (FR-D8); capped so one run cannot flood the queue. */
export const SuggestOutputSchema = z.object({
  suggestions: z
    .array(
      z.object({
        name: z.string().max(200),
        rationale: z.string().max(500),
        domainGuess: z.string().max(200).nullable(),
      }),
    )
    .max(15),
});

/** A plain-language reading of a Google OAuth setup error and the concrete fix (rendered as text). */
export const DiagnoseOutputSchema = z.object({
  explanation: z.string().max(600),
  fix: z.string().max(600),
});

// ---------------------------------------------------------------------------

function def<I, O>(
  key: TaskKey,
  description: string,
  inputSchema: z.ZodType<I>,
  outputSchema: z.ZodType<O>,
): TaskDef<I, O> {
  return {
    key,
    description,
    // eslint-disable-next-line security/detect-object-injection -- key is a TaskKey literal
    defaultPolicy: { ...DEFAULT_POLICIES[key] },
    inputSchema,
    outputSchema,
    defaultPromptName: DEFAULT_PROMPT_NAME,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
export const TASKS: Record<TaskKey, TaskDef<any, any>> = {
  'resume.tailor': def(
    'resume.tailor',
    'Iterative resume tailoring chat: proposes find/replace edits to the base resume for a job.',
    TailorInput,
    TailorOutputSchema,
  ),
  'resume.match': def(
    'resume.match',
    'Scores how well a resume matches a job description and lists gaps.',
    MatchInput,
    MatchReportSchema,
  ),
  'discovery.rank': def(
    'discovery.rank',
    'Scores one discovered job posting against one role target, with disqualifiers.',
    RankInput,
    RankOutputSchema,
  ),
  'discovery.refine_prompt': def(
    'discovery.refine_prompt',
    'Proposes an improved classification or ranking prompt from user feedback (never auto-applied).',
    RefineInput,
    RefineOutputSchema,
  ),
  'comms.triage': def(
    'comms.triage',
    'Decides whether one message is part of the job search, from its sender, subject and first 500 characters.',
    TriageInput,
    TriageOutputSchema,
  ),
  'comms.classify': def(
    'comms.classify',
    'Classifies a message, filters recruiter outreach (targeted, broadcast, irrelevant), links it.',
    ClassifyInput,
    ClassifyOutputSchema,
  ),
  'opportunity.dedupe': def(
    'opportunity.dedupe',
    'Decides whether a new opportunity duplicates one already tracked.',
    DedupeInput,
    DedupeOutputSchema,
  ),
  'referral.rationale': def(
    'referral.rationale',
    'Ranks the contacts who could refer the user for an opportunity, with a rationale each.',
    ReferralInput,
    ReferralOutputSchema,
  ),
  'capture.extract': def(
    'capture.extract',
    'Extracts job posting fields from a captured web page.',
    CaptureInput,
    CaptureOutputSchema,
  ),
  'capture.linkedin': def(
    'capture.linkedin',
    'Reads a LinkedIn profile or job page the user captured with the browser extension.',
    LinkedInCaptureInput,
    LinkedInCaptureOutputSchema,
  ),
  'posting.merge': def(
    'posting.merge',
    'Selects the passages a captured page carries that the ATS posting does not cover.',
    PostingMergeInput,
    PostingMergeOutputSchema,
  ),
  'company.suggest': def(
    'company.suggest',
    'Suggests companies worth following, given the role targets and past decisions.',
    SuggestInput,
    SuggestOutputSchema,
  ),
  'integration.diagnose': def(
    'integration.diagnose',
    'Explains a Google OAuth client setup error the user pasted and proposes the concrete fix.',
    DiagnoseInput,
    DiagnoseOutputSchema,
  ),
};

/** The variable names each task's prompt template must use (and may use). */
export const TASK_PROMPT_VARS: Record<TaskKey, readonly string[]> = Object.fromEntries(
  Object.entries(TASKS).map(([key, t]) => [key, Object.keys((t.inputSchema as z.ZodObject).shape)]),
) as unknown as Record<TaskKey, readonly string[]>;

// ---------------------------------------------------------------------------
// Prompt rendering

const VAR_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const UNTRUSTED_SUFFIX = '_untrusted';

/**
 * Any tag named untrusted, whatever its whitespace, slashes or attributes (and even when
 * unterminated): `</untrusted foo>`, `</ untrusted>`, `< untrusted\t/>`, `<UNTRUSTED x="1">`.
 */
// Written without adjacent optional whitespace runs so matching stays linear on long input
// (tasks.test.ts times a 400k-character worst case).
// eslint-disable-next-line security/detect-unsafe-regex -- no ambiguous repetition, see above
const UNTRUSTED_TAG = /<\s*(?:\/\s*)?untrusted\b[^<>]*>?/gi;

/** Neutralizes wrapper tags inside untrusted text so it cannot close or reopen its fence. */
function fenceSafe(value: string): string {
  return value.replace(UNTRUSTED_TAG, (tag) => `&lt;${tag.slice(1).replace(/>$/, '&gt;')}`);
}

/** Unique {{variable}} names in a template, in first-use order. */
export function promptVariables(template: string): string[] {
  const seen = new Set<string>();
  for (const m of template.matchAll(VAR_PATTERN)) seen.add(m[1] as string);
  return [...seen];
}

/**
 * Substitutes {{var}} placeholders in one pass (substituted text is never re-scanned).
 * Throws on a variable with no value. Variables named *_untrusted are wrapped in
 * <untrusted>...</untrusted>, with any wrapper tags inside the value neutralized.
 */
export function renderPrompt(template: string, vars: Record<string, string>): string {
  const values = new Map(Object.entries(vars));
  const missing = promptVariables(template).filter((name) => !values.has(name));
  if (missing.length > 0) {
    throw new Error(`renderPrompt: missing variable(s): ${missing.join(', ')}`);
  }
  return template.replace(VAR_PATTERN, (_match, name: string) => {
    const value = values.get(name) as string;
    return name.endsWith(UNTRUSTED_SUFFIX)
      ? `<untrusted>\n${fenceSafe(value)}\n</untrusted>`
      : value;
  });
}
