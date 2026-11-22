// The routes reach the users and jobs tables only through their repos
// (https://github.com/bgoleno/opportun/issues/766; docs/architecture.md 6.2): repos/users.ts and
// repos/jobs.ts. A route that imports either table from the schema fails this test.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROUTES = fileURLToPath(new URL('../src/routes', import.meta.url));
const TABLES = ['users', 'jobs'];

/** The names a file imports from db/schema, from any number of import statements. */
function schemaImports(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(
    /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"][./]*db\/schema['"]/g,
  )) {
    for (const part of m[1]!.split(',')) {
      const name = part
        .replace(/^\s*type\s+/, '')
        .split(/\s+as\s+/)[0]!
        .trim();
      if (name.length > 0) names.push(name);
    }
  }
  return names;
}

describe('no route queries users or jobs directly (#766)', () => {
  it('no file under src/routes imports either table from the schema', async () => {
    const offenders: string[] = [];
    for (const name of await readdir(ROUTES, { recursive: true })) {
      if (!/\.tsx?$/.test(name)) continue;
      const text = await readFile(join(ROUTES, name), 'utf8');
      for (const imported of schemaImports(text)) {
        if (TABLES.includes(imported)) offenders.push(`${name}: ${imported}`);
      }
      if (/import\s*\*\s*as\s+\w+\s*from\s*['"][./]*db\/schema['"]/.test(text)) {
        offenders.push(`${name}: * from db/schema`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the check sees a table imported among others', () => {
    expect(schemaImports("import { auditLog, users } from '../db/schema';")).toContain('users');
    expect(schemaImports("import { JOB_STATUSES } from '../db/schema';")).not.toContain('jobs');
  });
});
