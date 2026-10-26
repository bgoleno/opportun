// Companies (design 4.3). Names are unique per user, case-insensitively, so a pasted
// "initech" lands on the same row as "Initech".
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { companyMatchKey, newId } from '@opportun/core';
import { companies } from '../db/schema';
import { duplicate, notFound } from '../lib/errors';
import type { Db, Exec, UserCtx } from './base';
import { countWhere, likeContains, orderBy, sortColumns, type ListOpts, type Page } from './list';
import { lockScope, withTransaction } from '../db/client';
import { racePoint } from '../lib/racePoints';

export type Company = typeof companies.$inferSelect;
export type CompanyInput = Omit<
  typeof companies.$inferInsert,
  'id' | 'userId' | 'companyMatchKey' | 'createdAt' | 'updatedAt'
>;

export const COMPANY_SORTS = sortColumns({
  name: companies.name,
  createdAt: companies.createdAt,
  updatedAt: companies.updatedAt,
});

function sameName(name: string): SQL {
  return sql`lower(${companies.name}) = lower(${name.trim()})`;
}

/**
 * Pairs a company name with its match key (issue #193): every write that sets `name` goes
 * through this, so the two values cannot drift by one write path remembering the pairing and
 * another forgetting it. No SQL expression can keep them in sync on its own (a generated
 * column) because companyMatchKey's normalization only exists in JS; this is the equivalent
 * guarantee at the one layer that can actually compute it.
 */
export function withMatchKey<T extends { name: string }>(
  fields: T,
): T & { companyMatchKey: string } {
  return { ...fields, companyMatchKey: companyMatchKey(fields.name) };
}

async function findByName(exec: Exec, ctx: UserCtx, name: string): Promise<Company | undefined> {
  return await exec
    .select()
    .from(companies)
    .where(and(eq(companies.userId, ctx.userId), sameName(name)))
    .get();
}

/**
 * Core of findOrCreateCompany for use inside an open transaction (name kept from the sync
 * era). There is no unique index on (user_id, lower(name)) (live data may hold case
 * variants), so the check-then-insert holds the user's scope lock, in whatever transaction
 * the caller composed it into.
 */
export async function findOrCreateCompanySync(
  exec: Exec,
  ctx: UserCtx,
  name: string,
): Promise<Company> {
  await lockScope(exec, userScope(ctx));
  const existing = await findByName(exec, ctx, name);
  if (existing !== undefined) return existing;
  await racePoint('companies.findOrCreate.locked');
  const now = Date.now();
  return await exec
    .insert(companies)
    .values({
      id: newId(),
      userId: ctx.userId,
      ...withMatchKey({ name: name.trim() }),
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

export async function findOrCreateCompany(db: Db, ctx: UserCtx, name: string): Promise<Company> {
  await racePoint('companies.findOrCreate');
  return await withTransaction(db, async (tx) => await findOrCreateCompanySync(tx, ctx, name));
}

/** The per-user serialization scope for name checks that no unique index backs. */
const userScope = (ctx: UserCtx): string => `user:${ctx.userId}`;

export async function listCompanies(
  db: Db,
  ctx: UserCtx,
  opts: ListOpts & { q?: string | undefined; status?: Company['status'] | undefined },
): Promise<Page<Company>> {
  const where = and(
    eq(companies.userId, ctx.userId),
    opts.q === undefined ? undefined : likeContains(companies.name, opts.q),
    opts.status === undefined ? undefined : eq(companies.status, opts.status),
  );
  const items = await db
    .select()
    .from(companies)
    .where(where)
    .orderBy(...orderBy(opts.sort, 'name', COMPANY_SORTS, companies.id))
    .limit(opts.limit)
    .offset(opts.offset)
    .all();
  return { items, total: await countWhere(db, companies, where) };
}

export async function getCompany(db: Db, ctx: UserCtx, id: string): Promise<Company> {
  const row = await db
    .select()
    .from(companies)
    .where(and(eq(companies.userId, ctx.userId), eq(companies.id, id)))
    .get();
  if (row === undefined) throw notFound();
  return row;
}

/** Creates a company; a name the caller already has (any case) is a 409 duplicate. */
export async function createCompany(db: Db, ctx: UserCtx, input: CompanyInput): Promise<Company> {
  return await withTransaction(db, async (tx) => {
    await lockScope(tx, userScope(ctx));
    const existing = await findByName(tx, ctx, input.name);
    if (existing !== undefined) throw duplicate(existing.id);
    const now = Date.now();
    return await tx
      .insert(companies)
      .values({
        ...input,
        ...withMatchKey({ name: input.name.trim() }),
        id: newId(),
        userId: ctx.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  });
}

export async function updateCompany(
  db: Db,
  ctx: UserCtx,
  id: string,
  patch: Partial<CompanyInput>,
): Promise<Company> {
  return await withTransaction(db, async (tx) => {
    await lockScope(tx, userScope(ctx));
    if (patch.name !== undefined) {
      const clash = await findByName(tx, ctx, patch.name);
      if (clash !== undefined && clash.id !== id) throw duplicate(clash.id);
    }
    const row = await tx
      .update(companies)
      .set({
        ...patch,
        ...(patch.name === undefined ? {} : withMatchKey({ name: patch.name })),
        updatedAt: Date.now(),
      })
      .where(and(eq(companies.userId, ctx.userId), eq(companies.id, id)))
      .returning()
      .get();
    if (row === undefined) throw notFound();
    return row;
  });
}
