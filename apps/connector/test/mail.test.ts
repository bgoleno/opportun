import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { JXA_SCRIPT, listMail, osascriptArgs } from '../src/mail';
import { nodeOsascript } from '../src/nodeIo';
import { makeIo, osascriptReturning, raw, skippedLine } from './fakes';

const run = promisify(execFile);

describe('the JXA script', () => {
  it('is a run handler that reads its parameters from argv', () => {
    expect(JXA_SCRIPT).toMatch(/^function run\(argv\) \{/m);
    expect(JXA_SCRIPT).toContain('JSON.parse(argv[0])');
    expect(JXA_SCRIPT).toContain("Application('Mail')");
  });

  it('filters by date in Mail itself and emits JSON lines', () => {
    expect(JXA_SCRIPT).toContain('.whose({ dateReceived: { _greaterThan: since } })');
    expect(JXA_SCRIPT).toContain('JSON.stringify');
    expect(JXA_SCRIPT).toContain("lines.join('\\n')");
    for (const field of ['id:', 'subject:', 'sender:', 'recipients:', 'dateReceived:', 'body:']) {
      expect(JXA_SCRIPT).toContain(field);
    }
  });

  it('truncates bodies and pages by date in the script', () => {
    expect(JXA_SCRIPT).toContain('.slice(0, p.maxBodyChars)');
    // A message it fails to read is reported with its date, so the cursor stops before it.
    expect(JXA_SCRIPT).toMatch(
      /catch \(e\) \{\s*lines\.push\(JSON\.stringify\(\{ skipped: new Date\(c\.t\)\.toISOString\(\)/,
    );
    expect(JXA_SCRIPT).toContain('p.limit');
  });

  it('only reads (FR-M7): no writes, moves, deletes, sends or shell', () => {
    for (const forbidden of [
      'readStatus',
      'flagged',
      '.delete(',
      '.move(',
      '.duplicate(',
      '.send(',
      '.make(',
      'doShellScript',
      'ObjC',
      '$.',
    ]) {
      expect(JXA_SCRIPT).not.toContain(forbidden);
    }
    // No property assignment on a Mail object (`x.y = ...`); locals only.
    expect(JXA_SCRIPT).not.toMatch(/\b[A-Za-z_]\w*\.\w+(\(\))?\s*=[^=]/);
  });
});

describe('listMail', () => {
  it('passes the script and its parameters to osascript', () => {
    const args = osascriptArgs({
      mailboxes: ['Inbox', 'Work/Recruiting'],
      since: 1000,
      limit: 100,
      maxBodyChars: 500_000,
    });
    expect(args.slice(0, 3)).toEqual(['-l', 'JavaScript', '-e']);
    expect(args[3]).toBe(JXA_SCRIPT);
    expect(JSON.parse(args[4] ?? '')).toEqual({
      mailboxes: ['Inbox', 'Work/Recruiting'],
      since: 1000,
      limit: 100,
      maxBodyChars: 500_000,
    });
  });

  it('parses JSON lines and skips blank ones', async () => {
    const mail = osascriptReturning([[raw(1), raw(2)]]);
    const { io } = makeIo({ osascript: mail.run });
    const found = await listMail(io, { mailboxes: ['Inbox'], since: 0, limit: 100 });
    expect(found.messages.map((m) => m.id)).toEqual([raw(1).id, raw(2).id]);
    expect(found.skipped).toEqual([]);
    expect(mail.calls).toHaveLength(1);
  });

  it('returns the dates of messages the script could not read (review F3)', async () => {
    const mail = osascriptReturning([[raw(1), skippedLine(2), raw(3)]]);
    const { io } = makeIo({ osascript: mail.run });
    const found = await listMail(io, { mailboxes: ['Inbox'], since: 0, limit: 100 });
    expect(found.messages.map((m) => m.id)).toEqual([raw(1).id, raw(3).id]);
    expect(found.skipped).toEqual([
      { date: Date.parse(raw(2).dateReceived), error: 'Mail got an error: timeout' },
    ]);
  });

  it('explains a missing Automation permission', async () => {
    const { io } = makeIo({
      osascript: osascriptReturning(
        [[]],
        1,
        'execution error: Not authorized to send Apple events to Mail. (-1743)',
      ).run,
    });
    await expect(listMail(io, { mailboxes: ['Inbox'], since: 0, limit: 100 })).rejects.toThrow(
      /Privacy & Security > Automation/,
    );
  });

  it('reports other osascript failures with their output', async () => {
    const { io } = makeIo({
      osascript: osascriptReturning([[]], 1, 'Error: Can\'t get mailbox "Nope".').run,
    });
    await expect(listMail(io, { mailboxes: ['Nope'], since: 0, limit: 100 })).rejects.toThrow(
      /Nope/,
    );
  });

  it('refuses output that is not JSON lines', async () => {
    const { io } = makeIo({
      osascript: async () => ({ code: 0, stdout: 'garbage\n', stderr: '' }),
    });
    await expect(listMail(io, { mailboxes: ['Inbox'], since: 0, limit: 100 })).rejects.toThrow(
      /unexpected output/,
    );
  });
});

describe.skipIf(process.platform !== 'darwin')('on macOS', () => {
  it('compiles the JXA script with osacompile', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opportun-jxa-'));
    try {
      const src = join(dir, 'sync.js');
      await writeFile(src, JXA_SCRIPT);
      await run('osacompile', ['-l', 'JavaScript', '-o', join(dir, 'sync.scpt'), src]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // With no mailboxes the script sends Mail no Apple events, so this runs the real script
  // end to end through osascript without touching Mail or needing Automation consent.
  it('runs the real script through osascript and lists nothing for no mailboxes', async () => {
    const { io } = makeIo({ osascript: nodeOsascript });
    expect(await listMail(io, { mailboxes: [], since: 0, limit: 10 })).toEqual({
      messages: [],
      skipped: [],
    });
  });

  it('hands argv to a JXA run handler the way the runner calls osascript', async () => {
    const res = await nodeOsascript([
      '-l',
      'JavaScript',
      '-e',
      'function run(argv) { return JSON.stringify(JSON.parse(argv[0])); }',
      JSON.stringify({ since: 5, mailboxes: ['Inbox'] }),
    ]);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ since: 5, mailboxes: ['Inbox'] });
  });
});
