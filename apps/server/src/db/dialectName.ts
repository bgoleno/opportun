// Which database engine this process runs on (ADR-4). Read once from DB_DIALECT: the schema
// module picks its tables from it at load time (db/schema.ts), and loadConfig validates the
// same variable, so a process is one dialect from start to finish.

export const DB_DIALECTS = ['sqlite', 'postgres'] as const;
export type DbDialect = (typeof DB_DIALECTS)[number];

/** DB_DIALECT as a dialect; unset or empty means SQLite. Throws on anything else. */
export function parseDbDialect(raw: string | undefined): DbDialect {
  if (raw === undefined || raw === '' || raw === 'sqlite') return 'sqlite';
  if (raw === 'postgres') return 'postgres';
  throw new Error(`DB_DIALECT must be sqlite or postgres, got: ${JSON.stringify(raw)}`);
}
