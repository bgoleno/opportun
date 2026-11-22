// Which error text reaches the client (https://github.com/bgoleno/opportun/issues/750). The handler
// sends an HttpError's message only when its thrower marks it `userFacing`, and a marked message is
// a sentence written for the person using the app: never another error's text. This test keeps
// that rule true in apps/server/src as throws are added, by reading every `new HttpError(...)`:
// - a marked one must not use `err`, `error`, `cause` or any `.message` in its arguments (sec);
// - none may carry a `message` key in its details, the one way text used to reach the client
//   unmarked (the handler drops it too).
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
const CAUGHT = new Set(['err', 'error', 'cause']);

function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(SRC, f));
}

function isMarked(opts: ts.Expression | undefined): boolean {
  return (
    opts !== undefined &&
    ts.isObjectLiteralExpression(opts) &&
    opts.properties.some(
      (p) =>
        ts.isPropertyAssignment(p) &&
        p.name.getText() === 'userFacing' &&
        p.initializer.kind === ts.SyntaxKind.TrueKeyword,
    )
  );
}

/** What in a marked throw's arguments comes from a caught error. */
function caughtText(node: ts.Node): string[] {
  const found: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'message') found.push(n.getText());
    else if (ts.isIdentifier(n) && CAUGHT.has(n.text)) {
      // A key named `error` in an object literal, or a `.error` property, is not the caught value.
      const parent = n.parent;
      const isKey = ts.isPropertyAssignment(parent) && parent.name === n;
      const isMember = ts.isPropertyAccessExpression(parent) && parent.name === n;
      if (!isKey && !isMember) found.push(n.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

export interface ThrowProblem {
  line: number;
  problem: string;
}

/** Every rule break in one file's `new HttpError(...)` calls, and how many it read. */
export function httpErrorProblems(
  fileName: string,
  text: string,
): { count: number; problems: ThrowProblem[] } {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const problems: ThrowProblem[] = [];
  let count = 0;
  const visit = (n: ts.Node): void => {
    if (ts.isNewExpression(n) && n.expression.getText(sf) === 'HttpError') {
      count += 1;
      const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
      const args = n.arguments ?? [];
      const details = args[3];
      if (
        details !== undefined &&
        ts.isObjectLiteralExpression(details) &&
        details.properties.some((p) => p.name?.getText(sf) === 'message')
      ) {
        problems.push({ line, problem: 'a message key in details' });
      }
      if (isMarked(args[4])) {
        for (const arg of args.slice(0, 4)) {
          for (const t of caughtText(arg)) problems.push({ line, problem: `marked, uses ${t}` });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { count, problems };
}

describe('the checker itself', () => {
  const check = (body: string) => httpErrorProblems('x.ts', body).problems.map((p) => p.problem);

  it('refuses a marked throw that quotes a caught error, however it is written', () => {
    expect(
      check(`
        throw new HttpError(422, 'a', \`Bad: \${err.message}\`, undefined, { userFacing: true });
        throw new HttpError(422, 'b', 'Bad: ' + String(error), undefined, { userFacing: true });
        throw new HttpError(422, 'c', \`\${cause}\`, undefined, { userFacing: true });
        throw new HttpError(422, 'd', e.message, undefined, { userFacing: true });
        throw new HttpError(422, 'e', 'Bad.', { reason: err.reason }, { userFacing: true });
      `),
    ).toEqual([
      'marked, uses err.message',
      'marked, uses err',
      'marked, uses error',
      'marked, uses cause',
      'marked, uses e.message',
      'marked, uses err',
    ]);
  });

  it("accepts a marked sentence that echoes the caller's own values", () => {
    expect(
      check(`
        throw new HttpError(422, 'a', \`Not a sender pattern: \${pattern}\`, undefined, { userFacing: true });
        throw new HttpError(409, 'b', 'Taken.', { error: 'x', existingId: row.id }, { userFacing: true });
      `),
    ).toEqual([]);
  });

  it('leaves an unmarked throw alone, since its message never reaches the client', () => {
    expect(check(`throw new HttpError(500, 'a', err.message);`)).toEqual([]);
  });

  it('refuses a message key in details, marked or not', () => {
    expect(
      check(`
        throw new HttpError(422, 'a', undefined, { message: problem });
        throw new HttpError(422, 'b', 'x', { message }, { userFacing: true });
      `),
    ).toEqual(['a message key in details', 'a message key in details']);
  });
});

describe('every HttpError in apps/server/src keeps the rule (issue 750)', () => {
  it('no marked throw quotes a caught error, and no details carries a message', () => {
    let count = 0;
    const problems: string[] = [];
    for (const file of sourceFiles()) {
      const result = httpErrorProblems(file, readFileSync(file, 'utf8'));
      count += result.count;
      for (const p of result.problems)
        problems.push(`${relative(SRC, file)}:${p.line} ${p.problem}`);
    }
    // A scan that read nothing would pass for the wrong reason.
    expect(count).toBeGreaterThan(150);
    expect(problems).toEqual([]);
  });
});
