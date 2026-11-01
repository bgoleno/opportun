// The Network section's contacts (FR-C1). The company is written by name and mapped to the caller's company
// (find-or-create); linkedinUrl is stored as metadata and never fetched (C-1).
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { REFERRAL_STATUSES } from '@opportun/core';
import { CONTACT_SOURCES } from '../db/schema';
import { listContactReferrals } from '../repos/activities';
import {
  CONTACT_SORTS,
  createContact,
  deleteContact,
  getContactSync,
  listContacts,
  updateContact,
} from '../repos/contacts';
import { HttpUrl, IdParams, listQuery, optionalText, pageOf } from './common';

const HistoryEntry = z.object({
  company: z.string().trim().min(1).max(200),
  title: optionalText(300),
  from: optionalText(40),
  to: optionalText(40),
});

export const ContactSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  emails: z.array(z.string()),
  linkedinUrl: z.string().nullable(),
  currentCompanyId: z.string().nullable(),
  currentCompanyName: z.string().nullable(),
  history: z.array(
    z.object({
      company: z.string(),
      title: z.string().nullable(),
      from: z.string().nullable(),
      to: z.string().nullable(),
    }),
  ),
  strength: z.number().int().nullable(),
  notes: z.string().nullable(),
  source: z.enum(CONTACT_SOURCES),
  tags: z.array(z.string()),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

/** One referral ask for a contact (Task 22), newest first. */
export const ContactReferralSchema = z.object({
  activityId: z.string(),
  opportunityId: z.string(),
  opportunityTitle: z.string(),
  companyName: z.string(),
  status: z.enum(REFERRAL_STATUSES).nullable(),
  occurredAt: z.number().int(),
});
const ContactDetailSchema = ContactSchema.extend({ referrals: z.array(ContactReferralSchema) });

const contactFields = {
  name: z.string().trim().min(1).max(200),
  emails: z.array(z.email().max(320)).max(20),
  linkedinUrl: HttpUrl.nullish(),
  /** The current company's name; null clears it. */
  company: optionalText(200),
  history: z.array(HistoryEntry).max(50),
  strength: z.number().int().min(1).max(3).nullish(),
  notes: optionalText(20_000),
  source: z.enum(CONTACT_SOURCES),
  tags: z.array(z.string().trim().min(1).max(50)).max(30),
};
const ContactCreate = z.object(contactFields).partial().required({ name: true });
const ContactPatch = z.object(contactFields).partial();
const ContactQuery = listQuery([...CONTACT_SORTS.keys()]).extend({
  q: z.string().trim().min(1).max(200).optional(),
  companyId: z.string().min(1).max(64).optional(),
});

/** Optional nullable fields arrive as null-or-undefined; null means "clear". */
function normalizeHistory(
  h: z.infer<typeof HistoryEntry>[] | undefined,
): { company: string; title: string | null; from: string | null; to: string | null }[] | undefined {
  return h?.map((e) => ({
    company: e.company,
    title: e.title ?? null,
    from: e.from ?? null,
    to: e.to ?? null,
  }));
}

/**
 * Where the section's API is served. `/network` is its name; `/contacts` is an alias (issue
 * https://github.com/bgoleno/opportun/issues/22): the section was called Contacts and served
 * there until it was renamed Network, so a script written against the old path keeps working.
 * Both get the same handlers, schemas and auth, and test/network.test.ts checks they answer
 * alike. Nothing in this repository calls the alias: the web app uses /network, and the
 * browser extension's only call is POST /connector/capture. It can be removed once a release
 * note has announced that /api/v1/contacts stops working.
 */
export const NETWORK_BASES = ['/network', '/contacts'] as const;

export async function networkRoutes(app: FastifyInstance): Promise<void> {
  for (const base of NETWORK_BASES) contactRoutesAt(app, base);
}

/** The section's five routes under one base path. */
function contactRoutesAt(app: FastifyInstance, base: (typeof NETWORK_BASES)[number]): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  api.get(
    base,
    { schema: { querystring: ContactQuery, response: { 200: pageOf(ContactSchema) } } },
    async (req) => listContacts(db, app.requireUser(req), req.query),
  );

  api.post(
    base,
    { schema: { body: ContactCreate, response: { 201: ContactSchema } } },
    async (req, reply) => {
      const { history, ...rest } = req.body;
      const view = await createContact(db, app.requireUser(req), {
        ...rest,
        history: normalizeHistory(history),
      });
      return reply.code(201).send(view);
    },
  );

  api.get(
    `${base}/:id`,
    { schema: { params: IdParams, response: { 200: ContactDetailSchema } } },
    async (req) => {
      const ctx = app.requireUser(req);
      const contact = await getContactSync(db, ctx, req.params.id);
      return { ...contact, referrals: await listContactReferrals(db, ctx, contact.id) };
    },
  );

  api.patch(
    `${base}/:id`,
    { schema: { params: IdParams, body: ContactPatch, response: { 200: ContactSchema } } },
    async (req) => {
      const { history, ...rest } = req.body;
      return updateContact(db, app.requireUser(req), req.params.id, {
        ...rest,
        ...(history === undefined ? {} : { history: normalizeHistory(history) }),
      });
    },
  );

  api.delete(
    `${base}/:id`,
    { schema: { params: IdParams, response: { 204: z.null() } } },
    async (req, reply) => {
      await deleteContact(db, app.requireUser(req), req.params.id);
      return reply.code(204).send(null);
    },
  );
}
