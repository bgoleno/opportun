// A recording stand-in for a node-postgres Pool (iteration 4 Wave 2). No Postgres server is
// available to Wave 2, so the Postgres branch of db/client.ts is unit-tested against this: it
// records every statement with its connection and parameters, answers through a scripted
// responder, and emulates the server behaviors the client's correctness rests on:
//
// - transactions per connection: BEGIN opens one, COMMIT/ROLLBACK end it; SAVEPOINT,
//   RELEASE SAVEPOINT and ROLLBACK TO SAVEPOINT nest inside it, and ROLLBACK TO SAVEPOINT
//   keeps the outer transaction open (and the savepoint itself established), as Postgres does;
// - advisory locks: pg_advisory_xact_lock(hashtext($1)) blocks while another connection's
//   open transaction holds the same key. It is released at COMMIT/ROLLBACK, or by ROLLBACK
//   TO SAVEPOINT when it was taken after that savepoint (locks taken before it stay held).
//   The session form pg_advisory_lock($1) is released by pg_advisory_unlock($1) or the
//   connection ending;
// - result columns typed by OID: a responder may tag a field with its type OID and return
//   the column's text form, and the fake decodes it with the query's type parsers (drizzle's
//   per-query `types`, falling back to pg.types), as node-postgres does. This exercises the
//   int8/numeric/json parsers db/client.ts installs.
//
// What it cannot prove: SQL validity, planner behavior, Postgres type resolution of untyped
// parameters, jsonb equality, ILIKE/collation/NULL ordering, real lock waits and deadlocks,
// isolation semantics, or how the server renders values. It proves the client's protocol
// (which statements, on which connection, in which order, how results are decoded);
// Task 13's CI matrix runs the same code against postgres:16.
import pg from 'pg';

/** Type OIDs a responder can tag result columns with. */
export const OID = { TEXT: 25, INT8: 20, NUMERIC: 1700, JSON: 114, JSONB: 3802, BOOL: 16 } as const;

export interface FakeQuery {
  /** 0 for pool.query (an anonymous connection), otherwise the checked-out client's id. */
  client: number;
  text: string;
  params: unknown[];
  rowMode: 'array' | undefined;
}

export interface FakeResult {
  rows?: unknown[];
  rowCount?: number | null;
  /**
   * Column names, for array-mode results. A field tagged with an OID marks its column as
   * returned in text form, decoded with the query's type parser for that OID.
   */
  fields?: (string | { name: string; oid: number })[];
}

export type Responder = (
  q: FakeQuery,
) => FakeResult | Error | undefined | Promise<FakeResult | Error | undefined>;

interface TypeParsers {
  getTypeParser(oid: number, format?: string): (text: string) => unknown;
}

interface QueryConfig {
  text: string;
  values?: unknown[];
  rowMode?: 'array';
  types?: TypeParsers;
}

const SAVEPOINT = /^savepoint\s+(\S+)/i;
const RELEASE_SAVEPOINT = /^release\s+savepoint\s+(\S+)/i;
const ROLLBACK_TO = /^rollback\s+to\s+savepoint\s+(\S+)/i;

const XACT_LOCK = /pg_advisory_xact_lock\s*\(\s*hashtext\s*\(\s*\$1\s*\)\s*\)/i;
const SESSION_LOCK = /pg_advisory_lock\s*\(\s*\$1\s*\)/i;
const SESSION_UNLOCK = /pg_advisory_unlock\s*\(\s*\$1\s*\)/i;

export class FakePgClient {
  inTransaction = false;
  released = false;
  /** release(err) was called: the pool would destroy this connection. */
  destroyed = false;
  readonly xactLocks = new Set<string>();
  readonly sessionLocks = new Set<string>();
  /** Open savepoints, innermost last, each with the xact locks taken since it was set. */
  readonly savepoints: { name: string; locks: Set<string> }[] = [];

  constructor(
    readonly pool: FakePgPool,
    readonly id: number,
  ) {}

  query(config: string | QueryConfig, params?: unknown[]): Promise<unknown> {
    return this.pool.run(this, config, params);
  }

  release(err?: unknown): void {
    if (this.released) throw new Error(`client ${this.id} released twice`);
    this.released = true;
    if (err !== undefined && err !== false) this.destroyed = true;
    // A connection that goes back to the pool mid-transaction would leak it; flag it loudly.
    if (this.inTransaction) this.pool.leaks.push(this.id);
    for (const key of this.sessionLocks) this.pool.unlock(key);
    this.sessionLocks.clear();
  }
}

export class FakePgPool {
  readonly log: FakeQuery[] = [];
  readonly clients: FakePgClient[] = [];
  /** Clients released while still inside a transaction. */
  readonly leaks: number[] = [];
  ended = false;
  private nextId = 1;
  private readonly held = new Map<string, number>();
  private readonly waiters = new Map<string, (() => void)[]>();
  readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();

  constructor(public respond: Responder = () => undefined) {}

  async connect(): Promise<FakePgClient> {
    if (this.ended) throw new Error('Cannot use a pool after calling end on the pool');
    const client = new FakePgClient(this, this.nextId++);
    this.clients.push(client);
    return client;
  }

  query(config: string | QueryConfig, params?: unknown[]): Promise<unknown> {
    if (this.ended)
      return Promise.reject(new Error('Cannot use a pool after calling end on the pool'));
    return this.run(undefined, config, params);
  }

  async end(): Promise<void> {
    this.ended = true;
  }

