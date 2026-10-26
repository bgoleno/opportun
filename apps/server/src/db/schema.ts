// The schema the app runs on: the SQLite tables (schema.sqlite.ts) or their Postgres twin
// (schema.pg.ts), chosen once at module load from DB_DIALECT (ADR-4, iteration 4 Task 7).
//
// Dialect erasure: every export is typed as the SQLite table, so repos compose queries
// against one set of types whichever engine is underneath. That is sound because the twins'
// row types (InferSelectModel/InferInsertModel) are identical and their names, defaults, keys
// and indexes match (test/schemaConformance.test.ts). db/client.ts refuses to open a database
// whose dialect differs from SCHEMA_DIALECT, so a process never mixes the two.
import { parseDbDialect, type DbDialect } from './dialectName';
import * as pgTables from './schema.pg';
import type { TableExport } from './schema.shared';
import * as sqliteTables from './schema.sqlite';

export * from './schema.shared';

/** The dialect this process's tables belong to (DB_DIALECT at load time). */
export const SCHEMA_DIALECT: DbDialect = parseDbDialect(process.env.DB_DIALECT);

type Tables = Pick<typeof sqliteTables, TableExport>;

/** The table set for a dialect, typed as the SQLite tables (the erasure above). */
export function tablesFor(dialect: DbDialect): Tables {
  return (dialect === 'postgres' ? pgTables : sqliteTables) as unknown as Tables;
}

const t = tablesFor(SCHEMA_DIALECT);

export const users = t.users;
export const sessions = t.sessions;
export const deviceTokens = t.deviceTokens;
export const oauthAccounts = t.oauthAccounts;
export const secrets = t.secrets;
export const auditLog = t.auditLog;
export const prompts = t.prompts;
export const profiles = t.profiles;
export const roleTargets = t.roleTargets;
export const resumeRules = t.resumeRules;
export const companies = t.companies;
export const opportunities = t.opportunities;
export const opportunityDedupeCandidates = t.opportunityDedupeCandidates;
export const stageHistory = t.stageHistory;
export const activities = t.activities;
export const nextSteps = t.nextSteps;
export const attachments = t.attachments;
export const resumes = t.resumes;
export const tailoringSessions = t.tailoringSessions;
export const resumeMatchReports = t.resumeMatchReports;
export const discoverySources = t.discoverySources;
export const discoveryRuns = t.discoveryRuns;
export const discoveryResults = t.discoveryResults;
export const dismissalFeedback = t.dismissalFeedback;
export const mailFilterRules = t.mailFilterRules;
export const taskRuns = t.taskRuns;
export const contacts = t.contacts;
export const communications = t.communications;
export const syncState = t.syncState;
export const jobs = t.jobs;
export const settings = t.settings;
