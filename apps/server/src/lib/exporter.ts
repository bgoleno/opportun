// Full data export (FR-I3): a zip holding export.json (every user-owned table, keyed by
// table name), opportunities.csv in the import pack format (so an export re-imports), and
// one Markdown summary per opportunity. Credentials never leave: the secrets vault,
// sessions and OAuth token bundles are excluded, and the users row drops its password hash
// and encrypted TOTP secret.
import { PassThrough, type Readable } from 'node:stream';
import { eq, getTableName } from 'drizzle-orm';
import { strToU8, Zip, ZipDeflate } from 'fflate';
import type { Db, DbColumn, DbTable } from '../db/client';
import * as schema from '../db/schema';
import type { UserCtx } from '../repos/base';
import { formatCsv } from './csv';
import { OPPORTUNITY_COLUMNS } from './importer';

export const EXPORT_FORMAT = 'opportun-export/1';

/** Tables with a user_id that are deliberately left out, and why. */
export const EXPORT_EXCLUDED_TABLES: readonly string[] = [
  'secrets', // encrypted credentials
  'sessions', // session token hashes
  'oauth_accounts', // encrypted OAuth token bundles
  'device_tokens', // bearer token hashes (credentials, like sessions)
  'jobs', // queue internals (an import payload is a copy of data exported elsewhere)
  'search_index', // full-text index derived from opportunities, activities, communications
  // Internal heuristic bookkeeping (#94), not the user's own data: a pair's ids are only
  // meaningful alongside the opportunities they name. Losing it on export/import means a
  // dismissed near-miss could be re-proposed once after a reimport, the same low-stakes gap
  // a pre-#94 dismissal already has (see opportunityDedupe.ts).
  'opportunity_dedupe_candidates',
];

type UserTable = DbTable & { userId: DbColumn };

/** Every exported table that is filtered by user_id. */
const USER_TABLES: UserTable[] = [
  schema.auditLog,
  schema.prompts,
  schema.profiles,
  schema.roleTargets,
  schema.resumeRules,
  schema.companies,
  schema.opportunities,
  schema.stageHistory,
  schema.activities,
  schema.nextSteps,
  schema.attachments,
  schema.resumes,
  schema.tailoringSessions,
  schema.resumeMatchReports,
  schema.discoverySources,
  schema.discoveryRuns,
  schema.discoveryResults,
  schema.dismissalFeedback,
  // The user's mail filter rules travel with the export: restoring without them would
  // silently reopen every sender they had blocked.
  schema.mailFilterRules,
  schema.taskRuns,
  schema.contacts,
  schema.communications,
  schema.syncState,
  schema.settings,
] as UserTable[];

export interface ExportEntry {
  name: string;
  text: string;
}

const day = (ms: number | null | undefined): string =>
  ms === null || ms === undefined ? '' : new Date(ms).toISOString().slice(0, 10);

/**
 * One path segment safe for a zip entry: letters and digits kept, every other run of
 * characters (slashes, dots, colons, spaces) becomes a single dash. Never empty, never
 * starts with a dot, so `..` and absolute names cannot occur.
 */
export function safeSegment(value: string): string {
  const cleaned = value
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return cleaned === '' ? 'untitled' : cleaned;
}

type OppRow = typeof schema.opportunities.$inferSelect;

function summary(
  opp: OppRow,
  company: string,
  history: (typeof schema.stageHistory.$inferSelect)[],
  acts: (typeof schema.activities.$inferSelect)[],
  steps: (typeof schema.nextSteps.$inferSelect)[],
): string {
  const lines: string[] = [`# ${opp.title}`, ''];
  const reason = opp.closedReason ?? opp.dismissedReason;
  lines.push(`- Company: ${company}`);
  lines.push(`- Stage: ${opp.stage}${reason === null ? '' : ` (${reason})`}`);
  if (opp.location !== null) lines.push(`- Location: ${opp.location}`);
  if (opp.postingUrl !== null) lines.push(`- Posting: ${opp.postingUrl}`);
  lines.push(`- Source: ${opp.sourceKind}${opp.sourceRef === null ? '' : ` (${opp.sourceRef})`}`);
  if (opp.compNote !== null) lines.push(`- Compensation: ${opp.compNote}`);
  lines.push(`- Added: ${day(opp.createdAt)}`);
  if (opp.descriptionMd !== null && opp.descriptionMd.trim() !== '') {
    lines.push('', '## Description', '', opp.descriptionMd.trim());
  }
  if (history.length > 0) {
    lines.push('', '## Stage history', '');
    for (const h of history) {
      const move = h.fromStage === null ? h.toStage : `${h.fromStage} -> ${h.toStage}`;
      lines.push(`- ${day(h.at)}: ${move}${h.note === null ? '' : ` (${h.note})`}`);
    }
  }
  if (acts.length > 0) {
    lines.push('', '## Activity');
    for (const a of acts) {
      lines.push('', `### ${day(a.occurredAt)} ${a.kind}: ${a.title}`);
      if (a.bodyMd !== null && a.bodyMd.trim() !== '') lines.push('', a.bodyMd.trim());
    }
  }
  if (steps.length > 0) {
    lines.push('', '## Next steps', '');
    for (const s of steps) {
      const due = s.dueAt === null ? '' : ` (due ${day(s.dueAt)})`;
      lines.push(`- [${s.doneAt === null ? ' ' : 'x'}] ${s.action}${due}`);
    }
  }
  return lines.join('\n') + '\n';
}

