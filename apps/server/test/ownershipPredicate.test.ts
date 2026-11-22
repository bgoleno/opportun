// Every repo's per-user ownership predicate goes through repos/base.ts's ownedBy, or ownedSql for
// hand-written SQL (https://github.com/bgoleno/opportun/issues/768; docs/architecture.md 8.1), so
// a later tenancy change adds its second scope key in one place. This fails on an inline one.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPOS = fileURLToPath(new URL('../src/repos', import.meta.url));

/** Not per-user ownership, and why. */
const EXEMPT = new Map([
  ['base.ts', 'defines the helpers'],
  // Reads an account by its id: at sign-in, before there is a session, and on the admin screens,
  // which read other accounts. The caller's own row goes through ownedBy(users.id, ctx) elsewhere.
  ['users.ts', 'account lookups by id'],
]);

/** An inline per-user filter: on a userId column, on users.id, or on user_id in raw SQL. */
const INLINE = [
  /\beq\(\s*[\w.]+\.userId\s*,/,
  /\beq\(\s*users\.id\s*,\s*ctx\./,
  /\buser_id\s*=\s*\$\{/,
];

describe('repo queries filter on their owner through ownedBy (#768)', () => {
  it('no repo outside the exemptions writes the ownership predicate inline', async () => {
    const offenders: string[] = [];
    for (const name of await readdir(REPOS)) {
      if (!name.endsWith('.ts') || EXEMPT.has(name)) continue;
      const lines = (await readFile(join(REPOS, name), 'utf8')).split('\n');
      lines.forEach((line, i) => {
        if (INLINE.some((re) => re.test(line))) offenders.push(`${name}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the check sees each inline form', () => {
    expect(INLINE.some((re) => re.test('.where(eq(opportunities.userId, ctx.userId))'))).toBe(true);
    expect(INLINE.some((re) => re.test('.where(eq(users.id, ctx.userId))'))).toBe(true);
    expect(INLINE.some((re) => re.test('WHERE a.user_id = ${ctx.userId}'))).toBe(true);
    expect(INLINE.some((re) => re.test('.where(ownedBy(opportunities.userId, ctx))'))).toBe(false);
  });
});
