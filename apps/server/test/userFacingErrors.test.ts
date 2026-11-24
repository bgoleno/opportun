// Which error text reaches the client (https://github.com/bgoleno/opportun/issues/750). The handler
// sends an HttpError's message only when its thrower marks it `userFacing`, and a marked message is
// a sentence written for the person using the app: never another error's text. This test keeps
// that rule true in apps/server/src as throws are added, by reading every `new HttpError(...)`:
// - a marked one must not use `err`, `error`, `cause` or any `.message` in its arguments (sec);
// - none may carry a `message` key in its details, the one way text used to reach the client
//   unmarked (the handler drops it too);
// - a marked message is a string literal, or an expression on REVIEWED below, each throw listed by
//   its file, code and expression with the reason its text is safe to send (sec on #774, #834): a
//   new one fails here until it is reviewed;
// - no route declares an error schema of its own: routes/common.ts's ErrorResponse keeps a marked
//   sentence, where a schema naming only `code` strips it (#743).
// This is a guard, not the rule's only keeper (tl on #774): it reads each throw's own arguments,
// so it cannot see a message built in a variable from a caught error first, a `catch (e)` passed
// whole, or options that are not written inline. The handler sends only what is marked, and the
// reviewed list says, line by line, where each non-literal sentence comes from.
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

/**
 * Every marked message that is not a string literal, with why its text is safe to send to the
 * person using the app (#750, sec on #774). The key is `<file> <code> <expression>`, the code as
 * it is written: quoted when it is a literal, bare when it is an expression. One entry covers one
 * throw (#834), so a generic name such as `message` never admits a second throw nobody reviewed.
 * Two throws that would need the same key should share one helper.
 *
 * Safe is our own constants, the caller's own input or rows, and our own error classes' authored
 * text; never a provider's, a library's or a caught error's message, and nothing from
 * configuration.
 */
const REVIEWED: Record<string, string> = {
  "lib/demoOwnData.ts 'demo_fixture_value' DEMO_FIXTURE_MESSAGE":
    'a constant sentence in the same file',
  "lib/demoOwnData.ts 'resume_unavailable_on_demo' DEMO_RESUME_MESSAGE":
    'a constant sentence in the same file',
  'lib/postingRederive.ts reason message': 'one of two constant sentences chosen just above',
  "repos/discovery.ts 'invalid_config' message":
    "zod's account of the caller's own source config, capped at 500",
  "repos/discovery.ts 'invalid_cron' problem":
    "userCronProblem's own sentences about the caller's own cron",
  "repos/mailFilters.ts 'invalid_pattern' `Not a sender pattern: ${input.pattern}`":
    "the caller's own pattern",
  "repos/mailFilters.ts 'duplicate' `Already a ${input.effect} rule: ${pattern}`":
    "the caller's own rule effect (an enum) and pattern",
  'repos/profile.ts problem PROFILE_VALUE_MESSAGE': 'a constant sentence in the same file',
  'repos/submissionReview.ts blocked SNAPSHOT_BLOCK_MESSAGES.get(blocked)':
    'a constant map of our own sentences, keyed by our own reason codes',
  'repos/submissions.ts reason INELIGIBLE_MESSAGES.get(reason)':
    'a constant map of our own sentences, keyed by our own reason codes',
  "repos/submissions.ts 'invalid_transition' `This application is ${row.status.replace('_', ' ')}, so it cannot be changed that way.`":
    "the caller's own application's status (an enum)",
  'repos/submissions.ts problem.code FIELD_REFUSAL_MESSAGES[problem.code]':
    'a constant map of our own sentences, never the refused value (submissionDetailFields.test)',
  "routes/communications.ts 'not_confirmed' `Type ${PURGE_CONFIRMATION} to confirm`":
    'a constant word in the same file',
  "routes/importExport.ts 'invalid_pack' problem.userText":
    "PackError text: our own sentences, the uploader's own file names and CsvError text",
  "routes/mailFilters.ts 'not_found' `Not a built-in job sender: ${pattern}`":
    "the caller's own pattern",
};

/** `node` as it is written, on one line. */
function oneLine(sf: ts.SourceFile, node: ts.Node): string {
  return node.getText(sf).replace(/\s+/g, ' ');
}

/** A throw's code: a literal in single quotes, however it was quoted, or the expression. */
function codeText(sf: ts.SourceFile, code: ts.Expression | undefined): string {
  if (code === undefined) return '';
  return ts.isStringLiteralLike(code) ? `'${code.text}'` : oneLine(sf, code);
}

