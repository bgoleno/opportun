// Mail filter routes (spec D7): the user's allow/deny rules, the watched label, the
// consumer-domain veto toggle, and the pattern tester.
//
// The tester is what makes the lists usable. A shorthand like `*.gmail.com` means "subdomains
// of gmail.com", which matches nothing, and without a live match count a rule like that sits
// in the list doing nothing forever. Counting against the user's real senders turns a silent
// footgun into an obvious one, and the suggestion is offered, never applied: these rules decide
// what Opportun may look at, and quietly broadening one is the surprise the page exists to
// prevent.
import {
  JOB_SENDER_SEEDS,
  matchesMailPattern,
  parseMailPattern,
  suggestMailPattern,
} from '@opportun/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { MAIL_LABEL_SETTING } from '../adapters/gmail';
import { invalidateTriageContext } from '../jobs/mailIngest';
import { senderAddress } from '../adapters/sources/alertEmail';
import { communications } from '../db/schema';
import { MAIL_FILTER_EFFECTS } from '../db/schema.shared';
import { HttpError } from '../lib/errors';
import type { Db } from '../db/client';
import type { UserCtx } from '../repos/base';
import {
  createRule,
  deleteRule,
  listRules,
  readConsumerVeto,
  updateRule,
  writeConsumerVeto,
} from '../repos/mailFilters';
import { readUserSetting, writeUserSetting } from '../repos/userSettings';

/** At most this many example senders come back with a tester result. */
const SAMPLE_LIMIT = 5;

const RuleView = z.object({
  id: z.string(),
  pattern: z.string(),
  effect: z.enum(MAIL_FILTER_EFFECTS),
  enabled: z.boolean(),
  source: z.string(),
  note: z.string().nullable(),
  createdAt: z.number(),
});

const CreateBody = z.object({
  pattern: z.string().min(1).max(320),
  effect: z.enum(MAIL_FILTER_EFFECTS),
  note: z.string().max(300).nullish(),
});

const PatchBody = z.object({
  enabled: z.boolean().optional(),
  note: z.string().max(300).nullish(),
});

const LabelBody = z.object({ label: z.string().max(200).nullable() });

const TestBody = z.object({ pattern: z.string().min(1).max(320) });
const TestResult = z.object({
  valid: z.boolean(),
  matchCount: z.number(),
  sampleDomains: z.array(z.string()),
  suggestions: z.array(z.object({ pattern: z.string(), matchCount: z.number() })),
});

