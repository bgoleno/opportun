// The device token never reaches a page (sec on https://github.com/bgoleno/opportun/issues/182):
// only the popup sends it, to the Opportun server. A token may carry both capture:push and
// apply:assist, which raises the cost of a leak, so this scan pins that nothing handed to
// chrome.scripting.executeScript (the function injected into the page, and its `args`) names the
// token or the settings that hold it. Every injection added later (the prefill filler, #183) is
// covered by the same scan.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractIndeedJob, extractPage } from '../src/extract';

const SRC = join(__dirname, '..', 'src');
const TOKENISH = /token|settings|authorization|bearer|odt_/i;

/** Each `executeScript({ ... })` call's argument text, by balanced braces. */
function injections(source: string): string[] {
  const calls: string[] = [];
  let at = source.indexOf('executeScript(');
  while (at !== -1) {
    const open = source.indexOf('{', at);
    let depth = 0;
    let end = open;
    for (; end < source.length; end += 1) {
      if (source[end] === '{') depth += 1;
      if (source[end] === '}') depth -= 1;
      if (depth === 0) break;
    }
    calls.push(source.slice(open, end + 1));
    at = source.indexOf('executeScript(', end);
  }
  return calls;
}

describe('the device token never goes into the page', () => {
  it('no executeScript call passes anything token-like in its args or names it', async () => {
    const files = (await readdir(SRC)).filter((f) => f.endsWith('.ts'));
    let seen = 0;
    for (const file of files) {
      const source = await readFile(join(SRC, file), 'utf8');
      for (const call of injections(source)) {
        // The type declaration of executeScript in popup.ts has no args to check.
        if (!/args\s*:/.test(call)) continue;
        seen += 1;
        const args = /args\s*:\s*(\[[^\]]*\])/.exec(call)?.[1] ?? '';
        expect(args, `${file}: ${call}`).not.toMatch(TOKENISH);
      }
    }
    // The scan is not hollow: the LinkedIn and Indeed readers are both injected with args.
    expect(seen).toBeGreaterThanOrEqual(2);
  });

  it('the functions injected into the page never mention a token', () => {
    for (const fn of [extractPage, extractIndeedJob]) {
      expect(fn.toString()).not.toMatch(/token|authorization|bearer/i);
    }
  });
});
