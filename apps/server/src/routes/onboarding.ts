// First-run tour and setup checklist state (FR-U11, FR-U12). One GET drives the tour, the
// dashboard checklist and the auto-start trigger; the checklist items are computed here from
// the same sources the status cards use, never inferred on the client (design principle 6).
import {
  ChecklistSchema,
  OnboardingSchema,
  TOUR_STATUSES,
  TOUR_STEP_IDS,
  TOUR_VERSION,
  TourStateSchema,
  type Checklist,
  type TourState,
} from '@opportun/core';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../db/client';
import { opportunities, secrets } from '../db/schema';
import { readKeyValidation } from '../lib/aiKeyValidate';
import { appleMailState, gmailGranted } from '../lib/mailStatus';
import { sessionCreatedAt } from '../lib/sessions';
import type { UserCtx } from '../repos/base';
import {
  readUserSetting,
  userSettingUpdatedAt,
  writeUserSetting,
  writeUserSettingOnce,
} from '../repos/userSettings';

export const TOUR_SETTING = 'onboarding_tour';
export const CHECKLIST_SETTING = 'onboarding_checklist';
/**
 * The first time all three checklist items were true. Its own row rather than a field of
 * onboarding_checklist so it can be written strictly once (insert-or-nothing): the GET that
 * records it is refetched on every window focus, and a read-modify-write would let two
 * concurrent GETs stamp it twice. Activation is a historical fact: it is never cleared.
 */
export const ACTIVATED_SETTING = 'onboarding_activated_at';

const DEFAULT_TOUR: TourState = {
  version: TOUR_VERSION,
  status: 'not_started',
  stepId: null,
  startedAt: null,
  finishedAt: null,
};
const StoredChecklist = z.object({ dismissed: z.boolean() });

/** `not_started` is the absence of a row, never something a client writes. */
const TourBody = z
  .object({
    status: z.enum(TOUR_STATUSES).exclude(['not_started']),
    stepId: z.enum(TOUR_STEP_IDS),
  })
  .strict();
/** Dismissal is one-way: the card has no "show again" control to back a false. */
const ChecklistBody = z.object({ dismissed: z.literal(true) }).strict();

async function hasAiKey(db: Db, ctx: UserCtx): Promise<{ any: boolean; valid: boolean }> {
  const keys = await db
    .select({ id: secrets.id })
    .from(secrets)
    .where(and(eq(secrets.userId, ctx.userId), eq(secrets.kind, 'ai_api_key')))
    .all();
  for (const k of keys) {
    // ok is "the key authenticated": Valid and every amber state, not Invalid or Not checked
    // (components/ai/keyStatus.ts draws the same line).
    if ((await readKeyValidation(db, ctx, k.id))?.ok === true) return { any: true, valid: true };
  }
  return { any: keys.length > 0, valid: false };
}

async function hasOpportunity(db: Db, ctx: UserCtx): Promise<boolean> {
  const row = await db
    .select({ id: opportunities.id })
    .from(opportunities)
    .where(eq(opportunities.userId, ctx.userId))
    .limit(1)
    .get();
  return row !== undefined;
}

async function mailConnected(db: Db, ctx: UserCtx): Promise<boolean> {
  return (await gmailGranted(db, ctx)) || (await appleMailState(db, ctx)).connected;
}

export async function onboardingRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  const readTour = (ctx: UserCtx) =>
    readUserSetting(db, ctx, TOUR_SETTING, TourStateSchema, DEFAULT_TOUR);

  async function checklist(ctx: UserCtx) {
    const key = await hasAiKey(db, ctx);
    const mail = await mailConnected(db, ctx);
    const firstOpportunity = await hasOpportunity(db, ctx);
    if (key.valid && mail && firstOpportunity) {
      await writeUserSettingOnce(db, ctx, ACTIVATED_SETTING, Date.now());
    }
    const activatedAt = await readUserSetting<number | null>(
      db,
      ctx,
      ACTIVATED_SETTING,
      z.number().int(),
      null,
    );
    const stored = await readUserSetting(db, ctx, CHECKLIST_SETTING, StoredChecklist, {
      dismissed: false,
    });
    const items: Checklist = {
      aiKey: key.valid,
      mail,
      firstOpportunity,
      dismissed: stored.dismissed,
      activatedAt,
    };
    return { items, anyKey: key.any };
  }

  /**
   * Real instance: only a brand-new account (no tour row, no opportunity, no AI key at all)
   * gets the modal, so accounts already using the product when this ships do not.
   * Demo instance: every sign-in gets it, until the tour is touched in this session. "This
   * session" is the tour row's last write against the session's creation time, so nothing
   * session-specific is stored and the next sign-in (a fresh visitor) sees it again.
   */
  async function autoStart(req: FastifyRequest, ctx: UserCtx, anyKey: boolean, hasOpp: boolean) {
    const touchedAt = await userSettingUpdatedAt(db, ctx, TOUR_SETTING);
    if (app.config.demo) {
      if (touchedAt === null) return true;
      const signedInAt = await sessionCreatedAt(db, ctx, req.cookies.opportun_session ?? '');
      return signedInAt === null || touchedAt < signedInAt;
    }
    return touchedAt === null && !anyKey && !hasOpp;
  }

  api.get('/onboarding', { schema: { response: { 200: OnboardingSchema } } }, async (req) => {
    const ctx = app.requireUser(req);
    const { items, anyKey } = await checklist(ctx);
    return {
      tour: await readTour(ctx),
      checklist: items,
      autoStart: await autoStart(req, ctx, anyKey, items.firstOpportunity),
      demo: app.config.demo,
    };
  });

  api.put(
    '/onboarding/tour',
    { schema: { body: TourBody, response: { 200: TourStateSchema } } },
    async (req) => {
      const ctx = app.requireUser(req);
      const prev = await readTour(ctx);
      const now = Date.now();
      const { status, stepId } = req.body;
      // Resuming a paused run continues it; starting from anything else is a new run.
      const newRun =
        status === 'in_progress' && prev.status !== 'in_progress' && prev.status !== 'paused';
      const startedAt = newRun ? now : (prev.startedAt ?? now);
      const finishedAt =
        status === 'completed' || status === 'skipped' ? now : newRun ? null : prev.finishedAt;
      const next: TourState = { version: TOUR_VERSION, status, stepId, startedAt, finishedAt };
      await writeUserSetting(db, ctx, TOUR_SETTING, next);
      return next;
    },
  );

  api.patch(
    '/onboarding/checklist',
    { schema: { body: ChecklistBody, response: { 200: ChecklistSchema } } },
    async (req) => {
      const ctx = app.requireUser(req);
      await writeUserSetting(db, ctx, CHECKLIST_SETTING, { dismissed: true });
      return (await checklist(ctx)).items;
    },
  );
}