/** Every marked message that is not a string literal, as `<file> <code> <expression>`. */
function nonLiteralMarked(fileName: string, text: string): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isNewExpression(n) && n.expression.getText(sf) === 'HttpError') {
      const args = n.arguments ?? [];
      const message = args[2];
      if (
        isMarked(args[4]) &&
        message !== undefined &&
        !ts.isStringLiteral(message) &&
        !ts.isNoSubstitutionTemplateLiteral(message)
      ) {
        found.push(
          [relative(SRC, fileName), codeText(sf, args[1]), oneLine(sf, message)].join(' '),
        );
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** Where the marked non-literal throws in `sources` and the reviewed entries differ. */
function reviewProblems(
  sources: readonly { file: string; text: string }[],
  reviewed: Readonly<Record<string, string>>,
): { unreviewed: string[]; stale: string[] } {
  const found = sources.flatMap(({ file, text }) => nonLiteralMarked(file, text));
  return {
    // An entry covers the first throw with its key: a second one is unreviewed too.
    unreviewed: found.filter((key, i) => reviewed[key] === undefined || found.indexOf(key) !== i),
    stale: Object.keys(reviewed).filter((key) => !found.includes(key)),
  };
}

const readSources = (): { file: string; text: string }[] =>
  sourceFiles().map((file) => ({ file, text: readFileSync(file, 'utf8') }));

describe('every marked sentence that is not a literal has been reviewed (issue 750, sec on #774)', () => {
  it('each is on REVIEWED, and REVIEWED holds nothing stale', () => {
    expect(Object.keys(REVIEWED).length).toBeGreaterThan(0);
    expect(reviewProblems(readSources(), REVIEWED)).toEqual({ unreviewed: [], stale: [] });
  });

  // The generic names are the ones a later throw is likeliest to reuse (sec on #832).
  describe('a second throw in a listed file is reviewed on its own (issue 834)', () => {
    /** `file` as it is, with one more throw at its end, against the entries REVIEWED has for it. */
    const withThrow = (file: string, thrown: string) => {
      const path = join(SRC, file);
      return reviewProblems(
        [{ file: path, text: `${readFileSync(path, 'utf8')}\nthrow new HttpError(${thrown});\n` }],
        Object.fromEntries(Object.entries(REVIEWED).filter(([key]) => key.startsWith(`${file} `))),
      );
    };
    const MARKED = 'undefined, { userFacing: true }';

    it.each([
      ['repos/discovery.ts', "422, 'other_code', message", "'other_code' message"],
      ['repos/discovery.ts', "422, 'other_code', problem", "'other_code' problem"],
      // Each half is listed, on two different throws; the pair is not.
      ['repos/discovery.ts', "422, 'invalid_cron', message", "'invalid_cron' message"],
      ['lib/postingRederive.ts', "409, 'other_code', message", "'other_code' message"],
      // The literal 'reason' is not the variable `reason`.
      ['lib/postingRederive.ts', "409, 'reason', message", "'reason' message"],
      // The listed throw itself a second time: only the count tells the two apart.
      ['repos/discovery.ts', "422, 'invalid_config', message", "'invalid_config' message"],
      ['lib/postingRederive.ts', '409, reason, message', 'reason message'],
    ])('%s: one more marked throw (%s) is refused', (file, args, key) => {
      expect(withThrow(file, `${args}, ${MARKED}`)).toEqual({
        unreviewed: [`${file} ${key}`],
        stale: [],
      });
    });

    it.each([
      ['unmarked, its message never reaching the client', "422, 'other_code', message"],
      ['with a literal sentence', `422, 'other_code', 'Already taken.', ${MARKED}`],
    ])('one more throw %s needs no review', (_what, thrown) => {
      expect(withThrow('repos/discovery.ts', thrown)).toEqual({ unreviewed: [], stale: [] });
    });

    it('a listed throw whose code changes is unreviewed, and its entry is stale', () => {
      const path = join(SRC, 'repos/discovery.ts');
      const text = readFileSync(path, 'utf8').replaceAll("'invalid_config'", "'renamed'");
      const { unreviewed, stale } = reviewProblems([{ file: path, text }], {
        "repos/discovery.ts 'invalid_config' message": 'x',
        "repos/discovery.ts 'invalid_cron' problem": 'x',
      });
      expect(unreviewed).toEqual(["repos/discovery.ts 'renamed' message"]);
      expect(stale).toEqual(["repos/discovery.ts 'invalid_config' message"]);
    });
  });
});

describe('no route declares an error schema of its own (issue 750, tl on #774)', () => {
  it('routes use routes/common.ts ErrorResponse, which keeps a marked sentence', () => {
    const local = sourceFiles()
      .filter((file) => !file.endsWith(join('routes', 'common.ts')))
      .filter((file) => /error:\s*z\.object\(/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file));
    expect(local).toEqual([]);
  });
});
