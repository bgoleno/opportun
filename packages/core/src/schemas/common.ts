import { z } from 'zod';

/** Entity ids are UUIDv7 strings (see newId). */
export const IdSchema = z.uuid();

/** All times are epoch milliseconds integers. */
export const TimestampSchema = z.number().int().nonnegative();

export const COMPANY_STATUSES = ['none', 'suggested', 'followed', 'denied'] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

export const RESUME_STATUSES = ['draft', 'in_review', 'final', 'submitted'] as const;
export type ResumeStatus = (typeof RESUME_STATUSES)[number];
