// Mail filter rules (spec D1 rules 0, 1 and 4; D7) and the consumer-domain veto toggle.
//
// The table holds only what the user wrote, what a rejection added, or the self-allow seeds
// that keep the account's own address out of the vetoes. The consumer-domain list of rule 2
// is built in (CONSUMER_EMAIL_DOMAINS) behind one per-user boolean, so turning it off is one
// toggle rather than sixty row edits, and a later release can extend the list without
// clobbering anyone's own rules.
import { newId, parseMailPattern } from '@opportun/core';
import type { MailFilterEffect, MailFilterSource } from '../db/schema.shared';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { mailFilterRules, users } from '../db/schema';
import { HttpError } from '../lib/errors';
import type { Exec, UserCtx } from './base';
import { readUserSetting, writeUserSetting } from './userSettings';

export type MailFilterRuleRow = typeof mailFilterRules.$inferSelect;

/** Rule 2's on/off switch. On by default: the veto is the point of shipping it. */
export const CONSUMER_VETO_SETTING = 'consumer_domain_veto';

export async function readConsumerVeto(exec: Exec, ctx: UserCtx): Promise<boolean> {
  return await readUserSetting(exec, ctx, CONSUMER_VETO_SETTING, z.boolean(), true);
}

export async function writeConsumerVeto(exec: Exec, ctx: UserCtx, enabled: boolean): Promise<void> {
  await writeUserSetting(exec, ctx, CONSUMER_VETO_SETTING, enabled);
}

/** The user's rules, oldest first so the settings page lists them in the order they were added. */
export async function listRules(db: Db, ctx: UserCtx): Promise<MailFilterRuleRow[]> {
  return await db
    .select()
    .from(mailFilterRules)
    .where(eq(mailFilterRules.userId, ctx.userId))
    .orderBy(asc(mailFilterRules.createdAt), asc(mailFilterRules.id))
    .all();
}

async function getOwned(db: Db, ctx: UserCtx, id: string): Promise<MailFilterRuleRow> {
  const row = await db
    .select()
    .from(mailFilterRules)
    .where(and(eq(mailFilterRules.userId, ctx.userId), eq(mailFilterRules.id, id)))
    .get();
  if (row === undefined) throw new HttpError(404, 'not_found', 'No such mail filter rule');
  return row;
}

export interface CreateRuleInput {
  pattern: string;
  effect: MailFilterEffect;
  note?: string | null | undefined;
  source?: MailFilterSource | undefined;
  /**
   * Defaults to true, because a rule the user just wrote is a rule they want in force. The one
   * caller that passes false is switching a built-in `job_sender` off (decision D-3): a disabled
   * rule naming the same pattern is how a list that ships in code stays the user's to edit.
   */
  enabled?: boolean | undefined;
}

/**
 * Stores one rule. The pattern is validated here rather than at the route, so every writer
 * (routes, rejection, self-allow seeding) gets the same check, and it is stored in the
 * canonical lowercase form the matcher compares against.
 */
export async function createRule(
  db: Db,
  ctx: UserCtx,
  input: CreateRuleInput,
): Promise<MailFilterRuleRow> {
  const pattern = input.pattern.trim().toLowerCase();
  if (parseMailPattern(pattern) === null) {
    throw new HttpError(400, 'invalid_pattern', `Not a sender pattern: ${input.pattern}`);
  }
  const now = Date.now();
  const row = {
    id: newId(),
    userId: ctx.userId,
    pattern,
    effect: input.effect,
    enabled: input.enabled ?? true,
    source: input.source ?? 'user',
    note: input.note?.slice(0, 300) ?? null,
    createdAt: now,
    updatedAt: now,
  } satisfies MailFilterRuleRow;
  try {
    await db.insert(mailFilterRules).values(row).run();
  } catch (err) {
    const existing = await db
      .select({ id: mailFilterRules.id })
      .from(mailFilterRules)
      .where(
        and(
          eq(mailFilterRules.userId, ctx.userId),
          eq(mailFilterRules.effect, input.effect),
          eq(mailFilterRules.pattern, pattern),
        ),
      )
      .get();
    if (existing === undefined) throw err;
    throw new HttpError(409, 'duplicate', `Already a ${input.effect} rule: ${pattern}`, {
      existingId: existing.id,
    });
  }
  return row;
}

export interface UpdateRuleInput {
  enabled?: boolean | undefined;
  note?: string | null | undefined;
}

export async function updateRule(
  db: Db,
  ctx: UserCtx,
  id: string,
  input: UpdateRuleInput,
): Promise<MailFilterRuleRow> {
  const current = await getOwned(db, ctx, id);
  const next = {
    enabled: input.enabled ?? current.enabled,
    note: input.note === undefined ? current.note : (input.note?.slice(0, 300) ?? null),
    updatedAt: Date.now(),
  };
  await db
    .update(mailFilterRules)
    .set(next)
    .where(and(eq(mailFilterRules.userId, ctx.userId), eq(mailFilterRules.id, id)))
    .run();
  return { ...current, ...next };
}

export async function deleteRule(db: Db, ctx: UserCtx, id: string): Promise<void> {
  await getOwned(db, ctx, id);
  await db
    .delete(mailFilterRules)
    .where(and(eq(mailFilterRules.userId, ctx.userId), eq(mailFilterRules.id, id)))
    .run();
}

/**
 * The account's own mail address, which Stage 1 exempts from every heuristic (spec D1:
 * "Exempt the user's own address and domain").
 *
 * This is an implicit exemption rather than a seeded allow rule. A seeded rule has to be
 * written at some point, can be deleted by accident, and for an account at a consumer provider
 * the obvious seed (`*@gmail.com`) would sit at rule 0 and exempt every Gmail sender on earth,
 * the clinic's mail included. An exemption computed from the account cannot be unseeded,
 * cannot be deleted, and cannot over-reach.
 */
export async function accountAddress(db: Db, ctx: UserCtx): Promise<string | null> {
  const row = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, ctx.userId))
    .get();
  return row?.email.trim().toLowerCase() ?? null;
}
