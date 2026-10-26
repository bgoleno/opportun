import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common';

export const COMM_CLASSIFICATIONS = [
  'solicitation',
  'scheduling',
  'follow_up',
  'rejection',
  'offer',
  'networking',
  'other',
] as const;
export type CommClassification = (typeof COMM_CLASSIFICATIONS)[number];

export const OUTREACH_KINDS = ['targeted', 'broadcast_spam', 'irrelevant'] as const;
export type OutreachKind = (typeof OUTREACH_KINDS)[number];

export const COMM_CHANNELS = ['gmail', 'apple_mail', 'linkedin'] as const;
export type CommChannel = (typeof COMM_CHANNELS)[number];

/**
 * What the classifier actually read, in order of how much it was worth (issue #149):
 * `payload` and `stored` are the full message, `refetched` is the full message read again
 * from the provider, `snippet` means none of those panned out and classification ran on the
 * ~200-character preview alone. Null for a message never classified at all, and for one
 * classified before this column existed.
 */
export const BODY_SOURCES = ['payload', 'stored', 'refetched', 'snippet'] as const;
export type BodySource = (typeof BODY_SOURCES)[number];

/** An ingested copy of a message; the user's mailbox is never modified (FR-M8). */
export const CommunicationSchema = z.object({
  id: IdSchema,
  userId: IdSchema,
  channel: z.enum(COMM_CHANNELS),
  /** Unique per channel, for idempotent sync. */
  externalId: z.string().min(1),
  threadKey: z.string().nullish(),
  from: z.string().min(1),
  to: z.array(z.string()).default([]),
  subject: z.string().nullish(),
  snippet: z.string().nullish(),
  bodyRef: z.string().nullish(),
  sentAt: TimestampSchema,
  classification: z.enum(COMM_CLASSIFICATIONS).nullish(),
  /** Null for messages that are not recruiter outreach. */
  outreachKind: z.enum(OUTREACH_KINDS).nullish(),
  mismatchReason: z.string().nullish(),
  confidence: z.number().min(0).max(1).nullish(),
  bodySource: z.enum(BODY_SOURCES).nullish(),
  opportunityId: IdSchema.nullish(),
  contactId: IdSchema.nullish(),
  needsReview: z.boolean().default(false),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Communication = z.infer<typeof CommunicationSchema>;
