// The image's PostgreSQL apt key (PGDG) comes from the repository, never from postgresql.org at
// build time (https://github.com/bgoleno/opportun/issues/438), and it is checked against a
// fingerprint a build argument cannot change (https://github.com/bgoleno/opportun/issues/442).
//
// The packages themselves still come from PGDG's apt repository (apt.postgresql.org), verified by
// apt against that key: that one source line is the only postgresql.org address allowed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const DOCKERFILE = readFileSync(join(ROOT, 'deploy', 'Dockerfile'), 'utf8');

/** The PGDG key's fingerprint, as postgresql.org publishes it (deploy/pgdg-ACCC4CF8.asc). */
const FINGERPRINT = 'B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8';

/** The Dockerfile's instructions, comments dropped and continuation lines joined. */
function instructions(text: string): string[] {
  const lines = text.split('\n').filter((l) => !/^\s*#/.test(l));
  return lines
    .join('\n')
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

/** The instructions of one build stage, from its FROM to the next. */
function stage(name: string): string[] {
  const all = instructions(DOCKERFILE);
  const start = all.findIndex(
    (l) => /^FROM /i.test(l) && l.toLowerCase().endsWith(` as ${name.toLowerCase()}`),
  );
  if (start === -1) throw new Error(`no stage ${name}`);
  const end = all.findIndex((l, i) => i > start && /^FROM /i.test(l));
  return all.slice(start, end === -1 ? undefined : end);
}

const PGDG_APT = 'https://apt.postgresql.org/pub/repos/apt';

/** Every http(s) address in a piece of text. */
const urlsIn = (text: string): string[] => text.match(/https?:\/\/[^\s"'`]+/g) ?? [];

/** Whether an address is on postgresql.org or one of its subdomains, by its host. */
function onPostgresqlOrg(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return host === 'postgresql.org' || host.endsWith('.postgresql.org');
}

describe('the image gets nothing from postgresql.org but its apt packages (#442)', () => {
  it('names no postgresql.org address except the apt repository, in its source line', () => {
    for (const line of instructions(DOCKERFILE)) {
      for (const url of urlsIn(line).filter(onPostgresqlOrg)) {
        expect(url, line).toBe(PGDG_APT);
        expect(line, url).toContain('deb [signed-by=/usr/share/keyrings/pgdg.asc]');
      }
    }
  });

  it('never downloads with curl, wget or ADD from postgresql.org', () => {
    for (const line of instructions(DOCKERFILE)) {
      // One shell command at a time: the runtime's RUN installs curl and, later in the same
      // line, writes the apt source, which is not a download by curl.
      for (const command of line.split(/&&|\|\||;|\|/)) {
        const fetcher = /\b(curl|wget)\b/.test(command) || /^ADD\s/i.test(command.trim());
        if (fetcher) expect(urlsIn(command).filter(onPostgresqlOrg), command).toEqual([]);
      }
    }
  });
});

describe('the PGDG key check cannot be changed by a build argument (#442)', () => {
  it('has no PGDG_FINGERPRINT argument', () => {
    expect(instructions(DOCKERFILE).filter((l) => /^ARG\s+PGDG/i.test(l))).toEqual([]);
  });

  it('the verifying RUN line holds the fingerprint itself', () => {
    const run = stage('pgdg-key').filter((l) => /^RUN /.test(l));
    expect(run).toHaveLength(1);
    expect(run[0]).toContain(`"${FINGERPRINT}"`);
    expect(run[0]).not.toMatch(/\$\{?PGDG_FINGERPRINT/);
  });
});
