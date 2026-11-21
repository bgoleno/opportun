// The clients' copies of the server's field limits (#649): the Apple Mail connector cuts a message
// to the mail route's schema caps, and the browser extension cuts a capture to the capture route's,
// so a field over them never fails a whole request. Each copy is checked against the server's own
// schema, by what it accepts: exactly at the client's limit passes, one more fails. A limit changed
// on one side only fails here.
import { describe, expect, it } from 'vitest';
import { MAX_ADDRESS, MAX_KEY, MAX_RECIPIENTS, MAX_SUBJECT } from '../../connector/src/normalize';
import { PAGE_SIZE } from '../../connector/src/sync';
import { MAX_TEXT, MAX_TITLE } from '../../../packages/extension/src/limits';
import { CaptureBody } from '../src/routes/connectorCapture';
import { InboundMessageSchema, MAX_BATCH_MESSAGES } from '../src/routes/connectorMail';

const message = (over: Record<string, unknown> = {}) => ({
  externalId: 'apple-mail:<id@example.com>',
  threadKey: 'thread',
  from: 'Recruiter <r@example.com>',
  to: ['me@example.com'],
  subject: 'Hello',
  snippet: 'Hi',
  bodyText: 'Body',
  sentAt: 1_795_000_000_000,
  ...over,
});
const passes = (over: Record<string, unknown>) =>
  InboundMessageSchema.safeParse(message(over)).success;

describe('the connector cuts mail to the mail route’s limits', () => {
  it.each([
    ['externalId', MAX_KEY],
    ['threadKey', MAX_KEY],
    ['subject', MAX_SUBJECT],
  ])('%s: %i characters pass, one more does not', (field, limit) => {
    expect(passes({ [field]: 'x'.repeat(limit) })).toBe(true);
    expect(passes({ [field]: 'x'.repeat(limit + 1) })).toBe(false);
  });

  it('an address: as long as the connector keeps it passes, one more does not', () => {
    expect(passes({ from: 'x'.repeat(MAX_ADDRESS) })).toBe(true);
    expect(passes({ from: 'x'.repeat(MAX_ADDRESS + 1) })).toBe(false);
    expect(passes({ to: ['x'.repeat(MAX_ADDRESS)] })).toBe(true);
    expect(passes({ to: ['x'.repeat(MAX_ADDRESS + 1)] })).toBe(false);
  });

  it('recipients: as many as the connector keeps pass, one more does not', () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => `r${i}@example.com`);
    for (const field of ['to', 'cc']) {
      expect(passes({ [field]: list(MAX_RECIPIENTS) }), field).toBe(true);
      expect(passes({ [field]: list(MAX_RECIPIENTS + 1) }), field).toBe(false);
    }
  });

  it('a batch holds as many messages as the connector sends at once', () => {
    expect(PAGE_SIZE).toBe(MAX_BATCH_MESSAGES);
  });
});

describe('the extension cuts a capture to the capture route’s limits', () => {
  const capture = (over: Record<string, unknown>) =>
    CaptureBody.safeParse({
      url: 'https://www.linkedin.com/jobs/view/1/',
      title: 'T',
      text: 'x',
      ...over,
    }).success;

  it.each([
    ['title', MAX_TITLE],
    ['text', MAX_TEXT],
  ])('%s: %i characters pass, one more does not', (field, limit) => {
    expect(capture({ [field]: 'x'.repeat(limit) })).toBe(true);
    expect(capture({ [field]: 'x'.repeat(limit + 1) })).toBe(false);
  });
});
