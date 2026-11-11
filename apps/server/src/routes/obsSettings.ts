// The observability settings (design.md 14.1; https://github.com/bgoleno/opportun/issues/353).
// The base holds the Collect switch only: any signed-in user can see whether collection is on,
// and only an admin can change it, audited. Collection is off unless an admin turns it on.
//
// Export (FR-T2) extends this file: its switch, destination and credential, the password
// re-confirmation it needs, and the Settings card. Collect needs no re-confirmation: what it
// turns on stays in this instance's own database and holds no content (14.7, 14.8).
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { HttpError } from '../lib/errors';
import { collectInEffect, writeCollect } from '../obs/config';

const ObsSettings = z.object({ collect: z.boolean() });

export async function obsSettingsRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  api.get('/obs/settings', { schema: { response: { 200: ObsSettings } } }, async (req) => {
    app.requireUser(req);
    return { collect: await collectInEffect(db, app.config) };
  });

  api.put(
    '/obs/settings',
    { schema: { body: ObsSettings, response: { 200: ObsSettings } } },
    async (req) => {
      const ctx = app.requireUser(req);
      // The demo deployment's admin account is public, so any visitor could turn collection on
      // (sec's O2 on #359; design 14.1). Refused before the admin check, so every caller gets
      // the same answer there, and for false as well as true: the switch is never on there.
      // The code is shared with export, which 14.10 rule 6 refuses on the demo too.
      if (app.config.demo) throw new HttpError(403, 'unavailable_on_demo');
      if (!ctx.isAdmin) throw new HttpError(403, 'forbidden');
      await writeCollect(db, req.body.collect, { userId: ctx.userId, ip: req.ip });
      return { collect: await collectInEffect(db, app.config) };
    },
  );
}
