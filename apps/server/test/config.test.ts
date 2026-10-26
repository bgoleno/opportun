// Database selection (iteration 4 Task 6): DB_DIALECT, DATABASE_URL(_FILE), DB_POOL_MAX,
// DB_SSL. The connection URL carries a password, so it must never be echoed by an error, a
// log line or a serialized config.
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { captureLogs, testApp } from './helpers';

const base = {
  OPPORTUN_MASTER_KEY: randomBytes(32).toString('hex'),
  OPPORTUN_BASE_URL: 'https://opportun.example.com',
  DATA_DIR: '/data',
};

const SECRET = 'hunter2-s3cret';
const REMOTE_URL = `postgres://opportun:${SECRET}@db.internal.example:5432/opportun`;
const LOCAL_URL = `postgresql://opportun:${SECRET}@localhost/opportun`;

function errorOf(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a throw');
}

describe('loadConfig: database', () => {
  it('defaults to SQLite', () => {
    expect(loadConfig(base).db).toEqual({ dialect: 'sqlite' });
    expect(loadConfig({ ...base, DB_DIALECT: '' }).db).toEqual({ dialect: 'sqlite' });
    expect(loadConfig({ ...base, DB_DIALECT: 'sqlite' }).db).toEqual({ dialect: 'sqlite' });
  });

  it('refuses an unknown dialect, naming DB_DIALECT', () => {
    expect(() => loadConfig({ ...base, DB_DIALECT: 'mysql' })).toThrow(
      /DB_DIALECT must be sqlite or postgres/,
    );
    expect(() => loadConfig({ ...base, DB_DIALECT: 'Postgres' })).toThrow(/DB_DIALECT/);
  });

  it('refuses postgres without a URL, with a clear message', () => {
    expect(() => loadConfig({ ...base, DB_DIALECT: 'postgres' })).toThrow(
      /DB_DIALECT=postgres needs DATABASE_URL or DATABASE_URL_FILE/,
    );
  });

  it('reads postgres settings with defaults', () => {
    const db = loadConfig({ ...base, DB_DIALECT: 'postgres', DATABASE_URL: REMOTE_URL }).db;
    expect(db.dialect).toBe('postgres');
    if (db.dialect !== 'postgres') return;
    expect(db.url).toBe(REMOTE_URL);
    expect(db.poolMax).toBe(10);
    // Not a loopback host: TLS by default.
    expect(db.ssl).toBe('require');
  });

  it('defaults DB_SSL to disable for loopback hosts and unix sockets', () => {
    const ssl = (url: string) => {
      const db = loadConfig({ ...base, DB_DIALECT: 'postgres', DATABASE_URL: url }).db;
      return db.dialect === 'postgres' ? db.ssl : undefined;
    };
    expect(ssl(LOCAL_URL)).toBe('disable');
    expect(ssl('postgres://u:p@127.0.0.1:5432/x')).toBe('disable');
    expect(ssl('postgres://u:p@127.3.2.1/x')).toBe('disable');
    expect(ssl('postgres://u:p@[::1]:5432/x')).toBe('disable');
    expect(ssl('postgres://u:p@/x?host=/var/run/postgresql')).toBe('disable');
    expect(ssl('postgres://u:p@10.0.0.5/x')).toBe('require');
  });

  it('honors DB_SSL and DB_POOL_MAX', () => {
    const db = loadConfig({
      ...base,
      DB_DIALECT: 'postgres',
      DATABASE_URL: LOCAL_URL,
      DB_SSL: 'verify-full',
      DB_POOL_MAX: '4',
    }).db;
    expect(db).toMatchObject({ dialect: 'postgres', ssl: 'verify-full', poolMax: 4 });
  });

  it('refuses an invalid DB_SSL or DB_POOL_MAX', () => {
    const env = { ...base, DB_DIALECT: 'postgres', DATABASE_URL: LOCAL_URL };
    expect(() => loadConfig({ ...env, DB_SSL: 'prefer' })).toThrow(
      /DB_SSL must be disable, require or verify-full/,
    );
    for (const bad of ['0', '-1', '2.5', 'ten', '1001']) {
      expect(() => loadConfig({ ...env, DB_POOL_MAX: bad })).toThrow(/DB_POOL_MAX/);
    }
  });

  it('takes TLS from the URL sslmode when DB_SSL is unset, and refuses a conflict', () => {
    const env = { ...base, DB_DIALECT: 'postgres' };
    const db = loadConfig({ ...env, DATABASE_URL: `${LOCAL_URL}?sslmode=require` }).db;
    expect(db.dialect === 'postgres' && db.ssl).toBe('require');
    // The URL handed to the driver no longer carries sslmode: DB_SSL alone decides.
    expect(db.dialect === 'postgres' && db.url).toBe(LOCAL_URL);
    const conflict = errorOf(() =>
      loadConfig({ ...env, DATABASE_URL: `${REMOTE_URL}?sslmode=disable`, DB_SSL: 'require' }),
    );
    expect(conflict.message).toMatch(/DB_SSL/);
    expect(conflict.message).not.toContain(SECRET);
    expect(() => loadConfig({ ...env, DATABASE_URL: `${REMOTE_URL}?sslmode=verify-ca` })).toThrow(
      /sslmode/,
    );
  });

  it('refuses a malformed or non-postgres URL without echoing it', () => {
    const env = { ...base, DB_DIALECT: 'postgres' };
    for (const url of [`not a url ${SECRET}`, `mysql://u:${SECRET}@h/x`]) {
      const err = errorOf(() => loadConfig({ ...env, DATABASE_URL: url }));
      expect(err.message).toMatch(/DATABASE_URL/);
      expect(err.message).not.toContain(SECRET);
    }
  });

  it('reads the URL from DATABASE_URL_FILE', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opportun-dburl-'));
    try {
      const file = join(dir, 'database.url');
      await writeFile(file, `${REMOTE_URL}\n`);
      const db = loadConfig({ ...base, DB_DIALECT: 'postgres', DATABASE_URL_FILE: file }).db;
      expect(db.dialect === 'postgres' && db.url).toBe(REMOTE_URL);
      const missing = errorOf(() =>
        loadConfig({ ...base, DB_DIALECT: 'postgres', DATABASE_URL_FILE: join(dir, 'nope') }),
      );
      expect(missing.message).toMatch(/DATABASE_URL_FILE could not be read/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ignores postgres settings under SQLite', () => {
    expect(loadConfig({ ...base, DATABASE_URL: REMOTE_URL, DB_SSL: 'bogus' }).db).toEqual({
      dialect: 'sqlite',
    });
  });

  it('never serializes the URL: JSON, inspect and the app logger all redact it', async () => {
    const cfg = loadConfig({ ...base, DB_DIALECT: 'postgres', DATABASE_URL: REMOTE_URL });
    for (const text of [JSON.stringify(cfg), inspect(cfg, { depth: 10 }), String(cfg.db)]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('db.internal.example');
    }
    expect(JSON.parse(JSON.stringify(cfg.db))).toEqual({
      dialect: 'postgres',
      url: '[redacted]',
      poolMax: 10,
      ssl: 'require',
    });
    // The real pino serializer, through an app's logger.
    const logs = captureLogs();
    const { app } = await testApp({ logLevel: 'info' }, { logStream: logs });
    try {
      app.log.info({ db: cfg.db, cfg }, 'config');
      expect(logs.text()).toContain('"dialect":"postgres"');
      expect(logs.text()).not.toContain(SECRET);
    } finally {
      await app.close();
    }
  });
});

describe('loadConfig: demo (issue #280)', () => {
  it('is false unless OPPORTUN_DEMO is exactly "1"', () => {
    expect(loadConfig(base).demo).toBe(false);
    expect(loadConfig({ ...base, OPPORTUN_DEMO: '' }).demo).toBe(false);
    expect(loadConfig({ ...base, OPPORTUN_DEMO: 'true' }).demo).toBe(false);
    expect(loadConfig({ ...base, OPPORTUN_DEMO: '0' }).demo).toBe(false);
  });

  it('is true when OPPORTUN_DEMO is "1"', () => {
    expect(loadConfig({ ...base, OPPORTUN_DEMO: '1' }).demo).toBe(true);
  });
});

describe('loadConfig: trusted proxies (issue #333)', () => {
  it('is empty unless OPPORTUN_TRUSTED_PROXIES is set', () => {
    expect(loadConfig(base).trustedProxies).toEqual([]);
    expect(loadConfig({ ...base, OPPORTUN_TRUSTED_PROXIES: '' }).trustedProxies).toEqual([]);
    expect(loadConfig({ ...base, OPPORTUN_TRUSTED_PROXIES: '   ' }).trustedProxies).toEqual([]);
  });

  it('accepts a single bare IP, v4 or v6', () => {
    expect(loadConfig({ ...base, OPPORTUN_TRUSTED_PROXIES: '10.0.0.1' }).trustedProxies).toEqual([
      '10.0.0.1',
    ]);
    expect(loadConfig({ ...base, OPPORTUN_TRUSTED_PROXIES: '2001:db8::1' }).trustedProxies).toEqual(
      ['2001:db8::1'],
    );
  });

  it('accepts each preset name', () => {
    for (const preset of ['loopback', 'linklocal', 'uniquelocal']) {
      expect(loadConfig({ ...base, OPPORTUN_TRUSTED_PROXIES: preset }).trustedProxies).toEqual([
        preset,
      ]);
    }
  });

  it('accepts a CIDR prefix up to and including the family limit (v4 /32, v6 /128)', () => {
    expect(loadConfig({ ...base, OPPORTUN_TRUSTED_PROXIES: '10.0.0.0/24' }).trustedProxies).toEqual(
      ['10.0.0.0/24'],
    );
    expect(loadConfig({ ...base, OPPORTUN_TRUSTED_PROXIES: '10.0.0.0/32' }).trustedProxies).toEqual(
      ['10.0.0.0/32'],
    );
    expect(
      loadConfig({ ...base, OPPORTUN_TRUSTED_PROXIES: '2001:db8::/64' }).trustedProxies,
    ).toEqual(['2001:db8::/64']);
    expect(
      loadConfig({ ...base, OPPORTUN_TRUSTED_PROXIES: '2001:db8::/128' }).trustedProxies,
    ).toEqual(['2001:db8::/128']);
  });

  it('refuses a CIDR prefix one past the family limit, naming the entry', () => {
    expect(() => loadConfig({ ...base, OPPORTUN_TRUSTED_PROXIES: '10.0.0.0/33' })).toThrow(
      /OPPORTUN_TRUSTED_PROXIES entry "10\.0\.0\.0\/33"/,
    );
    expect(() => loadConfig({ ...base, OPPORTUN_TRUSTED_PROXIES: '2001:db8::/129' })).toThrow(
      /OPPORTUN_TRUSTED_PROXIES entry "2001:db8::\/129"/,
    );
  });

  it('refuses a malformed entry, naming it', () => {
    for (const bad of ['not-an-ip', '10.0.0.0/abc', '10.0.0.0/999', 'loopback2', '10.0.0.0/']) {
      const err = errorOf(() => loadConfig({ ...base, OPPORTUN_TRUSTED_PROXIES: bad }));
      expect(err.message).toContain(`OPPORTUN_TRUSTED_PROXIES entry ${JSON.stringify(bad)}`);
    }
  });

  it('splits on commas, trims whitespace, and drops empty entries silently', () => {
    expect(
      loadConfig({ ...base, OPPORTUN_TRUSTED_PROXIES: ' 10.0.0.1 , 10.0.0.2' }).trustedProxies,
    ).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(
      loadConfig({ ...base, OPPORTUN_TRUSTED_PROXIES: '10.0.0.1,,10.0.0.2,' }).trustedProxies,
    ).toEqual(['10.0.0.1', '10.0.0.2']);
  });
});