  on(event: string, fn: (...args: unknown[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
    return this;
  }

  /** Statements of one connection, as text. */
  textsOf(client: number): string[] {
    return this.log.filter((q) => q.client === client).map((q) => q.text);
  }

  private releaseSavepoint(client: FakePgClient, name: string): void {
    const at = client.savepoints.map((sp) => sp.name).lastIndexOf(name);
    if (at === -1) throw new Error(`savepoint ${name} does not exist`);
    // Its locks (and those of savepoints nested in it) now belong to the enclosing level.
    const merged = client.savepoints.splice(at).flatMap((sp) => [...sp.locks]);
    for (const key of merged) client.savepoints.at(-1)?.locks.add(key);
  }

  private rollbackToSavepoint(client: FakePgClient, name: string): void {
    const at = client.savepoints.map((sp) => sp.name).lastIndexOf(name);
    if (at === -1) throw new Error(`savepoint ${name} does not exist`);
    // Undo everything after the savepoint, which itself stays established.
    for (const sp of client.savepoints.splice(at + 1).concat(client.savepoints.slice(at))) {
      for (const key of sp.locks) {
        client.xactLocks.delete(key);
        this.unlock(key);
      }
      sp.locks.clear();
    }
  }

  unlock(key: string): void {
    this.held.delete(key);
    const next = this.waiters.get(key)?.shift();
    next?.();
  }

  private async lock(key: string, owner: number): Promise<void> {
    while (this.held.has(key) && this.held.get(key) !== owner) {
      await new Promise<void>((resolve) =>
        this.waiters.set(key, [...(this.waiters.get(key) ?? []), resolve]),
      );
    }
    this.held.set(key, owner);
  }

  async run(
    client: FakePgClient | undefined,
    config: string | QueryConfig,
    params: unknown[] | undefined,
  ): Promise<unknown> {
    const text = typeof config === 'string' ? config : config.text;
    const values = params ?? (typeof config === 'string' ? undefined : config.values) ?? [];
    const q: FakeQuery = {
      client: client?.id ?? 0,
      text,
      params: values,
      rowMode: typeof config === 'string' ? undefined : config.rowMode,
    };
    if (client?.released === true) throw new Error(`client ${client.id} used after release`);
    this.log.push(q);
    const trimmed = text.trim();
    const verb = trimmed.split(/\s+/)[0]?.toLowerCase();
    const savepoint = SAVEPOINT.exec(trimmed)?.[1];
    const released = RELEASE_SAVEPOINT.exec(trimmed)?.[1];
    const rolledBackTo = ROLLBACK_TO.exec(trimmed)?.[1];
    if (client !== undefined) {
      if (verb === 'begin') client.inTransaction = true;
      if (savepoint !== undefined || released !== undefined || rolledBackTo !== undefined) {
        if (!client.inTransaction) throw new Error(`${trimmed} outside a transaction`);
      }
      if (savepoint !== undefined) client.savepoints.push({ name: savepoint, locks: new Set() });
      if (released !== undefined) this.releaseSavepoint(client, released);
      if (rolledBackTo !== undefined) this.rollbackToSavepoint(client, rolledBackTo);
      if (XACT_LOCK.test(text)) {
        if (!client.inTransaction) throw new Error('advisory xact lock outside a transaction');
        const key = `x:${String(values[0])}`;
        const fresh = !client.xactLocks.has(key);
        await this.lock(key, client.id);
        client.xactLocks.add(key);
        // Only a lock this savepoint level took is released by rolling back to it.
        if (fresh) client.savepoints.at(-1)?.locks.add(key);
      }
      if (SESSION_LOCK.test(text)) {
        const key = `s:${String(values[0])}`;
        await this.lock(key, client.id);
        client.sessionLocks.add(key);
      }
      if (SESSION_UNLOCK.test(text)) {
        const key = `s:${String(values[0])}`;
        client.sessionLocks.delete(key);
        this.unlock(key);
      }
    }
    const answer = await this.respond(q);
    if (
      client !== undefined &&
      (verb === 'commit' || (verb === 'rollback' && rolledBackTo === undefined))
    ) {
      client.inTransaction = false;
      for (const key of client.xactLocks) this.unlock(key);
      client.xactLocks.clear();
      client.savepoints.length = 0;
    }
    if (answer instanceof Error) {
      // Postgres aborts the transaction on an error; the client must ROLLBACK.
      throw answer;
    }
    const tagged = (answer?.fields ?? []).map((f) =>
      typeof f === 'string' ? { name: f, oid: undefined } : f,
    );
    const types: TypeParsers =
      (typeof config === 'string' ? undefined : config.types) ?? (pg.types as TypeParsers);
    const decode = (value: unknown, oid: number | undefined) =>
      oid === undefined || typeof value !== 'string'
        ? value
        : types.getTypeParser(oid, 'text')(value);
    const rows = (answer?.rows ?? []).map((row) => {
      if (Array.isArray(row)) return row.map((v: unknown, i) => decode(v, tagged[i]?.oid));
      const out = { ...(row as Record<string, unknown>) };
      for (const f of tagged) if (f.name in out) out[f.name] = decode(out[f.name], f.oid);
      return out;
    });
    const fields = tagged.map((f) => ({ name: f.name, dataTypeID: f.oid ?? OID.TEXT }));
    return {
      command: verb?.toUpperCase() ?? '',
      rows,
      rowCount: answer?.rowCount === undefined ? rows.length : answer.rowCount,
      fields,
    };
  }
}

/** A Postgres error as node-postgres raises it (code is the SQLSTATE), with any extra fields. */
export function pgError(
  code: string,
  message: string,
  extra: Partial<
    Record<
      'detail' | 'where' | 'internalQuery' | 'constraint' | 'table' | 'column' | 'hint',
      string
    >
  > = {},
): Error {
  const err = new pg.DatabaseError(message, message.length, 'error');
  return Object.assign(err, { code, severity: 'ERROR' }, extra);
}
