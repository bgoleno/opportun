import { describe, expect, it } from 'vitest';
import { main } from '../src/cli';
import { configFiles, loadConfig, loadState } from '../src/config';
import { EXIT } from '../src/types';
import {
  CONFIG,
  makeIo,
  ok,
  osascriptReturning,
  raw,
  scriptedFetch,
  TOKEN,
  withConfig,
} from './fakes';

function answering(answers: Record<string, string>) {
  const asked: Array<{ question: string; secret: boolean }> = [];
  const prompt = async (question: string, opts: { secret?: boolean } = {}) => {
    asked.push({ question, secret: opts.secret === true });
    const hit = Object.entries(answers).find(([k]) => question.includes(k));
    if (hit === undefined) throw new Error(`unexpected prompt: ${question}`);
    return hit[1];
  };
  return { prompt, asked };
}

describe('init', () => {
  it('prompts, writes a 0600 config, and validates the token with an empty batch', async () => {
    const f = scriptedFetch([ok(0, 0)]);
    const p = answering({
      'Server URL': 'https://opportun.example/',
      'Device token': ` ${TOKEN} `,
      Mailboxes: 'Inbox, Work/Recruiting',
      'Lookback window': '',
    });
    const { io, fs, out } = makeIo({ fetch: f.fetch, prompt: p.prompt });
    expect(await main(['init'], io)).toBe(EXIT.OK);

    expect(p.asked.find((a) => a.question.includes('Device token'))?.secret).toBe(true);
    expect(fs.files.get(configFiles(io.configDir).config)?.mode).toBe(0o600);
    expect(await loadConfig(io)).toEqual({
      serverUrl: 'https://opportun.example',
      token: TOKEN,
      mailboxes: ['Inbox', 'Work/Recruiting'],
      lookbackDays: 180,
      intervalMinutes: 15,
    });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe('https://opportun.example/api/v1/connector/mail/batch');
    expect(f.calls[0]?.body).toEqual({ messages: [] });
    expect(f.calls[0]?.init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(out.join('\n')).toMatch(/token accepted/i);
    // The token is a secret: never echoed back.
    expect(out.join('\n')).not.toContain(TOKEN);
  });

  it('takes everything from flags without prompting', async () => {
    const f = scriptedFetch([ok()]);
    const { io } = makeIo({ fetch: f.fetch });
    const code = await main(
      [
        'init',
        '--server',
        'https://opportun.example',
        '--token',
        TOKEN,
        '--mailbox',
        'Inbox',
        '--mailbox',
        'Recruiting',
        '--days',
        '90',
        '--interval',
        '30',
      ],
      io,
    );
    expect(code).toBe(EXIT.OK);
    expect(await loadConfig(io)).toEqual({
      serverUrl: 'https://opportun.example',
      token: TOKEN,
      mailboxes: ['Inbox', 'Recruiting'],
      lookbackDays: 90,
      intervalMinutes: 30,
    });
  });

  it('offers the existing config as defaults on a re-run, keeping the token', async () => {
    const p = answering({
      'Server URL': '',
      'Device token': '',
      Mailboxes: '',
      'Lookback window': '',
    });
    const { io, fs } = makeIo({ fetch: scriptedFetch([ok()]).fetch, prompt: p.prompt });
    await withConfig(fs, { ...CONFIG, mailboxes: ['Recruiting'] });
    expect(await main(['init'], io)).toBe(EXIT.OK);
    expect(await loadConfig(io)).toEqual({ ...CONFIG, mailboxes: ['Recruiting'] });
    expect(p.asked.map((a) => a.question).join('\n')).toContain('[Recruiting]');
  });

  describe('the sync cursor (review F4)', () => {
    const flags = (mailboxes: string[], days: number) => [
      'init',
      '--server',
      'https://opportun.example',
      '--token',
      TOKEN,
      ...mailboxes.flatMap((m) => ['--mailbox', m]),
      '--days',
      String(days),
    ];

    it.each([
      ['a mailbox is added', ['Inbox', 'Recruiting'], 30],
      ['the lookback window grows', ['Inbox'], 90],
    ])('is cleared when %s, with an explanation', async (_why, mailboxes, days) => {
      const { io, fs, out } = makeIo({ fetch: scriptedFetch([ok()]).fetch });
      await withConfig(fs, CONFIG, { cursor: 1234 });
      expect(await main(flags(mailboxes, days), io)).toBe(EXIT.OK);
      expect(await loadState(io)).toEqual({ cursor: null });
      expect(out.join('\n')).toMatch(/next sync re-reads the whole lookback window/);
    });

    it.each([
      ['nothing grows', ['inbox'], 30],
      ['a mailbox is removed and the window shrinks', ['Inbox'], 7],
    ])('is kept when %s', async (_why, mailboxes, days) => {
      const { io, fs, out } = makeIo({ fetch: scriptedFetch([ok()]).fetch });
      await withConfig(fs, { ...CONFIG, mailboxes: ['Inbox', 'Old'] }, { cursor: 1234 });
      expect(await main(flags(mailboxes, days), io)).toBe(EXIT.OK);
      expect(await loadState(io)).toEqual({ cursor: 1234 });
      expect(out.join('\n')).not.toMatch(/lookback window/);
    });
  });

  // #655 (sec): a token in a flag lands in shell history; a file or stdin does not.
  describe('the token from a file or stdin', () => {
    const FLAGS = ['--server', 'https://opportun.example', '--mailbox', 'Inbox'];

    it('reads --token-file, a file only you can read, trimming its newline', async () => {
      const f = scriptedFetch([ok()]);
      const { io, fs } = makeIo({ fetch: f.fetch });
      await fs.writeText('/home/me/token', `${TOKEN}\n`, 0o600);
      expect(await main(['init', ...FLAGS, '--token-file', '/home/me/token'], io)).toBe(EXIT.OK);
      expect((await loadConfig(io)).token).toBe(TOKEN);
      expect(f.calls).toHaveLength(1);
    });

    it('refuses a token file others can read, saying how to fix it, before writing anything', async () => {
      const { io, fs, err } = makeIo();
      await fs.writeText('/home/me/token', TOKEN, 0o644);
      fs.writes = [];
      const code = await main(['init', ...FLAGS, '--token-file', '/home/me/token'], io);
      expect(code).toBe(EXIT.USAGE);
      expect(err.join('\n')).toContain('chmod 600 /home/me/token');
      expect(fs.writes).toEqual([]);
    });

    it('refuses a token file that is not there', async () => {
      const { io, fs, err } = makeIo();
      const code = await main(['init', ...FLAGS, '--token-file', '/home/me/nope'], io);
      expect(code).toBe(EXIT.USAGE);
      expect(err.join('\n')).toMatch(/No token file at \/home\/me\/nope/);
      expect(fs.writes).toEqual([]);
    });

    it('reads --token-stdin', async () => {
      const f = scriptedFetch([ok()]);
      const { io } = makeIo({ fetch: f.fetch, readStdin: async () => `  ${TOKEN}\n` });
      expect(await main(['init', ...FLAGS, '--token-stdin'], io)).toBe(EXIT.OK);
      expect((await loadConfig(io)).token).toBe(TOKEN);
    });

    it('--token-stdin needs --server: stdin carries the token, so nothing can be asked', async () => {
      const { io, fs, err } = makeIo({ readStdin: async () => TOKEN });
      const code = await main(['init', '--mailbox', 'Inbox', '--token-stdin'], io);
      expect(code).toBe(EXIT.USAGE);
      expect(err.join('\n')).toMatch(/--token-stdin needs --server/);
      expect(fs.writes).toEqual([]);
    });

    it('--token-stdin without --mailbox uses the saved mailboxes, or Inbox, without asking', async () => {
      const { io } = makeIo({ fetch: scriptedFetch([ok()]).fetch, readStdin: async () => TOKEN });
      expect(
        await main(['init', '--server', 'https://opportun.example', '--token-stdin'], io),
      ).toBe(EXIT.OK);
      expect((await loadConfig(io)).mailboxes).toEqual(['Inbox']);
    });

    it('takes one token source only', async () => {
      const { io, fs, err } = makeIo({ readStdin: async () => TOKEN });
      await fs.writeText('/home/me/token', TOKEN, 0o600);
      fs.writes = [];
      for (const extra of [
        ['--token', TOKEN, '--token-stdin'],
        ['--token', TOKEN, '--token-file', '/home/me/token'],
        ['--token-file', '/home/me/token', '--token-stdin'],
      ]) {
        expect(await main(['init', ...FLAGS, ...extra], io), extra.join(' ')).toBe(EXIT.USAGE);
      }
      expect(err.join('\n')).toMatch(/one of --token, --token-file or --token-stdin/);
      expect(fs.writes).toEqual([]);
    });

    it('the help shows the file and stdin as the way to pass a token, and --token with its caveat', async () => {
      const { io, out } = makeIo();
      expect(await main(['--help'], io)).toBe(EXIT.OK);
      const help = out.join('\n');
      expect(help).toContain('--token-file <path>');
      expect(help).toContain('--token-stdin');
      expect(help).toMatch(/--token <token>[\s\S]*shell history/);
    });
  });

  // #650: a cursor is the old server's position. A different server has none of that mail, so
  // init with another address starts the next sync from the start of the lookback window.
  // #702 (sec on #673): with a new server address, Enter at the token prompt kept the old token,
  // and init then sent the previous server's mail:push token to whatever address was typed.
  describe('the saved token and the server address (#702)', () => {
    const NEW = `odt_${'N'.repeat(43)}`;

    it('a changed address offers no saved token: it asks for one and says why', async () => {
      const p = answering({
        'Server URL': 'https://other-opportun.example',
        'Device token': '',
        Mailboxes: '',
        'Lookback window': '',
      });
      const f = scriptedFetch([ok()]);
      const { io, fs, out, err } = makeIo({ fetch: f.fetch, prompt: p.prompt });
      await withConfig(fs);
      fs.writes = [];
      expect(await main(['init'], io)).toBe(EXIT.USAGE);
      const tokenQuestion = p.asked.find((a) => a.question.includes('Device token'))!;
      expect(tokenQuestion.question).not.toMatch(/keep current/);
      expect(out.join('\n')).toMatch(/server changed, so the saved token is not reused/i);
      expect(err.join('\n')).toMatch(/odt_/);
      // Nothing was sent anywhere, and nothing written.
      expect(f.calls).toHaveLength(0);
      expect(fs.writes).toEqual([]);
    });

    it('a changed address takes the token typed for it', async () => {
      const p = answering({
        'Server URL': 'https://other-opportun.example',
        'Device token': NEW,
        Mailboxes: '',
        'Lookback window': '',
      });
      const { io, fs } = makeIo({ fetch: scriptedFetch([ok()]).fetch, prompt: p.prompt });
      await withConfig(fs);
      expect(await main(['init'], io)).toBe(EXIT.OK);
      expect(await loadConfig(io)).toMatchObject({
        serverUrl: 'https://other-opportun.example',
        token: NEW,
      });
    });

    it('the same address, typed another way, still keeps the saved token on Enter', async () => {
      const p = answering({
        'Server URL': 'HTTPS://OPPORTUN.EXAMPLE/',
        'Device token': '',
        Mailboxes: '',
        'Lookback window': '',
      });
      const { io, fs, out } = makeIo({ fetch: scriptedFetch([ok()]).fetch, prompt: p.prompt });
      await withConfig(fs);
      expect(await main(['init'], io)).toBe(EXIT.OK);
      expect((await loadConfig(io)).token).toBe(TOKEN);
      expect(p.asked.find((a) => a.question.includes('Device token'))!.question).toMatch(
        /keep current/,
      );
      expect(out.join('\n')).not.toMatch(/saved token is not reused/);
    });

    it('--server with another address and no token flag asks for a token with no default', async () => {
      const p = answering({ 'Device token': '' });
      const { io, fs } = makeIo({ prompt: p.prompt });
      await withConfig(fs);
      const code = await main(
        ['init', '--server', 'https://other-opportun.example', '--mailbox', 'Inbox'],
        io,
      );
      expect(code).toBe(EXIT.USAGE);
      expect(p.asked.find((a) => a.question.includes('Device token'))!.question).not.toMatch(
        /keep current/,
      );
    });
  });

  describe('the sync cursor and the server address (#650)', () => {
    const flags = (server: string) => [
      'init',
      '--server',
      server,
      '--token',
      TOKEN,
      '--mailbox',
      'Inbox',
      '--days',
      String(CONFIG.lookbackDays),
    ];

    it('is cleared when the server address changes, with an explanation, and the next sync reads the whole window', async () => {
      const mail = osascriptReturning([[]]);
      const { io, fs, out, clock } = makeIo({
        fetch: scriptedFetch([ok(), ok()]).fetch,
        osascript: mail.run,
      });
      await withConfig(fs, CONFIG, { cursor: 1234 });
      expect(await main(flags('https://other-opportun.example'), io)).toBe(EXIT.OK);
      expect(await loadState(io)).toEqual({ cursor: null });
      expect(out.join('\n')).toMatch(/server address changed/i);
      expect(out.join('\n')).toMatch(/next sync re-reads the whole lookback window/);
      // The next sync starts at the window's start, not at the old server's position.
      expect(await main(['sync'], io)).toBe(EXIT.OK);
      const since = (JSON.parse(mail.calls[0]?.[4] ?? '{}') as { since: number }).since;
      expect(since).toBe(clock.now() - CONFIG.lookbackDays * 24 * 60 * 60 * 1000);
    });

    it.each([
      ['the same address', 'https://opportun.example'],
      ['the same address with a trailing slash', 'https://opportun.example/'],
    ])('is kept for %s', async (_why, server) => {
      const { io, fs, out } = makeIo({ fetch: scriptedFetch([ok()]).fetch });
      await withConfig(fs, CONFIG, { cursor: 1234 });
      expect(await main(flags(server), io)).toBe(EXIT.OK);
      expect(await loadState(io)).toEqual({ cursor: 1234 });
      expect(out.join('\n')).not.toMatch(/server address changed/i);
    });
  });

  it('refuses a malformed token before writing anything', async () => {
    const { io, fs, err } = makeIo();
    const code = await main(
      ['init', '--server', 'https://opportun.example', '--token', 'hunter2', '--mailbox', 'Inbox'],
      io,
    );
    expect(code).toBe(EXIT.USAGE);
    expect(err.join('\n')).toMatch(/odt_/);
    expect(fs.writes).toEqual([]);
  });

  it('reports a rejected token with the server answer', async () => {
    const { io, err } = makeIo({ fetch: scriptedFetch([{ status: 401 }]).fetch });
    const code = await main(
      ['init', '--server', 'https://opportun.example', '--token', TOKEN, '--mailbox', 'Inbox'],
      io,
    );
    expect(code).toBe(EXIT.AUTH);
    expect(err.join('\n')).toMatch(/rejected the device token/i);
    // Kept, so a fixed token is one `init` away and nothing else needs retyping.
    expect((await loadConfig(io)).serverUrl).toBe('https://opportun.example');
  });

  it('reports an unreachable server', async () => {
    const { io, err } = makeIo({ fetch: scriptedFetch([new Error('ENOTFOUND')]).fetch });
    const code = await main(
      ['init', '--server', 'https://opportun.example', '--token', TOKEN, '--mailbox', 'Inbox'],
      io,
    );
    expect(code).toBe(EXIT.SERVER);
    expect(err.join('\n')).toMatch(/ENOTFOUND/);
  });
});

describe('sync', () => {
  it('syncs once and prints a summary', async () => {
    const { io, fs, out } = makeIo({
      osascript: osascriptReturning([[raw(1)]]).run,
      fetch: scriptedFetch([ok(1, 1)]).fetch,
    });
    await withConfig(fs);
    expect(await main(['sync'], io)).toBe(EXIT.OK);
    expect(out.join('\n')).toMatch(/1 found, 1 pushed \(1 new\)/);
  });

  it('exits with the failure code and message', async () => {
    const { io, fs, err } = makeIo({
      osascript: osascriptReturning([[raw(1)]]).run,
      fetch: scriptedFetch([{ status: 401 }]).fetch,
    });
    await withConfig(fs);
    expect(await main(['sync'], io)).toBe(EXIT.AUTH);
    expect(err.join('\n')).toMatch(/Settings > Integrations > Extensions and Connectors/);
  });

  it('asks for init when there is no config', async () => {
    const { io, err } = makeIo();
    expect(await main(['sync'], io)).toBe(EXIT.USAGE);
    expect(err.join('\n')).toMatch(/opportun-connector init/);
  });
});

describe('watch', () => {
  it('syncs every interval, jittered, until interrupted', async () => {
    const controller = new AbortController();
    const mail = osascriptReturning([[]]);
    const { io, fs, clock } = makeIo({ osascript: mail.run, random: () => 0 });
    const sleep = clock.sleep.bind(clock);
    clock.sleep = async (ms, signal) => {
      await sleep(ms, signal);
      if (clock.sleeps.length === 2) controller.abort();
    };
    await withConfig(fs);
    expect(await main(['watch'], io, { signal: controller.signal })).toBe(EXIT.OK);
    expect(mail.calls).toHaveLength(2);
    // random() = 0 is the low end of the +/-10% jitter on 15 minutes.
    expect(clock.sleeps).toEqual([13.5 * 60_000, 13.5 * 60_000]);
  });

  it('honours --interval and keeps going after a transient failure', async () => {
    const controller = new AbortController();
    const f = scriptedFetch([
      { status: 500 },
      { status: 500 },
      { status: 500 },
      { status: 500 },
      ok(1, 1),
    ]);
    const { io, fs, clock, err } = makeIo({
      osascript: osascriptReturning([[raw(1)]]).run,
      fetch: f.fetch,
    });
    const sleep = clock.sleep.bind(clock);
    clock.sleep = async (ms, signal) => {
      await sleep(ms, signal);
      if (ms === 5 * 60_000 && clock.sleeps.filter((s) => s === ms).length === 2)
        controller.abort();
    };
    await withConfig(fs);
    expect(await main(['watch', '--interval', '5'], io, { signal: controller.signal })).toBe(
      EXIT.OK,
    );
    expect(err.join('\n')).toMatch(/server error/i);
    expect(f.calls).toHaveLength(5);
  });

  it('stops on a rejected token instead of retrying forever', async () => {
    const { io, fs } = makeIo({
      osascript: osascriptReturning([[raw(1)]]).run,
      fetch: scriptedFetch([{ status: 401 }]).fetch,
    });
    await withConfig(fs);
    expect(await main(['watch'], io, { signal: new AbortController().signal })).toBe(EXIT.AUTH);
  });
});

describe('never echoing a possible token (review F8)', () => {
  it.each([
    ['a stray positional after init', ['init', TOKEN]],
    ['a stray positional after sync', ['sync', TOKEN]],
    ['a token where the command goes', [TOKEN]],
    ['a token as the server address', ['init', '--server', TOKEN, '--token', TOKEN]],
    ['a long secret-looking stray value', ['init', `x${'s'.repeat(60)}`]],
  ])('redacts %s', async (_why, argv) => {
    const { io, err } = makeIo();
    expect(await main(argv, io)).toBe(EXIT.USAGE);
    const text = err.join('\n');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('s'.repeat(41));
  });

  it('still says what was wrong', async () => {
    const { io, err } = makeIo();
    await main(['init', TOKEN], io);
    expect(err.join('\n')).toContain("Unexpected argument 'odt_[redacted]'.");
  });
});

describe('usage', () => {
  it('prints help', async () => {
    const { io, out } = makeIo();
    expect(await main(['--help'], io)).toBe(EXIT.OK);
    expect(out.join('\n')).toMatch(/init.*sync.*watch/s);
  });

  it('refuses an unknown command or flag', async () => {
    const { io, err } = makeIo();
    expect(await main(['frobnicate'], io)).toBe(EXIT.USAGE);
    expect(await main(['sync', '--bogus'], io)).toBe(EXIT.USAGE);
    expect(err.join('\n')).toMatch(/Usage/);
  });

  it('prints the version', async () => {
    const { io, out } = makeIo();
    expect(await main(['--version'], io)).toBe(EXIT.OK);
    expect(out).toEqual(['0.1.0']);
  });
});
