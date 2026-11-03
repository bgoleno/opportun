// The companies in the user's network (https://github.com/bgoleno/opportun/issues/216): every
// company at least one of the user's contacts works at now (network_contacts.current_company_id),
// once each, with the contact count, the strongest strength and the contacts themselves. It reads
// the user's own rows only: no AI call and no outbound request. Grouping happens here, not in
// SQL, so it reads the same on SQLite and Postgres.
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { companies, networkContacts } from '../db/schema';
import type { UserCtx } from './base';
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
 * Most contacts first, then the strongest tie, then the name. A denied company is left out
 * unless `showDenied`.
 */
export async function listNetworkCompanies(
  db: Db,
  ctx: UserCtx,
  opts: { showDenied: boolean },
): Promise<NetworkCompany[]> {
  const contacts = await db
    .select({
      id: networkContacts.id,
      name: networkContacts.name,
      strength: networkContacts.strength,
      companyId: networkContacts.currentCompanyId,
    })
    .from(networkContacts)
    .where(and(eq(networkContacts.userId, ctx.userId), isNotNull(networkContacts.currentCompanyId)))
    .all();
  const grouped = new Map<string, NetworkContact[]>();
  for (const c of contacts) {
    if (c.companyId === null) continue;
    const list = grouped.get(c.companyId) ?? [];
    list.push({ id: c.id, name: c.name, strength: c.strength });
    grouped.set(c.companyId, list);
  }
  if (grouped.size === 0) return [];
  const rows = await db
    .select()
    .from(companies)
    .where(and(eq(companies.userId, ctx.userId), inArray(companies.id, [...grouped.keys()])))
    .all();
  const items: NetworkCompany[] = [];
  for (const company of rows) {
    if (company.status === 'denied' && !opts.showDenied) continue;
    const people = (grouped.get(company.id) ?? []).sort(byStrengthThenName);
    const strengths = people.map((p) => p.strength).filter((s): s is number => s !== null);
    items.push({
      company,
      board: boardState(company.atsKind),
      contactCount: people.length,
      strongestStrength: strengths.length === 0 ? null : Math.max(...strengths),
      contacts: people,
    });
  }
  return items.sort(
    (a, b) =>
      b.contactCount - a.contactCount ||
      (b.strongestStrength ?? 0) - (a.strongestStrength ?? 0) ||
      a.company.name.localeCompare(b.company.name),
  );
}
