// The identifier guard (.github/workflows/identifier-guard.yml), https://github.com/bgoleno/opportun/issues/520.
// Its job log is public. Actions masks the BLOCKED_IDENTIFIERS secret's whole value, but not a
// single term inside it, so a hit that echoed the term or the matching lines published a withheld
// name. This runs the workflow's own scan step, as written, against a throwaway repository and
// reads what the log would show.
//
// The terms here are made up: no real withheld term appears in this file, its fixtures or its
// output.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const WORKFLOW = readFileSync(join(ROOT, '.github', 'workflows', 'identifier-guard.yml'), 'utf8');

/** The `run: |` block of the step named `name`, dedented, as the runner passes it to bash. */
function stepScript(workflow: string, name: string): string {
  const lines = workflow.split('\n');
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  if (start < 0) throw new Error(`no step named ${name}`);
  const run = lines.findIndex((l, i) => i > start && /^\s+run: \|\s*$/.test(l));
  if (run < 0) throw new Error(`step ${name} has no run block`);
  const [runLine, ...after] = lines.slice(run);
  const keyIndent = runLine!.search(/\S/);
  const body: string[] = [];
  for (const line of after) {
    if (line.trim() !== '' && line.search(/\S/) <= keyIndent) break;
    body.push(line);
  }
  const indent = Math.min(...body.filter((l) => l.trim() !== '').map((l) => l.search(/\S/)));
  return body.map((l) => l.slice(indent)).join('\n');
}

const SCAN = stepScript(WORKFLOW, 'Scan for withheld identifiers');

/** Two made-up terms: one letters-only (word-boundary match), one with digits (literal match). */
const TERMS = ['zorblaxian', 'qx7-vantor'];

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

/** A repository with `files` committed, and the scan step run in it with `terms` as the secret. */
function scan(files: Record<string, string>, terms: string) {
  const dir = mkdtempSync(join(tmpdir(), 'identifier-guard-'));
  dirs.push(dir);
  git(dir, 'init', '-q');
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
  git(dir, 'add', '.');
  const r = spawnSync('bash', ['-e', '-c', SCAN], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: dir, TERMS: terms },
  });
  return { status: r.status, lines: `${r.stdout}${r.stderr}`.split('\n') };
}

const MASK = /^::add-mask::/;

describe('the identifier guard does not publish a withheld term (#520)', () => {
  const tree = {
    'notes.txt': ['first line', `about ${TERMS[0]} and the-rest-of-this-line`, 'last'].join('\n'),
    [`${TERMS[1]}.md`]: `ref ${TERMS[1]} here\n`,
    'clean.txt': 'nothing to see\n',
  };

  it('a hit fails the job and names each place as file:line', () => {
    const { status, lines } = scan(tree, TERMS.join(' '));
    expect(status).toBe(1);
    const log = lines.filter((l) => !MASK.test(l)).join('\n');
    expect(log).toContain('notes.txt:2');
    // The file whose name is the second term: its location is printed, and the runner masks the
    // term inside it (registered first, below).
    expect(log).toMatch(/\.md:1/);
  });

  it('every term is registered with ::add-mask:: before anything else is printed', () => {
    const { lines } = scan(tree, TERMS.join(' '));
    const firstOther = lines.findIndex((l) => l.trim() !== '' && !MASK.test(l));
    const masks = lines
      .slice(0, firstOther < 0 ? lines.length : firstOther)
      .filter((l) => MASK.test(l));
    expect(masks.sort()).toEqual(TERMS.map((t) => `::add-mask::${t}`).sort());
    expect(lines.filter((l) => MASK.test(l))).toHaveLength(TERMS.length);
  });

  it('prints no term and no matching line, outside the masking commands', () => {
    const { lines } = scan(tree, TERMS.join(' '));
    const log = lines.filter((l) => !MASK.test(l)).join('\n');
    // A file name that holds a term is the runner's to mask; the step itself never echoes one.
    const printedOutsidePaths = log.replace(/\S+:\d+/g, '');
    for (const term of TERMS) expect(printedOutsidePaths.toLowerCase()).not.toContain(term);
    expect(log).not.toContain('the-rest-of-this-line');
    expect(log).not.toContain('about');
  });

  it('the step never traces its commands, which would echo each term as it is used', () => {
    const commands = SCAN.split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(commands).not.toMatch(/\bset\s+-[a-wyz]*x|set\s+-o\s+xtrace|\bbash\s+-[a-z]*x/);
  });

  it('a clean tree passes and prints no term', () => {
    const { status, lines } = scan({ 'clean.txt': 'nothing to see\n' }, TERMS.join('\n'));
    expect(status).toBe(0);
    const log = lines.filter((l) => !MASK.test(l)).join('\n');
    expect(log).toContain('Identifier guard: clean.');
    for (const term of TERMS) expect(log).not.toContain(term);
  });
});
