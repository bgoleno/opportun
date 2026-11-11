// The observability settings (design.md 14.1, 14.10; https://github.com/bgoleno/opportun/issues/353
// and https://github.com/bgoleno/opportun/issues/342).
//
// Collect (the base): any signed-in user can see whether collection is on, and only an admin can
// change it, audited. Collect needs no re-confirmation: what it turns on stays in this instance's
// own database and holds no content (14.7, 14.8).
//
// Export (FR-T2), on its own path so the Collect response keeps its shape:
// - GET /obs/export: every signed-in user sees whether export is on, its type and its signals,
//   never where to (14.10: export covers every user's telemetry); an admin also sees the
//   destination's fields, whether a credential is stored (never the credential itself), the last
//   success, the last failure as a class, and the drop counts.
// - PUT /obs/export: an admin only, with the password confirmed again as for
//   PATCH /admin/registration (rule 1); refused on the demo to every caller (rule 6); on only while
//   Collect is (14.1); the destination checked against the rule before it is stored (rules 2, 3);
//   audited with the type and signals, never the host or the credential; applied at once.
// - POST /obs/export/test: one request to the stored destination, its outcome class only,
//   under the same re-confirmation and so the same rate limit (rule 7).
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../lib/audit';
import { HttpError } from '../lib/errors';
import { confirmPassword, reauthLimits } from '../lib/reauth';
import { encryptSecret } from '../lib/secretBox';
import { collectInEffect, writeCollect } from '../obs/config';
import { readDropCounts } from '../obs/export/drops';
import {
  checkDestination,
  EXPORT_TYPES,
  parseDestination,
  TYPE_SIGNALS,
} from '../obs/export/destination';
import { applyExport, exportStatus, sendTest } from '../obs/export/manager';
import { nextExport, readExport, writeExport, type StoredExport } from '../obs/export/settings';

const ObsSettings = z.object({ collect: z.boolean() });

const SignalName = z.enum(['metrics', 'spans', 'logs']);
const DestinationView = z.object({
  type: z.enum(EXPORT_TYPES),
  scheme: z.enum(['http', 'https']),
  host: z.string(),
  port: z.number(),
  basePath: z.string().optional(),
  org: z.string().optional(),
  bucket: z.string().optional(),
  headerName: z.string().optional(),
});
const ExportView = z.object({
  enabled: z.boolean(),
  type: z.enum(EXPORT_TYPES).nullable(),
  signals: z.array(SignalName),
  admin: z
    .object({
      destination: DestinationView.nullable(),
      hasCredential: z.boolean(),
      allowPrivate: z.boolean(),
      lastSuccessAt: z.number().nullable(),
      lastFailure: z.object({ outcome: z.string(), at: z.number() }).nullable(),
      dropped: z.array(z.object({ signal: z.string(), reason: z.string(), count: z.number() })),
    })
    .optional(),
});
// The destination is checked by parseDestination, so a malformed one is answered by field (422)
// rather than as a generic schema failure.
const ExportChangeBody = z.object({
  password: z.string().min(1).max(1024),
  enabled: z.boolean(),
  destination: z.unknown().optional(),
  credential: z.string().max(8192).nullable().optional(),
});
const PasswordBody = z.object({ password: z.string().min(1).max(1024) });
const TestResult = z.object({ outcome: z.string() });

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

  /** What a user, or an admin, sees of export. */
  async function exportView(isAdmin: boolean): Promise<z.infer<typeof ExportView>> {
    const stored = await readExport(db);
    const on =
      stored.enabled && stored.destination !== null && (await collectInEffect(db, app.config));
    const type = on && stored.destination !== null ? stored.destination.type : null;
    const view: z.infer<typeof ExportView> = {
      enabled: on,
      type,
      signals: type === null ? [] : [...TYPE_SIGNALS[type]],
    };
    if (!isAdmin) return view;
    const status = exportStatus();
    return {
      ...view,
      admin: {
        destination: stored.destination,
        hasCredential: stored.sealedCredential !== null,
        allowPrivate: app.config.telemetryAllowPrivate,
        lastSuccessAt: status.lastSuccessAt,
        lastFailure: status.lastFailure,
        dropped: await readDropCounts(db, Date.now()),
      },
    };
  }

  api.get('/obs/export', { schema: { response: { 200: ExportView } } }, async (req) => {
    const ctx = app.requireUser(req);
    return await exportView(ctx.isAdmin);
  });

  api.put(
    '/obs/export',
    {
      preHandler: reauthLimits(db),
      schema: { body: ExportChangeBody, response: { 200: ExportView } },
    },
    async (req, reply) => {
      const ctx = app.requireUser(req);
      if (app.config.demo) throw new HttpError(403, 'unavailable_on_demo');
      if (!ctx.isAdmin) throw new HttpError(403, 'forbidden');
      const confirmed = await confirmPassword(req, reply, {
        userId: ctx.userId,
        password: req.body.password,
        action: 'telemetry.export',
      });
      if (!confirmed) return reply;
      let destination;
      if (req.body.destination !== undefined) {
        const parsed = parseDestination(req.body.destination);
        if (!parsed.ok) {
          throw new HttpError(422, 'invalid_destination', undefined, { field: parsed.field });
        }
        destination = parsed.value;
      }
      const prev = await readExport(db);
      const next = nextExport(
        prev,
        {
          enabled: req.body.enabled,
          ...(destination === undefined ? {} : { destination }),
          ...(req.body.credential === undefined ? {} : { credential: req.body.credential }),
        },
        (plaintext) => encryptSecret(db, plaintext),
      );
      if (!next.ok) throw new HttpError(422, next.error);
      if (next.value.enabled) {
        if (!(await collectInEffect(db, app.config))) throw new HttpError(409, 'collect_off');
        await assertDestination(next.value);
      }
      await writeExport(db, next.value);
      const type = next.value.destination?.type ?? null;
      // The type and the signals, never the host or the credential (rule 1).
      await audit(db, 'telemetry.export.updated', {
        userId: ctx.userId,
        ip: req.ip,
        detail: {
          enabled: next.value.enabled,
          type,
          signals: type === null ? [] : [...TYPE_SIGNALS[type]],
        },
      });
      await applyExport(db, app.config);
      return await exportView(true);
    },
  );

  /** The destination rule at save time; every batch is checked again when it is sent. */
  async function assertDestination(stored: StoredExport): Promise<void> {
    if (stored.destination === null) return;
    const check = await checkDestination(stored.destination, {
      allowPrivate: app.config.telemetryAllowPrivate,
    });
    if (!check.ok) {
      throw new HttpError(422, 'destination_refused', undefined, { reason: check.reason });
    }
  }

  api.post(
    '/obs/export/test',
    {
      preHandler: reauthLimits(db),
      schema: { body: PasswordBody, response: { 200: TestResult } },
    },
    async (req, reply) => {
      const ctx = app.requireUser(req);
      if (app.config.demo) throw new HttpError(403, 'unavailable_on_demo');
      if (!ctx.isAdmin) throw new HttpError(403, 'forbidden');
      const confirmed = await confirmPassword(req, reply, {
        userId: ctx.userId,
        password: req.body.password,
        action: 'telemetry.export_test',
      });
      if (!confirmed) return reply;
      return { outcome: await sendTest(db, app.config) };
    },
  );
}
