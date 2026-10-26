// Per-user settings. The settings table has a single-column key, so a per-user value is
// stored under a namespaced key (`theme:<userId>`) with user_id set for cascade deletes.
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  alertSenders,
  ALERT_SENDERS_SETTING,
  DEFAULT_ALERT_SENDERS,
  SendersSchema,
} from '../adapters/sources/alertEmail';
import { settings } from '../db/schema';
import { CronSchema, discoveryDefaultCron, setDiscoveryDefaultCron } from '../jobs/atsDetect';
import type { UserCtx } from '../repos/base';
import { deleteUserSetting, userSettingExists, writeUserSetting } from '../repos/userSettings';

export const THEME_PREFS = ['light', 'dark', 'auto'] as const;
const ThemeBody = z.object({ pref: z.enum(THEME_PREFS) });

const themeKey = (userId: string): string => `theme:${userId}`;

/** The cron new and followed company sources poll on (FR-D5). */
const DiscoveryBody = z.object({ cron: CronSchema });

/**
 * `senders: null` resets to the defaults by removing the override, rather than writing a copy of
 * today's defaults: a user who never configured this should keep tracking the defaults if they
 * change later, same as a user who explicitly asked to go back to them.
 */
const AlertSendersPatchBody = z.object({ senders: SendersSchema.nullable() });
/**
 * `usingDefaults` is principle 6 for this setting: `senders` alone cannot tell a caller "you
 * have not configured this" from "you configured it to the same addresses, or to none at all" —
 * an explicit empty list is a real, different state (no digest sender matches anything).
 */
const AlertSendersResponse = z.object({
  senders: z.array(z.string()),
  usingDefaults: z.boolean(),
  defaults: z.array(z.string()),
});

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  api.get('/settings/theme', { schema: { response: { 200: ThemeBody } } }, async (req) => {
    const ctx = app.requireUser(req);
    const row = await db
      .select({ value: settings.value })
      .from(settings)
      .where(and(eq(settings.key, themeKey(ctx.userId)), eq(settings.userId, ctx.userId)))
      .get();
    const parsed = ThemeBody.shape.pref.safeParse(row?.value);
    return { pref: parsed.success ? parsed.data : 'auto' };
  });

  api.patch(
    '/settings/theme',
    { schema: { body: ThemeBody, response: { 200: ThemeBody } } },
    async (req) => {
      const ctx = app.requireUser(req);
      const { pref } = req.body;
      const now = Date.now();
      await db
        .insert(settings)
        .values({ key: themeKey(ctx.userId), userId: ctx.userId, value: pref, updatedAt: now })
        .onConflictDoUpdate({ target: settings.key, set: { value: pref, updatedAt: now } })
        .run();
      return { pref };
    },
  );

  api.get('/settings/discovery', { schema: { response: { 200: DiscoveryBody } } }, async (req) => {
    const ctx = app.requireUser(req);
    return { cron: await discoveryDefaultCron(db, ctx) };
  });

  // Validated with cron-parser; company sources still on the old default move to the new one.
  api.patch(
    '/settings/discovery',
    { schema: { body: DiscoveryBody, response: { 200: DiscoveryBody } } },
    async (req) => {
      const ctx = app.requireUser(req);
      await setDiscoveryDefaultCron(db, ctx, req.body.cron);
      return { cron: req.body.cron };
    },
  );

  const alertSendersState = async (ctx: UserCtx) => ({
    senders: await alertSenders(db, ctx),
    usingDefaults: !(await userSettingExists(db, ctx, ALERT_SENDERS_SETTING)),
    defaults: [...DEFAULT_ALERT_SENDERS],
  });

  // Issue #15: the list has always existed (alertEmail.ts) but nothing could write it, so only
  // the default LinkedIn/Indeed addresses were ever in effect.
  api.get(
    '/settings/alert-senders',
    { schema: { response: { 200: AlertSendersResponse } } },
    async (req) => alertSendersState(app.requireUser(req)),
  );

  api.patch(
    '/settings/alert-senders',
    { schema: { body: AlertSendersPatchBody, response: { 200: AlertSendersResponse } } },
    async (req) => {
      const ctx = app.requireUser(req);
      if (req.body.senders === null) {
        await deleteUserSetting(db, ctx, ALERT_SENDERS_SETTING);
      } else {
        await writeUserSetting(db, ctx, ALERT_SENDERS_SETTING, req.body.senders);
      }
      return alertSendersState(ctx);
    },
  );
}
