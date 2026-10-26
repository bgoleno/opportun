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
    expect(err.join('\n')).toMatch(/Settings > Integrations > Devices/);
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
