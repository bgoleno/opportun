// The device token never reaches a page (sec on https://github.com/bgoleno/opportun/issues/182):
// only the popup sends it, to the Opportun server. A token may carry both capture:push and
// apply:assist, which raises the cost of a leak.
//
// What this checks, by parsing every source file under src/ (recursively) with TypeScript's own
// parser, for every `executeScript({ ... })` call:
// - `args` is an array literal written in the call (anything else fails: it cannot be checked);
// - each element, or, for a plain identifier, the initializer of the variable it names in that
//   file, contains nothing token-like (the token, the settings that hold it, an auth header);
// - the injected `func`, found by name among the source files' function declarations, never
//   mentions a token or an auth header.
// A filler added later (#183) is covered without changing this test. What it cannot see: a value
// passed through a chain of variables or function calls; keep injected args to a literal built
// in place from named fields.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
const TOKENISH = /token|settings|authorization|bearer|odt_/i;
const FUNC_TOKENISH = /token|authorization|bearer|odt_/i;

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

interface Injection {
  file: string;
  args: ts.Expression | undefined;
  func: string | undefined;
  source: ts.SourceFile;
}

async function parse(): Promise<{ injections: Injection[]; functions: Map<string, string> }> {
  const injections: Injection[] = [];
  const functions = new Map<string, string>();
  for (const file of await sourceFiles(SRC)) {
    const source = ts.createSourceFile(
      file,
      await readFile(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    walk(source, (n) => {
      if (ts.isFunctionDeclaration(n) && n.name !== undefined) {
        functions.set(n.name.text, n.getText(source));
      }
      if (!ts.isCallExpression(n) || !n.expression.getText(source).endsWith('executeScript'))
        return;
      const options = n.arguments[0];
      if (options === undefined || !ts.isObjectLiteralExpression(options)) return;
      const prop = (name: string) =>
        options.properties.find(
          (p): p is ts.PropertyAssignment =>
            ts.isPropertyAssignment(p) && p.name.getText(source) === name,
        )?.initializer;
      const func = prop('func');
      injections.push({
        file,
        args: prop('args'),
        func: func !== undefined && ts.isIdentifier(func) ? func.text : undefined,
        source,
      });
    });
  }
  return { injections, functions };
}

/** The initializer text of the variable `name` declared in `source`, if there is one. */
function initializerOf(source: ts.SourceFile, name: string): string | undefined {
  let found: string | undefined;
  walk(source, (n) => {
    if (
      found === undefined &&
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      n.initializer !== undefined
    ) {
      found = n.initializer.getText(source);
    }
  });
  return found;
}

describe('the device token never goes into the page', () => {
  it('every injection passes literal args with nothing token-like in them', async () => {
    const { injections } = await parse();
    const withArgs = injections.filter((i) => i.args !== undefined);
    // Not hollow: the LinkedIn and Indeed readers are both injected with args.
    expect(withArgs.length).toBeGreaterThanOrEqual(2);
    for (const { file, args, source } of withArgs) {
      expect(ts.isArrayLiteralExpression(args!), `${file}: args must be a literal array`).toBe(
        true,
      );
      for (const element of (args as ts.ArrayLiteralExpression).elements) {
        const text = ts.isIdentifier(element)
          ? `${element.text} = ${initializerOf(source, element.text) ?? ''}`
          : element.getText(source);
        expect(text, `${file}: ${text}`).not.toMatch(TOKENISH);
      }
    }
  });

  it('every function injected into the page is found, and never mentions a token', async () => {
    const { injections, functions } = await parse();
    const funcs = injections.map((i) => i.func).filter((f): f is string => f !== undefined);
    expect(funcs).toEqual(expect.arrayContaining(['extractPage', 'extractIndeedJob']));
    for (const name of funcs) {
      const body = functions.get(name);
      expect(body, `the injected function ${name} is declared in src`).toBeDefined();
      expect(body, name).not.toMatch(FUNC_TOKENISH);
    }
  });
});
