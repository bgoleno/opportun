// The environment readers that moved into config.ts (https://github.com/bgoleno/opportun/issues/773):
// each keeps its variable's name, default and validation exactly as it had where it was read
// before. Every reader takes the environment as a parameter, so these tests pass literal objects
// and never touch the real process.env, which vitest's threads pool shares across files (#292).
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  aiLoopbackHttpAllowed,
  jobWorkersSetting,
  loadConfig,
  loadDataDir,
  logLevelSetting,
  operatorEnv,
  schemaDialect,
} from '../src/config';

const base = {
  OPPORTUN_MASTER_KEY: randomBytes(32).toString('hex'),
  OPPORTUN_BASE_URL: 'https://opportun.example.com',
};

describe('DATA_DIR (the CLIs and loadConfig, #773)', () => {
  it("is './data' when unset or empty, resolved, as loadConfig has it", () => {
    for (const env of [{}, { DATA_DIR: '' }]) {
      expect(loadDataDir(env)).toBe(resolve('./data'));
      expect(loadDataDir(env)).toBe(loadConfig({ ...base, ...env }).dataDir);
    }
  });

  it('is the value given, resolved', () => {
    expect(loadDataDir({ DATA_DIR: 'rel/dir' })).toBe(resolve('rel/dir'));
    expect(loadDataDir({ DATA_DIR: '/srv/opportun' })).toBe(
      loadConfig({ ...base, DATA_DIR: '/srv/opportun' }).dataDir,
    );
  });
});

describe('OPPORTUN_JOB_WORKERS (jobs/runner.ts, #773)', () => {
  it('is unset (the runner then uses its default) when absent or blank', () => {
    expect(jobWorkersSetting({})).toBeUndefined();
    expect(jobWorkersSetting({ OPPORTUN_JOB_WORKERS: '  ' })).toBeUndefined();
  });

  it('is a whole number of at least one', () => {
    expect(jobWorkersSetting({ OPPORTUN_JOB_WORKERS: '6' })).toBe(6);
    expect(jobWorkersSetting({ OPPORTUN_JOB_WORKERS: '1' })).toBe(1);
  });

  it('is unset for a value that is not one', () => {
    for (const bad of ['0', '-2', '1.5', 'four', '1e400']) {
      expect(jobWorkersSetting({ OPPORTUN_JOB_WORKERS: bad }), bad).toBeUndefined();
    }
  });
});

describe('LOG_LEVEL for the process logger (obs/log.ts, #773)', () => {
  it("is 'info' when unset", () => {
    expect(logLevelSetting({})).toBe('info');
  });

  it('is passed through unchecked, as before (loadConfig checks it for the app)', () => {
    expect(logLevelSetting({ LOG_LEVEL: 'debug' })).toBe('debug');
    expect(logLevelSetting({ LOG_LEVEL: 'not-a-level' })).toBe('not-a-level');
    expect(logLevelSetting({ LOG_LEVEL: '' })).toBe('');
  });
});

describe('DB_DIALECT for the schema (db/schema.ts, #773)', () => {
  it('is sqlite when unset, and postgres when set so', () => {
    expect(schemaDialect({})).toBe('sqlite');
    expect(schemaDialect({ DB_DIALECT: 'postgres' })).toBe('postgres');
  });

  it('refuses another value, as parseDbDialect does', () => {
    expect(() => schemaDialect({ DB_DIALECT: 'mysql' })).toThrow();
  });
});

describe('the AI settings lib/ai.ts reads (#773)', () => {
  it("allows loopback http only for '1', as loadConfig does", () => {
    expect(aiLoopbackHttpAllowed({})).toBe(false);
    expect(aiLoopbackHttpAllowed({ OPPORTUN_AI_ALLOW_LOOPBACK_HTTP: 'true' })).toBe(false);
    expect(aiLoopbackHttpAllowed({ OPPORTUN_AI_ALLOW_LOOPBACK_HTTP: '1' })).toBe(true);
    expect(aiLoopbackHttpAllowed({ ...base, OPPORTUN_AI_ALLOW_LOOPBACK_HTTP: '1' })).toBe(
      loadConfig({ ...base, OPPORTUN_AI_ALLOW_LOOPBACK_HTTP: '1' }).aiAllowLoopbackHttp,
    );
  });

  it('hands on the two operator base URL variables and nothing else', () => {
    expect(
      operatorEnv({
        ANTHROPIC_BASE_URL: 'https://a.example',
        OPENAI_BASE_URL: 'https://o.example',
        OPPORTUN_MASTER_KEY: 'not handed on',
      }),
    ).toEqual({ ANTHROPIC_BASE_URL: 'https://a.example', OPENAI_BASE_URL: 'https://o.example' });
  });
});