/** Everything the caller owns, as zip entries. Only ctx.userId's rows are read. */
export async function buildExport(
  db: Db,
  ctx: UserCtx,
  now: number = Date.now(),
): Promise<ExportEntry[]> {
  const tables: Record<string, unknown[]> = {};
  const me = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      displayName: schema.users.displayName,
      isAdmin: schema.users.isAdmin,
      createdAt: schema.users.createdAt,
      updatedAt: schema.users.updatedAt,
    })
    .from(schema.users)
    .where(eq(schema.users.id, ctx.userId))
    .all();
  tables.users = me;
  for (const table of USER_TABLES) {
    tables[getTableName(table)] = await db
      .select()
      .from(table)
      .where(eq(table.userId, ctx.userId))
      .all();
  }

  const companyName = new Map(
    (tables.companies as (typeof schema.companies.$inferSelect)[]).map((c) => [c.id, c.name]),
  );
  const opps = [...(tables.opportunities as OppRow[])].sort(
    (a, b) =>
      (companyName.get(a.companyId) ?? '').localeCompare(companyName.get(b.companyId) ?? '') ||
      a.title.localeCompare(b.title) ||
      a.createdAt - b.createdAt,
  );
  const byOpp = <T extends { opportunityId: string | null }>(rows: T[], id: string) =>
    rows.filter((r) => r.opportunityId === id);
  const history = tables.stage_history as (typeof schema.stageHistory.$inferSelect)[];
  const acts = tables.activities as (typeof schema.activities.$inferSelect)[];
  const steps = tables.next_steps as (typeof schema.nextSteps.$inferSelect)[];

  const entries: ExportEntry[] = [
    {
      name: 'export.json',
      text: JSON.stringify(
        { format: EXPORT_FORMAT, exportedAt: new Date(now).toISOString(), tables },
        null,
        2,
      ),
    },
  ];

  const csvRows: string[][] = [[...OPPORTUNITY_COLUMNS]];
  const used = new Set<string>();
  for (const opp of opps) {
    const company = companyName.get(opp.companyId) ?? '';
    csvRows.push([
      company,
      opp.title,
      opp.stage,
      opp.postingUrl ?? '',
      opp.location ?? '',
      opp.sourceRef ?? '',
      '',
      opp.dismissedReason ?? '',
      '',
      '',
    ]);
    const base = `${safeSegment(company)}-${safeSegment(opp.title)}`;
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}-${n}`;
    used.add(name.toLowerCase());
    entries.push({
      name: `opportunities/${name}.md`,
      text: summary(
        opp,
        company,
        byOpp(history, opp.id).sort((a, b) => a.at - b.at),
        byOpp(acts, opp.id).sort((a, b) => a.occurredAt - b.occurredAt),
        byOpp(steps, opp.id),
      ),
    });
  }
  entries.splice(1, 0, { name: 'opportunities.csv', text: formatCsv(csvRows) });
  return entries;
}

/** Streams entries as a deflated zip. */
export function zipStream(entries: ExportEntry[]): Readable {
  const out = new PassThrough();
  const zip = new Zip((err, chunk, final) => {
    if (err !== null) {
      out.destroy(err);
      return;
    }
    out.write(Buffer.from(chunk));
    if (final) out.end();
  });
  for (const entry of entries) {
    const file = new ZipDeflate(entry.name, { level: 6 });
    zip.add(file);
    file.push(strToU8(entry.text), true);
  }
  zip.end();
  return out;
}
