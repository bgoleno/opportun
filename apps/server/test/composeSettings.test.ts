// deploy/compose.yml passes the server the settings docs/install.md section 4 documents
// (https://github.com/bgoleno/opportun/issues/417). Compose reads deploy/.env only to fill in
// ${...} inside compose.yml; it does not hand the file to the container. So a documented setting
// that compose.yml does not list never reaches the server when it is written in deploy/.env,
// and nothing says so. This test fails when a setting section 4 documents is neither passed by
// compose.yml nor named below as deliberately not passed, with the reason.
//
// A second test shows that what compose.yml passes as `${VAR:-}` (an empty string when VAR is
// unset) is read by the server exactly as if VAR were not set at all, which is the promise that
// passing it changes no default.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { operatorBaseUrls } from '../src/lib/aiProviderFetch';

const ROOT = join(__dirname, '..', '..', '..');
const COMPOSE = readFileSync(join(ROOT, 'deploy', 'compose.yml'), 'utf8');
const INSTALL = readFileSync(join(ROOT, 'docs', 'install.md'), 'utf8');

/**
 * Documented in section 4 and not passed to the container by compose.yml, each with why. Adding
 * a setting here is a decision: say why a user who writes it in deploy/.env should not get it.
 */
const NOT_PASSED: ReadonlyMap<string, string> = new Map([
  [
    'OPPORTUN_MASTER_KEY',
    'compose passes OPPORTUN_MASTER_KEY_FILE=/data/master.key, and an inline key would take ' +
      'precedence over that file',
  ],
  [
    'OPPORTUN_HOST',
    'the image sets 0.0.0.0 so Caddy can reach the app; an empty value is read as loopback, ' +
      'not as unset',
  ],
  [
    'WEB_DIR',
    "the image sets the built web app's path; an empty value falls back to a source-tree path " +
      'that does not exist in the image',
  ],
  ['SMTP_URL', 'reserved: nothing reads it yet (install.md says email reset is not implemented)'],
  [
    'OPPORTUN_DEMO',
    'compose.demo.yml passes it on purpose; a household deployment must not pick it up from a ' +
      'stray line in a copied .env',
  ],
]);

/** Variables Compose itself reads from .env or the shell, never from compose.yml. */
const READ_BY_COMPOSE: ReadonlySet<string> = new Set(['COMPOSE_PROFILES']);

const NAME = /^[A-Z][A-Z0-9_]*$/;

/** The names in the first column of every table row of section 4 of install.md. */
function documentedSettings(): string[] {
  const start = INSTALL.indexOf('## 4. Configuration reference');
  const end = INSTALL.indexOf('\n## 5. ', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const names: string[] = [];
  for (const line of INSTALL.slice(start, end).split('\n')) {
    if (!line.startsWith('| `')) continue;
    const firstCell = line.split('|')[1] ?? '';
    for (const m of firstCell.matchAll(/`([^`]+)`/g)) {
      const name = m[1] ?? '';
      if (NAME.test(name)) names.push(name);
    }
  }
  return names;
}

/** The `environment:` of the opportun service as written, name to value. */
function opportunEnvironment(): Map<string, string> {
  const lines = COMPOSE.split('\n');
  const service = lines.findIndex((l) => l === '  opportun:');
  expect(service).toBeGreaterThan(-1);
  const env = lines.findIndex((l, i) => i > service && l === '    environment:');
  expect(env).toBeGreaterThan(service);
  const out = new Map<string, string>();
  for (const line of lines.slice(env + 1)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    // The block ends at the first line indented less than its entries.
    if (!line.startsWith('      ')) break;
    const m = /^ {6}([A-Za-z0-9_]+): (.*)$/.exec(line);
    if (m !== null) out.set(m[1] ?? '', (m[2] ?? '').trim());
  }
  return out;
}

/** Every variable compose.yml substitutes from .env, anywhere in the file. */
function substituted(): Set<string> {
  return new Set([...COMPOSE.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((m) => m[1] ?? ''));
}

describe('compose.yml passes the documented settings (issue 417)', () => {
  const documented = documentedSettings();
  const env = opportunEnvironment();
  const used = substituted();

  it('reads the tables of section 4', () => {
    // A parse that found nothing would make every check below pass for the wrong reason.
    expect(documented).toContain('OPPORTUN_BASE_URL');
    expect(documented).toContain('OPPORTUN_DOMAIN');
    expect(documented.length).toBeGreaterThan(20);
  });

  it('passes each documented setting or names it as not passed', () => {
    const missing = documented.filter(
      (name) =>
        !env.has(name) && !used.has(name) && !READ_BY_COMPOSE.has(name) && !NOT_PASSED.has(name),
    );
    expect(
      missing,
      'documented in docs/install.md section 4 but neither passed by deploy/compose.yml ' +
        '(as `NAME: ${NAME:-}` under services.opportun.environment) nor listed in NOT_PASSED ' +
        'with a reason',
    ).toEqual([]);
  });

  it('keeps NOT_PASSED honest: every entry is documented and really not passed', () => {
    for (const name of NOT_PASSED.keys()) {
      expect(documented, `${name} is no longer documented: drop it from NOT_PASSED`).toContain(
        name,
      );
      expect(env.has(name), `${name} is passed now: drop it from NOT_PASSED`).toBe(false);
    }
  });

  it('passes the optional settings a user writes in deploy/.env', () => {
    // The ones issue 417 names, and the pepper rotation, so a later edit cannot drop them quietly.
    for (const name of [
      'OPPORTUN_SUBMISSIONS',
      'OPPORTUN_DAILY_REVIEW_CAP',
      'OPPORTUN_TELEMETRY_ALLOW_PRIVATE',
      'OPPORTUN_AI_ALLOW_LOOPBACK_HTTP',
      'ANTHROPIC_BASE_URL',
      'OPENAI_BASE_URL',
      'DB_POOL_MAX',
      'OPPORTUN_PEPPER_VERSION',
      'OPPORTUN_PEPPER_V1',
    ]) {
      expect(env.get(name), `${name} must be passed as \${${name}:-}`).toBe(`\${${name}:-}`);
    }
  });
});

describe('what compose.yml passes as ${VAR:-} is read as if VAR were unset', () => {
  const env = opportunEnvironment();
  const passedEmpty = [...env.entries()]
    .filter(([name, value]) => value === `\${${name}:-}`)
    .map(([name]) => name);

  // A complete, valid environment, plus a pepper so the pepper variables are read at all.
  const BASE: NodeJS.ProcessEnv = {
    OPPORTUN_MASTER_KEY: 'ab'.repeat(32),
    OPPORTUN_BASE_URL: 'http://localhost:8080',
    OPPORTUN_PEPPER: 'a-fake-pepper-of-sixteen-or-more-characters',
  };

  /** What the server makes of an environment: its config, or the error it stops with. */
  function read(vars: NodeJS.ProcessEnv): unknown {
    try {
      return { config: loadConfig(vars), baseUrls: operatorBaseUrls(vars) };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  it('finds the entries to check', () => {
    expect(passedEmpty).toContain('OPPORTUN_SUBMISSIONS');
    expect(passedEmpty.length).toBeGreaterThan(5);
  });

  it.each(passedEmpty)('%s: empty equals unset', (name) => {
    // The pepper itself is the one variable whose own base entry must not be present.
    const base = name === 'OPPORTUN_PEPPER' ? { ...BASE, OPPORTUN_PEPPER: undefined } : BASE;
    const unset = read({ ...base, [name]: undefined });
    const empty = read({ ...base, [name]: '' });
    expect(empty).toEqual(unset);
  });
});
