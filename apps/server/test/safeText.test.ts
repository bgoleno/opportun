// Text Postgres would reject (review item 4): a NUL character, or a lone UTF-16 surrogate
// (an emoji cut in half by a length limit) cannot be stored in a Postgres text or jsonb value.
// Inbound text is cleaned at the boundaries where it enters (mail ingest, the import pack, the
// LinkedIn export) on every dialect, and clean text passes through unchanged.
import { zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { communications } from '../src/db/schema';
import { OPPORTUNITY_COLUMNS, packFromFiles, packFromZip } from '../src/lib/importer';
import { linkedInPackFromZip, parseConnections } from '../src/lib/linkedinExport';
import { cleanText, truncateText } from '../src/lib/safeText';
import { upsertInbound } from '../src/repos/communications';
import { testApp } from './helpers';
import { registerTwoUsers } from './isolation';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

const EMOJI = '\u{1F600}'; // two UTF-16 code units
const enc = new TextEncoder();

describe('cleanText / truncateText', () => {
  it('drops NUL characters and lone surrogates', () => {
    expect(cleanText('a\u0000b')).toBe('ab');
    expect(cleanText(`x${EMOJI.slice(0, 1)}`)).toBe('x');
    expect(cleanText(`${EMOJI.slice(1)}y`)).toBe('y');
  });

  it('returns clean text unchanged, emoji and all', () => {
    const clean = `Grüße ${EMOJI} 日本 \t\n "quotes" \\ back`;
    expect(cleanText(clean)).toBe(clean);
    expect(truncateText(clean, 1000)).toBe(clean);
  });

  it('truncates without splitting a surrogate pair', () => {
    expect(truncateText(`ab${EMOJI}`, 3)).toBe('ab');
    expect(truncateText(`ab${EMOJI}`, 4)).toBe(`ab${EMOJI}`);
    expect(truncateText('a\u0000bcd', 3)).toBe('abc');
  });
});

describe('inbound boundaries', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('mail ingest stores a NUL subject and a mid-emoji "to" cleanly, clean mail byte-identical', async () => {
    ({ app } = await testApp());
    const { a } = await registerTwoUsers(app);
    const ctx = { userId: a.userId, isAdmin: false };
    const message = (externalId: string, subject: string, to: string[]) => ({
      externalId,
      threadKey: `t-${externalId}`,
      from: 'Recruiter <r@example.com>',
      to,
      subject,
      snippet: `snippet\u0000 ${EMOJI}`,
      bodyText: 'body',
      sentAt: 1,
    });
    // 997 x's then an emoji: the 998-character limit cuts the emoji in half.
    const longTo = `${'x'.repeat(997)}${EMOJI}`;
    const dirty = await upsertInbound(
      app.db,
      ctx,
      'gmail',
      message('m1', 'Offer\u0000 letter', [longTo]),
    );
    const row = await app.db
      .select()
      .from(communications)
      .where(eq(communications.id, dirty.id))
      .get();
    expect(row?.subject).toBe('Offer letter');
    expect(row?.snippet).toBe(`snippet ${EMOJI}`);
    expect(row?.to).toEqual(['x'.repeat(997)]);
    const cleanSubject = `Re: ${EMOJI} next steps`;
    const clean = await upsertInbound(
      app.db,
      ctx,
      'gmail',
      message('m2', cleanSubject, ['owner@example.com']),
    );
    const cleanRow = await app.db
      .select()
      .from(communications)
      .where(eq(communications.id, clean.id))
      .get();
    expect(cleanRow?.subject).toBe(cleanSubject);
    expect(cleanRow?.to).toEqual(['owner@example.com']);
    expect(cleanRow?.from).toBe('Recruiter <r@example.com>');
  });

  it('the import pack drops NUL characters from its files', () => {
    const header = OPPORTUNITY_COLUMNS.join(',');
    const blanks = ','.repeat(OPPORTUNITY_COLUMNS.length - 3);
    const csv = `${header}\nAcme\u0000,PM,interested${blanks}\n`;
    const want = `${header}\nAcme,PM,interested${blanks}\n`;
    const files = packFromFiles([{ name: 'opportunities.csv', data: enc.encode(csv) }]);
    expect(files.opportunitiesCsv).toBe(want);
    const zipped = packFromZip(zipSync({ 'opportunities.csv': enc.encode(csv) }));
    expect(zipped.opportunitiesCsv).toBe(want);
  });

  it('the LinkedIn export drops NUL characters and cuts names on whole characters', () => {
    const header = 'First Name,Last Name,URL,Email Address,Company,Position,Connected On';
    const company = `${'c'.repeat(199)}${EMOJI}`;
    const csv = `${header}\nAnn\u0000,Lee,,,${company},PM,01 Jan 2026\n`;
    const pack = linkedInPackFromZip(zipSync({ 'Connections.csv': enc.encode(csv) }));
    expect(pack.connectionsCsv).not.toContain('\u0000');
    const { rows } = parseConnections(pack.connectionsCsv ?? '');
    expect(rows[0]?.name).toBe('Ann Lee');
    expect(rows[0]?.company).toBe('c'.repeat(199));
  });
});
