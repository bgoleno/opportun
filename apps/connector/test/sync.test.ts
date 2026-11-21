import { describe, expect, it } from 'vitest';
import { loadState } from '../src/config';
import { OVERLAP_MS, syncOnce } from '../src/sync';
import { EXIT } from '../src/types';
import {
  CONFIG,
  makeIo,
  ok,
  osascriptReturning,
  raw,
  scriptedFetch,
  skippedLine,
  withConfig,
} from './fakes';

const DAY = 24 * 60 * 60 * 1000;
const at = (n: number) => Date.parse(raw(n).dateReceived);
const many = (count: number, from = 0) => Array.from({ length: count }, (_, i) => raw(from + i));
const sinceOf = (args: string[] | undefined) =>
  (JSON.parse(args?.[4] ?? '{}') as { since: number }).since;

describe('syncOnce', () => {
  it('starts from the lookback window, pushes, and stores the newest date as the cursor', async () => {
    const mail = osascriptReturning([[raw(2), raw(1)]]);
    const f = scriptedFetch([ok(2, 2)]);
    const { io, fs, clock } = makeIo({ osascript: mail.run, fetch: f.fetch });
    await withConfig(fs);
    const summary = await syncOnce(io, CONFIG);
    expect(sinceOf(mail.calls[0])).toBe(clock.now() - CONFIG.lookbackDays * DAY);
    // Oldest first, so a cursor taken after any batch covers everything before it.
    expect(f.calls[0]?.body.messages.map((m) => m.externalId)).toEqual([
      `apple-mail:${raw(1).id}`,
      `apple-mail:${raw(2).id}`,
    ]);
    expect(summary).toEqual({ found: 2, pushed: 2, inserted: 2, skipped: 0 });
    expect(await loadState(io)).toEqual({ cursor: at(2) });
  });

  it('resumes from the cursor with a small overlap (the server upserts)', async () => {
    const mail = osascriptReturning([[]]);
    const f = scriptedFetch([ok()]);
    const { io, fs } = makeIo({ osascript: mail.run, fetch: f.fetch });
    await withConfig(fs, CONFIG, { cursor: at(5) });
    expect(await syncOnce(io, CONFIG)).toEqual({ found: 0, pushed: 0, inserted: 0, skipped: 0 });
    expect(sinceOf(mail.calls[0])).toBe(at(5) - OVERLAP_MS);
    expect(f.calls).toHaveLength(0);
    expect(await loadState(io)).toEqual({ cursor: at(5) });
  });

  it('pushes a message found in two mailboxes once', async () => {
    const f = scriptedFetch([ok(1, 1)]);
    const { io, fs } = makeIo({
      osascript: osascriptReturning([[raw(1), raw(1)]]).run,
      fetch: f.fetch,
    });
    await withConfig(fs);
    await syncOnce(io, CONFIG);
    expect(f.calls[0]?.body.messages).toHaveLength(1);
  });

  it('advances the cursor only after a 2xx, batch by batch', async () => {
    const f = scriptedFetch([ok(100, 100), { status: 500 }]);
    const { io, fs } = makeIo({ osascript: osascriptReturning([many(150)]).run, fetch: f.fetch });
    await withConfig(fs);
    await expect(syncOnce(io, CONFIG)).rejects.toMatchObject({ exitCode: EXIT.SERVER });
    expect(f.calls[0]?.body.messages).toHaveLength(100);
    expect(f.calls[1]?.body.messages).toHaveLength(50);
    expect(await loadState(io)).toEqual({ cursor: at(99) });
  });

  it('retries a 5xx with exponential backoff three times, then fails nonzero', async () => {
    const f = scriptedFetch([{ status: 502 }]);
    const { io, fs, clock } = makeIo({
      osascript: osascriptReturning([[raw(1)]]).run,
      fetch: f.fetch,
    });
    await withConfig(fs);
    await expect(syncOnce(io, CONFIG)).rejects.toThrow(/server error \(502\)/i);
    expect(f.calls).toHaveLength(4);
    expect(clock.sleeps).toEqual([2000, 4000, 8000]);
    expect(await loadState(io)).toEqual({ cursor: null });
  });

  it('recovers when a retry succeeds, network errors included', async () => {
    const f = scriptedFetch([{ status: 503 }, new Error('ECONNRESET'), ok(1, 1)]);
    const { io, fs, clock } = makeIo({
      osascript: osascriptReturning([[raw(1)]]).run,
      fetch: f.fetch,
    });
    await withConfig(fs);
    expect((await syncOnce(io, CONFIG)).pushed).toBe(1);
    expect(clock.sleeps).toEqual([2000, 4000]);
    expect(await loadState(io)).toEqual({ cursor: at(1) });
  });

  it('waits out a 429 for retry-after, then resumes the same batch', async () => {
    const f = scriptedFetch([{ status: 429, headers: { 'retry-after': '42' } }, ok(1, 1)]);
    const { io, fs, clock, err } = makeIo({
      osascript: osascriptReturning([[raw(1)]]).run,
      fetch: f.fetch,
    });
    await withConfig(fs);
    expect((await syncOnce(io, CONFIG)).pushed).toBe(1);
    expect(clock.sleeps).toEqual([42_000]);
    expect(f.calls[1]?.body).toEqual(f.calls[0]?.body);
    expect(err.join('\n')).toMatch(/rate limit/i);
    expect(await loadState(io)).toEqual({ cursor: at(1) });
  });

  it('waits a default minute on a 429 without retry-after', async () => {
    const f = scriptedFetch([{ status: 429 }, ok(1, 1)]);
    const { io, fs, clock } = makeIo({
      osascript: osascriptReturning([[raw(1)]]).run,
      fetch: f.fetch,
    });
    await withConfig(fs);
    await syncOnce(io, CONFIG);
    expect(clock.sleeps).toEqual([60_000]);
  });

  it('stops with a clear token message on 401, cursor untouched', async () => {
    const f = scriptedFetch([{ status: 401 }]);
    const { io, fs } = makeIo({ osascript: osascriptReturning([[raw(1)]]).run, fetch: f.fetch });
    await withConfig(fs);
    const failure = syncOnce(io, CONFIG);
    await expect(failure).rejects.toMatchObject({ exitCode: EXIT.AUTH });
    await expect(failure).rejects.toThrow(
      /revoked.*Settings > Integrations > Extensions and Connectors.*init/s,
    );
    expect(f.calls).toHaveLength(1);
    expect(await loadState(io)).toEqual({ cursor: null });
  });

  it('explains a token without the mail:push scope on 403', async () => {
    const { io, fs } = makeIo({
      osascript: osascriptReturning([[raw(1)]]).run,
      fetch: scriptedFetch([{ status: 403 }]).fetch,
    });
    await withConfig(fs);
    await expect(syncOnce(io, CONFIG)).rejects.toThrow(/mail:push/);
  });

  it('halves a batch the server finds too large, and skips a single message it refuses', async () => {
    const f = scriptedFetch([
      { status: 413, body: { error: { code: 'batch_too_large' } } },
      ok(1, 1),
      { status: 413, body: { error: { code: 'message_too_large' } } },
    ]);
    const { io, fs, err } = makeIo({
      osascript: osascriptReturning([[raw(1), raw(2)]]).run,
      fetch: f.fetch,
    });
    await withConfig(fs);
    expect(await syncOnce(io, CONFIG)).toEqual({ found: 2, pushed: 1, inserted: 1, skipped: 1 });
    expect(f.calls.map((c) => c.body.messages.length)).toEqual([2, 1, 1]);
    // Review F5: loud, identifiable, and pointing at the usual cause.
    const warning = err.join('\n');
    expect(warning).toMatch(/^WARNING: /m);
    expect(warning).toContain(`apple-mail:${raw(2).id}`);
    expect(warning).toContain('"Role 2"');
    expect(warning).toContain(new Date(Date.parse(raw(2).dateReceived)).toISOString());
    expect(warning).toMatch(/client_max_body_size/);
    expect(await loadState(io)).toEqual({ cursor: at(2) });
  });

  // #649: a refusal other than 413 used to throw, so the cursor never moved and every sync re-sent
  // the same batch. Now it is split down to the message the server refuses, which is skipped and
  // named, and the rest goes through.
  it.each([400, 409, 422])(
    'a batch refused with %i is split down to the refused message, which is skipped and named; the rest goes through',
    async (status) => {
      const f = scriptedFetch([
        { status, body: { error: { code: 'invalid_body' } } },
        ok(2, 2),
        { status, body: { error: { code: 'invalid_body' } } },
      ]);
      const { io, fs, err } = makeIo({
        osascript: osascriptReturning([[raw(1), raw(2), raw(3)]]).run,
        fetch: f.fetch,
      });
      await withConfig(fs);
      expect(await syncOnce(io, CONFIG)).toEqual({ found: 3, pushed: 2, inserted: 2, skipped: 1 });
      expect(f.calls.map((c) => c.body.messages.length)).toEqual([3, 2, 1]);
      const warning = err.join('\n');
      expect(warning).toMatch(/^WARNING: skipped /m);
      expect(warning).toContain(`apple-mail:${raw(3).id}`);
      expect(warning).toContain('"Role 3"');
      expect(warning).toContain(`HTTP ${status}, invalid_body`);
      // Past the skipped message: the next sync does not send it again.
      expect(await loadState(io)).toEqual({ cursor: at(3) });
    },
  );

  it('a refusal of every message in a batch is the server refusing the connector, not one message: nothing is skipped', async () => {
    const f = scriptedFetch([
      { status: 400, body: { error: { code: 'invalid_body' } } },
      { status: 400, body: { error: { code: 'invalid_body' } } },
      { status: 400, body: { error: { code: 'invalid_body' } } },
    ]);
    const { io, fs, err } = makeIo({
      osascript: osascriptReturning([[raw(1), raw(2)]]).run,
      fetch: f.fetch,
    });
    await withConfig(fs, CONFIG, { cursor: at(0) });
    await expect(syncOnce(io, CONFIG)).rejects.toThrow(
      /refused a batch \(HTTP 400, invalid_body\)/,
    );
    expect(err.join('\n')).not.toMatch(/skipped/);
    // The position stays, so nothing is lost once the server or the connector is updated.
    expect(await loadState(io)).toEqual({ cursor: at(0) });
  });

  it('a page the server refuses whole is seen as systemic within a few requests, not one per message (tl on #680)', async () => {
    const refused = { status: 400, body: { error: { code: 'invalid_body' } } };
    const f = scriptedFetch(Array.from({ length: 250 }, () => refused));
    const page = Array.from({ length: 100 }, (_, i) => raw(i + 1));
    const { io, fs, err } = makeIo({ osascript: osascriptReturning([page]).run, fetch: f.fetch });
    await withConfig(fs, CONFIG, { cursor: at(0) });
    await expect(syncOnce(io, CONFIG)).rejects.toThrow(
      /refused a batch \(HTTP 400, invalid_body\)/,
    );
    // 100, 50, 25, 13, 7, 4, 2, then two single messages both refused alike, nothing accepted:
    // the connector, not those messages. Not 2N-1 = 199.
    expect(f.calls.map((c) => c.body.messages.length)).toEqual([100, 50, 25, 13, 7, 4, 2, 1, 1]);
    expect(err.join('\n')).not.toMatch(/skipped/);
    expect(await loadState(io)).toEqual({ cursor: at(0) });
  });

  it('two single refusals after something was accepted are those messages: both skipped', async () => {
    const refused = { status: 422, body: { error: { code: 'invalid_body' } } };
    const f = scriptedFetch([refused, ok(2, 2), refused, refused, refused]);
    const { io, fs, err } = makeIo({
      osascript: osascriptReturning([[raw(1), raw(2), raw(3), raw(4)]]).run,
      fetch: f.fetch,
    });
    await withConfig(fs);
    expect(await syncOnce(io, CONFIG)).toEqual({ found: 4, pushed: 2, inserted: 2, skipped: 2 });
    expect(f.calls.map((c) => c.body.messages.length)).toEqual([4, 2, 2, 1, 1]);
    expect(err.join('\n')).toContain(`apple-mail:${raw(3).id}`);
    expect(err.join('\n')).toContain(`apple-mail:${raw(4).id}`);
  });

  it('a 404 (no such route: a server older than the connector) is not split', async () => {
    const f = scriptedFetch([{ status: 404, body: { error: { code: 'not_found' } } }]);
    const { io, fs } = makeIo({
      osascript: osascriptReturning([[raw(1), raw(2)]]).run,
      fetch: f.fetch,
    });
    await withConfig(fs, CONFIG, { cursor: at(0) });
    await expect(syncOnce(io, CONFIG)).rejects.toThrow(/HTTP 404/);
    expect(f.calls).toHaveLength(1);
    expect(await loadState(io)).toEqual({ cursor: at(0) });
  });

  it('keeps terminal control characters from a refused subject out of the warning', async () => {
    const f = scriptedFetch([{ status: 413, body: { error: { code: 'message_too_large' } } }]);
    const { io, fs, err } = makeIo({
      osascript: osascriptReturning([[raw(1, { subject: 'Hi\u001b[2Jthere' })]]).run,
      fetch: f.fetch,
    });
    await withConfig(fs);
    await syncOnce(io, CONFIG);
    expect(err.join('\n')).not.toContain('\u001b');
    expect(err.join('\n')).toContain('"Hi?[2Jthere"');
  });

  it('drains a backlog page by page from the cursor', async () => {
    const mail = osascriptReturning([[raw(1), raw(2)], [raw(3)]]);
    const f = scriptedFetch([ok(2, 2), ok(1, 1)]);
    const { io, fs } = makeIo({ osascript: mail.run, fetch: f.fetch });
    await withConfig(fs);
    expect(await syncOnce(io, CONFIG, { pageSize: 2 })).toMatchObject({ found: 3, pushed: 3 });
    expect(mail.calls).toHaveLength(2);
    expect(sinceOf(mail.calls[1])).toBe(at(2));
    expect(await loadState(io)).toEqual({ cursor: at(3) });
  });

  it('skips (and reports) a message Mail returned without a usable date', async () => {
    const f = scriptedFetch([ok(1, 1)]);
    const { io, fs, err } = makeIo({
      osascript: osascriptReturning([[raw(1), raw(2, { dateReceived: 'never' })]]).run,
      fetch: f.fetch,
    });
    await withConfig(fs);
    expect(await syncOnce(io, CONFIG)).toMatchObject({ found: 2, pushed: 1, skipped: 1 });
    expect(err.join('\n')).toMatch(/date/);
  });

  it('stops between batches once aborted', async () => {
    const controller = new AbortController();
    const f = scriptedFetch([ok(100, 100)]);
    const fetch: typeof f.fetch = async (url, init) => {
      const res = await f.fetch(url, init);
      controller.abort();
      return res;
    };
    const { io, fs } = makeIo({ osascript: osascriptReturning([many(150)]).run, fetch });
    await withConfig(fs);
    expect(await syncOnce(io, CONFIG, { signal: controller.signal })).toMatchObject({
      pushed: 100,
    });
    expect(f.calls).toHaveLength(1);
    expect(await loadState(io)).toEqual({ cursor: at(99) });
  });

  describe('a message Mail failed to read (review F3)', () => {
    it('holds the cursor before it, and the next run re-reads and pushes it', async () => {
      const mail = osascriptReturning([
        [raw(1), skippedLine(2), raw(3)],
        [raw(2), raw(3)],
      ]);
      const f = scriptedFetch([ok(2, 2), ok(2, 1)]);
      const { io, fs, err } = makeIo({ osascript: mail.run, fetch: f.fetch });
      await withConfig(fs);
      expect(await syncOnce(io, CONFIG)).toMatchObject({ pushed: 2, skipped: 1 });
      expect(await loadState(io)).toEqual({
        cursor: at(2) - 1,
        retry: { at: at(2), attempts: 1 },
      });
      expect(err.join('\n')).toMatch(/retried on the next sync/);

      expect(await syncOnce(io, CONFIG)).toMatchObject({ pushed: 2, skipped: 0 });
      expect(sinceOf(mail.calls[1])).toBe(at(2) - 1 - OVERLAP_MS);
      expect(f.calls[1]?.body.messages.map((m) => m.externalId)).toContain(
        `apple-mail:${raw(2).id}`,
      );
      expect(await loadState(io)).toEqual({ cursor: at(3) });
    });

    it('stops draining at the held message instead of paging past it', async () => {
      const mail = osascriptReturning([[raw(1), skippedLine(2)], [raw(3)]]);
      const { io, fs } = makeIo({ osascript: mail.run, fetch: scriptedFetch([ok(1, 1)]).fetch });
      await withConfig(fs);
      await syncOnce(io, CONFIG, { pageSize: 2 });
      expect(mail.calls).toHaveLength(1);
      expect((await loadState(io)).cursor).toBe(at(1));
    });

    it('gives up loudly after the third failed attempt so new mail is not held forever', async () => {
      const mail = osascriptReturning([[raw(1), skippedLine(2), raw(3)]]);
      const { io, fs, err } = makeIo({
        osascript: mail.run,
        fetch: scriptedFetch([ok(2, 2)]).fetch,
      });
      await withConfig(fs, CONFIG, { cursor: at(0), retry: { at: at(2), attempts: 2 } });
      await syncOnce(io, CONFIG);
      expect(await loadState(io)).toEqual({ cursor: at(3) });
      expect(err.join('\n')).toMatch(/WARNING.*gave up/s);
    });

    it('skips a message that cannot be normalized for good, loudly, and moves on', async () => {
      const mail = osascriptReturning([[raw(1), raw(2, { dateReceived: 'never' }), raw(3)]]);
      const { io, fs, err } = makeIo({
        osascript: mail.run,
        fetch: scriptedFetch([ok(2, 2)]).fetch,
      });
      await withConfig(fs);
      expect(await syncOnce(io, CONFIG)).toMatchObject({ pushed: 2, skipped: 1 });
      expect(await loadState(io)).toEqual({ cursor: at(3) });
      expect(err.join('\n')).toMatch(/WARNING.*will not be retried/s);
    });
  });
});
