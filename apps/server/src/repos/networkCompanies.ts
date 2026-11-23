// The companies in the user's network (https://github.com/bgoleno/opportun/issues/216): every
// company at least one of the user's contacts works at now (network_contacts.current_company_id),
// once each, with the contact count, the strongest strength and the contacts themselves. It reads
// the user's own rows only: no AI call and no outbound request. The database counts; the order is
// taken here, not in SQL, so it reads the same on SQLite and Postgres.
import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { companies, networkContacts } from '../db/schema';
import type { UserCtx } from './base';
import { ownedBy } from './base';
import type { Company } from './companies';

/** found: a board kind is recorded; not_found: detection ran and found none; not_checked: never run. */
export type BoardState = 'found' | 'not_found' | 'not_checked';

export const boardState = (atsKind: string | null): BoardState =>
  atsKind === null ? 'not_checked' : atsKind === 'none' ? 'not_found' : 'found';

export interface NetworkContact {
  id: string;
  name: string;
  strength: number | null;
}

export interface NetworkCompany {
  company: Company;
  board: BoardState;
  contactCount: number;
  strongestStrength: number | null;
  /** Strongest first, then by name; a contact with no strength comes last. */
  contacts: NetworkContact[];
}

const byStrengthThenName = (a: NetworkContact, b: NetworkContact): number =>
  (b.strength ?? 0) - (a.strength ?? 0) || a.name.localeCompare(b.name);

/**
 * Most contacts first, then the strongest tie, then the name; a missing strength counts as 0. A
 * denied company is left out unless `showDenied`; `ids`, when given, keeps only those companies.
 *
 * Paged (https://github.com/bgoleno/opportun/issues/591): the database counts each company's
 * contacts (one row per company, not per contact), the order is taken here, in JS, and only the
 * page's companies and their contacts are read. The order is not left to SQL: `localeCompare` and
 * a missing strength as 0 are what this list has always used, and ORDER BY would follow each
 * database's collation (binary on SQLite) and NULL placement (last on SQLite, first on Postgres).
 */
export async function listNetworkCompanies(
  db: Db,
  ctx: UserCtx,
  opts: {
    showDenied: boolean;
    limit: number;
    offset: number;
    ids?: readonly string[] | undefined;
  },
): Promise<{ items: NetworkCompany[]; total: number }> {
  if (opts.ids !== undefined && opts.ids.length === 0) return { items: [], total: 0 };
  const counted = await db
    .select({
      id: companies.id,
      name: companies.name,
      contactCount: sql<number>`count(*)`.mapWith(Number),
      strongest: sql<number | null>`max(${networkContacts.strength})`,
    })
    .from(networkContacts)
    .innerJoin(
      companies,
      and(eq(companies.id, networkContacts.currentCompanyId), ownedBy(companies.userId, ctx)),
    )
    .where(
      and(
        ownedBy(networkContacts.userId, ctx),
        isNotNull(networkContacts.currentCompanyId),
        opts.showDenied ? undefined : ne(companies.status, 'denied'),
        opts.ids === undefined ? undefined : inArray(companies.id, [...opts.ids]),
      ),
    )
    .groupBy(companies.id, companies.name)
    .all();
  const strongestOf = (r: { strongest: number | null }) =>
    r.strongest === null ? null : Number(r.strongest);
  const ordered = counted.sort(
    (a, b) =>
      b.contactCount - a.contactCount ||
      (strongestOf(b) ?? 0) - (strongestOf(a) ?? 0) ||
      a.name.localeCompare(b.name) ||
      // Stable across pages: two companies of the same name keep one order.
      a.id.localeCompare(b.id),
  );
  const pageRows = ordered.slice(opts.offset, opts.offset + opts.limit);
  if (pageRows.length === 0) return { items: [], total: ordered.length };

  const pageIds = pageRows.map((r) => r.id);
  const rows = await db
    .select()
    .from(companies)
    .where(and(ownedBy(companies.userId, ctx), inArray(companies.id, pageIds)))
    .all();
  const contacts = await db
    .select({
      id: networkContacts.id,
      name: networkContacts.name,
      strength: networkContacts.strength,
      companyId: networkContacts.currentCompanyId,
    })
    .from(networkContacts)
    .where(
      and(ownedBy(networkContacts.userId, ctx), inArray(networkContacts.currentCompanyId, pageIds)),
    )
    .all();
  const grouped = new Map<string, NetworkContact[]>();
  for (const c of contacts) {
    if (c.companyId === null) continue;
    const list = grouped.get(c.companyId) ?? [];
    list.push({ id: c.id, name: c.name, strength: c.strength });
    grouped.set(c.companyId, list);
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const items: NetworkCompany[] = [];
  for (const r of pageRows) {
    const company = byId.get(r.id);
    if (company === undefined) continue;
    const people = (grouped.get(r.id) ?? []).sort(byStrengthThenName);
    items.push({
      company,
      board: boardState(company.atsKind),
      contactCount: people.length,
      strongestStrength: strongestOf(r),
      contacts: people,
    });
  }
  return { items, total: ordered.length };
}