/** A label Gmail can be asked for: see buildGmailQuery, which has no escape for a quote. */
const labelIsSafe = (label: string): boolean =>
  label.trim().length > 0 && label.length <= 200 && !/["\\\n\r]/.test(label);

/** Every distinct envelope address in the caller's stored mail. */
async function knownSenders(db: Db, ctx: UserCtx): Promise<string[]> {
  const rows = await db
    .selectDistinct({ from: communications.from })
    .from(communications)
    .where(eq(communications.userId, ctx.userId))
    .all();
  return rows.map((r) => senderAddress(r.from)).filter((a) => a.length > 0);
}

function countMatches(pattern: string, senders: string[]): { count: number; domains: string[] } {
  const parsed = parseMailPattern(pattern);
  if (parsed === null) return { count: 0, domains: [] };
  const domains = new Set<string>();
  let count = 0;
  for (const address of senders) {
    if (!matchesMailPattern(address, parsed)) continue;
    count += 1;
    if (domains.size < SAMPLE_LIMIT) domains.add(address.slice(address.indexOf('@') + 1));
  }
  return { count, domains: [...domains] };
}

const JobSenderView = z.object({
  pattern: z.string(),
  /** The platform a built-in belongs to, and empty for one the user added themselves. */
  platform: z.string(),
  /** What it sends, so a built-in can be judged rather than trusted. Empty for the user's own. */
  sends: z.string(),
  builtIn: z.boolean(),
  enabled: z.boolean(),
  /** How many senders in the caller's stored mail this pattern matches. */
  matchCount: z.number(),
  /** The rule behind the row: the user's own rule, or the disabled rule muting a built-in. */
  ruleId: z.string().nullable(),
});

const JobSenderBody = z.object({
  pattern: z.string().min(1).max(320),
  enabled: z.boolean(),
});

export async function mailFilterRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  api.get(
    '/mail-filters',
    {
      schema: {
        response: {
          200: z.object({
            rules: z.array(RuleView),
            label: z.string().nullable(),
            consumerVeto: z.boolean(),
          }),
        },
      },
    },
    async (req) => {
      const ctx = app.requireUser(req);
      const label = await readUserSetting(db, ctx, MAIL_LABEL_SETTING, z.string(), '');
      return {
        rules: await listRules(db, ctx),
        label: label.length === 0 ? null : label,
        consumerVeto: await readConsumerVeto(db, ctx),
      };
    },
  );

  api.post(
    '/mail-filters',
    { schema: { body: CreateBody, response: { 201: RuleView } } },
    async (req, reply) => {
      const ctx = app.requireUser(req);
      const rule = await createRule(db, ctx, {
        pattern: req.body.pattern,
        effect: req.body.effect,
        note: req.body.note ?? null,
      });
      invalidateTriageContext(ctx.userId);
      return await reply.code(201).send(rule);
    },
  );

  api.patch(
    '/mail-filters/:id',
    {
      schema: {
        params: z.object({ id: z.string().min(1).max(64) }),
        body: PatchBody,
        response: { 200: RuleView },
      },
    },
    async (req) => {
      const ctx = app.requireUser(req);
      const updated = await updateRule(db, ctx, req.params.id, req.body);
      invalidateTriageContext(ctx.userId);
      return updated;
    },
  );

  api.delete(
    '/mail-filters/:id',
    { schema: { params: z.object({ id: z.string().min(1).max(64) }) } },
    async (req, reply) => {
      const ctx = app.requireUser(req);
      await deleteRule(db, ctx, req.params.id);
      invalidateTriageContext(ctx.userId);
      return await reply.code(204).send();
    },
  );

  api.put(
    '/mail-filters/label',
    { schema: { body: LabelBody, response: { 200: LabelBody } } },
    async (req) => {
      const ctx = app.requireUser(req);
      const label = req.body.label;
      if (label !== null && !labelIsSafe(label)) {
        throw new HttpError(400, 'invalid_label', 'That label cannot be used in a Gmail query');
      }
      await writeUserSetting(db, ctx, MAIL_LABEL_SETTING, label ?? '');
      return { label };
    },
  );

  api.put(
    '/mail-filters/consumer-veto',
    {
      schema: {
        body: z.object({ enabled: z.boolean() }),
        response: { 200: z.object({ enabled: z.boolean() }) },
      },
    },
    async (req) => {
      const ctx = app.requireUser(req);
      await writeConsumerVeto(db, ctx, req.body.enabled);
      invalidateTriageContext(ctx.userId);
      return { enabled: req.body.enabled };
    },
  );

  // Rule 4's pass list (D7 item 4). The built-ins live in code (decision D-3), so this merges
  // them with the user's own `job_sender` rules and counts every row against their real senders.
  // A built-in the user switched off is shown as one row, not as a built-in plus a mystery rule.
  api.get(
    '/mail-filters/job-senders',
    { schema: { response: { 200: z.object({ senders: z.array(JobSenderView) }) } } },
    async (req) => {
      const ctx = app.requireUser(req);
      const rules = (await listRules(db, ctx)).filter((r) => r.effect === 'job_sender');
      const senders = await knownSenders(db, ctx);
      const byPattern = new Map(rules.map((r) => [r.pattern, r]));
      const builtIn = JOB_SENDER_SEEDS.map((seed) => {
        const rule = byPattern.get(seed.pattern);
        return {
          pattern: seed.pattern,
          platform: seed.platform,
          sends: seed.sends,
          builtIn: true,
          // A rule naming a built-in only ever mutes it: an enabled one says the same thing the
          // built-in already says.
          enabled: rule?.enabled ?? true,
          matchCount: countMatches(seed.pattern, senders).count,
          ruleId: rule?.id ?? null,
        };
      });
      const own = rules
        .filter((r) => !JOB_SENDER_SEEDS.some((seed) => seed.pattern === r.pattern))
        .map((r) => ({
          pattern: r.pattern,
          platform: '',
          sends: r.note ?? '',
          builtIn: false,
          enabled: r.enabled,
          matchCount: countMatches(r.pattern, senders).count,
          ruleId: r.id,
        }));
      return { senders: [...builtIn, ...own] };
    },
  );

  // Switching a built-in off and on, idempotent in both directions. Off is a disabled rule
  // naming the same pattern; on removes it, so the sender goes back to following the shipped
  // list rather than freezing today's copy of it. Only a built-in can be addressed here: the
  // user's own job senders are ordinary rules, created and deleted like any other.
  api.put(
    '/mail-filters/job-senders',
    { schema: { body: JobSenderBody, response: { 200: z.object({ enabled: z.boolean() }) } } },
    async (req) => {
      const ctx = app.requireUser(req);
      const pattern = req.body.pattern.trim().toLowerCase();
      if (!JOB_SENDER_SEEDS.some((seed) => seed.pattern === pattern)) {
        throw new HttpError(404, 'not_found', `Not a built-in job sender: ${pattern}`);
      }
      const existing = (await listRules(db, ctx)).find(
        (r) => r.effect === 'job_sender' && r.pattern === pattern,
      );
      if (req.body.enabled) {
        if (existing !== undefined) await deleteRule(db, ctx, existing.id);
      } else if (existing === undefined) {
        await createRule(db, ctx, { pattern, effect: 'job_sender', enabled: false });
      } else if (existing.enabled) {
        await updateRule(db, ctx, existing.id, { enabled: false });
      }
      invalidateTriageContext(ctx.userId);
      return { enabled: req.body.enabled };
    },
  );

  // An unparseable pattern is a 200 with valid:false, not an error: the tester is a tool the
  // user types into, and a red request in the console is not what "that is not a pattern" means.
  api.post(
    '/mail-filters/test',
    { schema: { body: TestBody, response: { 200: TestResult } } },
    async (req) => {
      const ctx = app.requireUser(req);
      const pattern = req.body.pattern;
      if (parseMailPattern(pattern) === null) {
        return { valid: false, matchCount: 0, sampleDomains: [], suggestions: [] };
      }
      const senders = await knownSenders(db, ctx);
      const self = countMatches(pattern, senders);
      // Only offer a correction when the original finds nothing and the candidate finds
      // something: a suggestion that also matches nothing is noise.
      const suggestions =
        self.count > 0
          ? []
          : suggestMailPattern(pattern)
              .map((candidate) => ({
                pattern: candidate,
                matchCount: countMatches(candidate, senders).count,
              }))
              .filter((s) => s.matchCount > 0);
      return {
        valid: true,
        matchCount: self.count,
        sampleDomains: self.domains,
        suggestions,
      };
    },
  );
}
