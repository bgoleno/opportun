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
import { readBuildInfo } from '../lib/buildInfo';
import { CronSchema, discoveryDefaultCron, setDiscoveryDefaultCron } from '../jobs/atsDetect';
import { NETWORK_BOARD_CHECK_SETTING, readNetworkBoardCheck } from '../jobs/networkBoardProbe';
import type { UserCtx } from '../repos/base';
import { deleteUserSetting, userSettingExists, writeUserSetting } from '../repos/userSettings';
import { obs } from '../obs';

export const THEME_PREFS = ['light', 'dark', 'auto'] as const;
const ThemeBody = z.object({ pref: z.enum(THEME_PREFS) });

const themeKey = (userId: string): string => `theme:${userId}`;

/** The cron new and followed company sources poll on (FR-D5). */
const DiscoveryBody = z.object({ cron: CronSchema });
/** The nightly network probe's switch (#296). */
const NetworkBoardCheckBody = z.object({ enabled: z.boolean() }).strict();

/** The version and commit this server was built from (#480); both public, null when unknown. */
const BuildBody = z.object({ version: z.string().nullable(), commit: z.string().nullable() });

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

  // Any signed-in user: Settings shows it. Read from the build's environment, never fetched.
  api.get('/settings/build', { schema: { response: { 200: BuildBody } } }, async (req) => {
    app.requireUser(req);
    return readBuildInfo(process.env);
  });

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
      obs.event('settings.updated', { 'opportun.setting': 'theme' }, { userId: ctx.userId });
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

  // On unless the user turns it off (#296, the owner's rule): each night, up to 20 companies in
  // the user's network are looked up by name on Greenhouse, Lever and Ashby.
  api.get(
    '/settings/network-board-check',
    { schema: { response: { 200: NetworkBoardCheckBody } } },
    async (req) => {
      const ctx = app.requireUser(req);
      return { enabled: await readNetworkBoardCheck(db, ctx) };
    },
  );

  api.put(
    '/settings/network-board-check',
    { schema: { body: NetworkBoardCheckBody, response: { 200: NetworkBoardCheckBody } } },
    async (req) => {
      const ctx = app.requireUser(req);
      await writeUserSetting(db, ctx, NETWORK_BOARD_CHECK_SETTING, req.body.enabled);
      return { enabled: req.body.enabled };
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
