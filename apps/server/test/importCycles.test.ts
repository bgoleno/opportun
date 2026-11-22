// The server's runtime import graph has no cycle through the files of the jobs/repos and the mail
// and rejects groups that docs/architecture.md section 6.1 found
// (https://github.com/bgoleno/opportun/issues/763). It is the doc's own check, in the repository:
// every static `import`/`export … from` and every `import()` in apps/server/src, read with the
// TypeScript parser. A type-only import or export is left out, since it is erased at build time
// and so is no runtime edge. The groups are found as strongly connected components (Tarjan).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '../src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

/** The module specifiers a file depends on at run time. */
function runtimeSpecifiers(text: string): string[] {
  const file = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, false);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      // `import type …`, or `import { type A, type B }` with nothing else: erased.
      const typeOnly =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.name === undefined &&
            named !== undefined &&
            ts.isNamedImports(named) &&
            named.elements.length > 0 &&
            named.elements.every((e) => e.isTypeOnly)));
      if (!typeOnly) out.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !node.isTypeOnly
    ) {
      out.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

/** The runtime edges between files under src, by path relative to it. */
function importGraph(): Map<string, Set<string>> {
  const files = new Set(sourceFiles(SRC).map((f) => relative(SRC, f)));
  const graph = new Map<string, Set<string>>();
  for (const rel of files) {
    const targets = new Set<string>();
    for (const spec of runtimeSpecifiers(readFileSync(join(SRC, rel), 'utf8'))) {
      if (!spec.startsWith('.')) continue;
      const base = normalize(join(dirname(rel), spec)).replace(/\.js$/, '');
      const hit = [`${base}.ts`, join(base, 'index.ts')].find((c) => files.has(c));
      if (hit !== undefined) targets.add(hit);
    }
    graph.set(rel, targets);
  }
  return graph;
}

/** The graph's strongly connected components with more than one file (its import cycles). */
function cycles(graph: Map<string, Set<string>>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const out: string[][] = [];
  let next = 0;
  const connect = (v: string): void => {
    index.set(v, next);
    low.set(v, next);
    next += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) {
        connect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1) out.push(component.sort());
    }
  };
  for (const v of graph.keys()) if (!index.has(v)) connect(v);
  return out;
}

// Cycles 2 and 3 of docs/architecture.md section 6.1, at main 90d1565.
const JOBS_AND_REPOS = [
  'jobs/atsDetect.ts',
  'jobs/companyDomainResolve.ts',
  'jobs/leadResolve.ts',
  'jobs/opportunityEnrich.ts',
  'lib/atsJobRef.ts',
  'repos/discovery.ts',
  'repos/opportunities.ts',
  'repos/opportunityDedupe.ts',
  'repos/submissionReview.ts',
  'repos/submissions.ts',
];
const MAIL_AND_REJECTS = [
  'adapters/sources/alertEmail.ts',
  'jobs/mailIngest.ts',
  'repos/communications.ts',
  'repos/reject.ts',
  'repos/submissionConfirm.ts',
];

describe('the server import graph (#763, docs/architecture.md 6.1)', () => {
  const graph = importGraph();
  const found = cycles(graph);

  it('reads the files it names', () => {
    for (const file of [...JOBS_AND_REPOS, ...MAIL_AND_REJECTS]) expect(graph.has(file)).toBe(true);
  });

  it('sees a cycle when there is one (the check itself)', () => {
    const loop = new Map([
      ['a.ts', new Set(['b.ts'])],
      ['b.ts', new Set(['a.ts'])],
      ['c.ts', new Set(['a.ts'])],
    ]);
    expect(cycles(loop)).toEqual([['a.ts', 'b.ts']]);
  });

  it('leaves type-only imports out, and keeps import() and re-exports', () => {
    expect(
      runtimeSpecifiers(
        [
          "import type { A } from './typeOnly';",
          "import { type B } from './inlineTypeOnly';",
          "import { type C, d } from './mixed';",
          "export type { E } from './typeReexport';",
          "export { f } from './reexport';",
          "const g = () => import('./dynamic');",
        ].join('\n'),
      ),
    ).toEqual(['./mixed', './reexport', './dynamic']);
  });

  it('has no cycle through the jobs and repos group', () => {
    const through = found.filter((c) => c.some((f) => JOBS_AND_REPOS.includes(f)));
    expect(through).toEqual([]);
  });

  it('has no cycle through the mail and rejects group', () => {
    const through = found.filter((c) => c.some((f) => MAIL_AND_REJECTS.includes(f)));
    expect(through).toEqual([]);
  });
});
