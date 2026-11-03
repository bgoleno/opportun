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
//   mentions a token or an auth header;
// - the options argument is an object literal, and `func` a bare identifier (sec's point on
//   https://github.com/bgoleno/opportun/pull/185, taken in #183): anything else fails, because
//   it cannot be checked. "A literal or it fails" holds for func as it does for args.
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
  /** Why this call cannot be checked, which fails it; undefined when it can be. */
  unreadable?: string;
}

/** The injections and named function declarations in one source text. */
function parseSource(
  file: string,
  text: string,
): { injections: Injection[]; functions: Map<string, string> } {
  const injections: Injection[] = [];
  const functions = new Map<string, string>();
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  walk(source, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name !== undefined) {
      functions.set(n.name.text, n.getText(source));
    }
    if (!ts.isCallExpression(n) || !n.expression.getText(source).endsWith('executeScript')) return;
    const options = n.arguments[0];
    if (options === undefined || !ts.isObjectLiteralExpression(options)) {
      injections.push({
        file,
        args: undefined,
        func: undefined,
        source,
        unreadable: `options must be an object literal: ${n.getText(source)}`,
      });
      return;
    }
    const prop = (name: string) =>
      options.properties.find(
        (p): p is ts.PropertyAssignment =>
          ts.isPropertyAssignment(p) && p.name.getText(source) === name,
      )?.initializer;
    const func = prop('func');
    const funcOk = func === undefined || ts.isIdentifier(func);
    injections.push({
      file,
      args: prop('args'),
      func: func !== undefined && ts.isIdentifier(func) ? func.text : undefined,
      source,
      ...(funcOk ? {} : { unreadable: `func must be a bare identifier: ${func.getText(source)}` }),
    });
  });
  return { injections, functions };
}

async function parse(): Promise<{ injections: Injection[]; functions: Map<string, string> }> {
  const injections: Injection[] = [];
  const functions = new Map<string, string>();
  for (const file of await sourceFiles(SRC)) {
    const one = parseSource(file, await readFile(file, 'utf8'));
    injections.push(...one.injections);
    for (const [name, body] of one.functions) functions.set(name, body);
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
  it('every executeScript call can be read: an object literal, with a bare func', async () => {
    const { injections } = await parse();
    for (const i of injections) expect(i.unreadable, i.file).toBeUndefined();
  });

  it('every injection passes literal args with nothing token-like in them', async () => {
    const { injections } = await parse();
    const withArgs = injections.filter((i) => i.args !== undefined);
    // Not hollow (sec on #187): the LinkedIn and Indeed readers and the prefill filler are all
    // found and checked; a parser that stopped finding calls would fail here.
    expect(withArgs.length).toBeGreaterThanOrEqual(3);
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
    // The prefill filler (#183) is injected too, and checked like the readers.
    expect(funcs).toEqual(
      expect.arrayContaining(['extractPage', 'extractIndeedJob', 'fillGreenhouseForm']),
    );
    for (const name of funcs) {
      const body = functions.get(name);
      expect(body, `the injected function ${name} is declared in src`).toBeDefined();
      expect(body, name).not.toMatch(FUNC_TOKENISH);
    }
  });
});

describe('the scan fails what it cannot read (sec on #185, taken in #183)', () => {
  const bad = (text: string) => parseSource('bad.ts', text).injections;

  it('an options argument that is not an object literal is unreadable', () => {
    for (const call of [
      'chrome.scripting.executeScript(injection);',
      'chrome.scripting.executeScript(make());',
    ]) {
      const [i] = bad(call);
      expect(i?.unreadable).toMatch(/options must be an object literal/);
    }
  });

  it('a func that is not a bare identifier is unreadable', () => {
    for (const func of ['() => document.title', 'mod.fill', 'function () { return 1; }']) {
      const [i] = bad(
        `chrome.scripting.executeScript({ target: { tabId: 1 }, func: ${func}, args: [] });`,
      );
      expect(i?.unreadable, func).toMatch(/func must be a bare identifier/);
    }
  });

  // tl's point 8(a) on #187 and sec's planted call: every way of writing a call that the scan
  // cannot read must fail, never pass by being skipped.
  const BAD: [string, string][] = [
    [
      "sec's plant: args by shorthand, carrying a token",
      'const args = [plan, "SENTINEL-token"];\nchrome.scripting.executeScript({ target: { tabId }, func: fill, args });',
    ],
    [
      'func by shorthand',
      'chrome.scripting.executeScript({ target: { tabId }, func, args: [plan] });',
    ],
    ['options spread in', 'chrome.scripting.executeScript({ ...opts, func: fill, args: [plan] });'],
    [
      'a quoted key',
      "chrome.scripting.executeScript({ target: { tabId }, 'func': fill, args: [plan] });",
    ],
    [
      'a computed key',
      "chrome.scripting.executeScript({ target: { tabId }, ['args']: [plan], func: fill });",
    ],
    [
      'element access',
      "chrome.scripting['executeScript']({ target: { tabId }, func: fill, args: [plan] });",
    ],
    [
      'an alias',
      'const run = chrome.scripting.executeScript;\nrun({ target: { tabId }, func: fill, args: [plan] });',
    ],
    [
      'a destructured alias',
      'const { executeScript } = chrome.scripting;\nexecuteScript({ target: { tabId }, func: fill, args: [plan] });',
    ],
    [
      '.call',
      'chrome.scripting.executeScript.call(chrome.scripting, { target: { tabId }, func: fill, args: [plan] });',
    ],
    [
      'Reflect.apply',
      'Reflect.apply(chrome.scripting.executeScript, chrome.scripting, [{ target: { tabId }, func: fill, args: [plan] }]);',
    ],
    ['no args at all', 'chrome.scripting.executeScript({ target: { tabId }, func: fill });'],
    [
      'args spread from elsewhere',
      'chrome.scripting.executeScript({ target: { tabId }, func: fill, args: [...more] });',
    ],
    [
      'a file injected instead of a function',
      "chrome.scripting.executeScript({ target: { tabId }, files: ['x.js'], args: [] });",
    ],
    [
      'a world option',
      'chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: fill, args: [plan] });',
    ],
    [
      'every frame',
      'chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: fill, args: [plan] });',
    ],
    [
      'named frames',
      'chrome.scripting.executeScript({ target: { tabId, frameIds: [3] }, func: fill, args: [plan] });',
    ],
    [
      'a second options argument',
      'chrome.scripting.executeScript({ target: { tabId }, func: fill, args: [plan] }, extra);',
    ],
  ];

  for (const [what, source] of BAD) {
    it(`fails ${what}`, () => {
      const found = bad(source);
      expect(found.length, what).toBeGreaterThan(0);
      expect(
        found.some((i) => i.unreadable !== undefined),
        `${what}: ${JSON.stringify(found.map((i) => i.unreadable ?? i.func))}`,
      ).toBe(true);
    });
  }

  it('the type signature of executeScript is the one other place the name may appear', () => {
    const found = bad(
      'interface Api { scripting: { executeScript<A>(injection: { func: () => void; args: A }): Promise<void> } }',
    );
    expect(found).toEqual([]);
  });

  it('a readable call is not flagged', () => {
    const [i] = bad(
      'chrome.scripting.executeScript({ target: { tabId: 1 }, func: fill, args: [plan] });',
    );
    expect(i?.unreadable).toBeUndefined();
    expect(i?.func).toBe('fill');
  });
});
