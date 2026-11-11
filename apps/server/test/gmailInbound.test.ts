// A Gmail message as InboundMessage (adapters/gmail.ts toInbound): its Cc recipients are read too
// (https://github.com/bgoleno/opportun/issues/406), for the automatic-unsubscribe check, which
// counts To and Cc together. Every address here is made up.
import { describe, expect, it } from 'vitest';
import { toInbound } from '../src/adapters/gmail';
import type { GmailMessage } from '../src/lib/google';

const b64url = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

function gmail(headers: Record<string, string>): GmailMessage {
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    snippet: 'Hello',
    internalDate: String(Date.UTC(2026, 10, 1)),
    payload: {
      mimeType: 'text/plain',
      headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
      body: { data: b64url('Hello.') },
    },
  };
}

describe('toInbound reads Cc (#406)', () => {
  it('splits the Cc header as it splits To', async () => {
    const m = await toInbound(
      gmail({
        From: 'me@mine.example',
        To: 'unsubscribe@news.example',
        Cc: '"Recruiter, Jane" <jane@acme.example>, bob@acme.example',
        Subject: 'Off the list',
      }),
    );
    expect(m.to).toEqual(['unsubscribe@news.example']);
    expect(m.cc).toEqual(['"Recruiter, Jane" <jane@acme.example>', 'bob@acme.example']);
  });

  it('a message with no Cc header has no Cc recipients', async () => {
    const m = await toInbound(gmail({ From: 'me@mine.example', To: 'jane@acme.example' }));
    expect(m.cc).toEqual([]);
  });

  it('reads the header whatever its case, as every other header is read', async () => {
    const m = await toInbound(gmail({ From: 'me@mine.example', CC: 'jane@acme.example' }));
    expect(m.cc).toEqual(['jane@acme.example']);
  });
});
