// The Inbox refuses a keyword or sender filter over the server's limit itself, in plain words, and
// never sends it (https://github.com/bgoleno/opportun/issues/894). Its copy of the limit is checked
// against the route: exactly at it is answered, one more is refused.
import { expect, it } from 'vitest';
import { filterTooLong, INBOX_FILTER_MAX } from '../../web/src/components/comms/limits';
import { useApi } from './api';

const boot = useApi();

it.each(['q', 'sender'])('%s: the Inbox’s limit is the route’s', async (param) => {
  const { a } = await boot();
  const ask = (n: number) =>
    a.request({
      method: 'GET',
      url: `/api/v1/communications?view=needs_review&${param}=${'x'.repeat(n)}`,
    });
  expect((await ask(INBOX_FILTER_MAX)).statusCode).toBe(200);
  expect((await ask(INBOX_FILTER_MAX + 1)).statusCode).toBe(400);
});

// Both count characters, not UTF-16 units (#896): an emoji is one.
it.each(['q', 'sender'] as const)(
  '%s: the Inbox counts characters as the route does',
  async (param) => {
    const { a } = await boot();
    const ask = (text: string) =>
      a.request({
        method: 'GET',
        url: `/api/v1/communications?view=needs_review&${param}=${encodeURIComponent(text)}`,
      });
    for (const n of [101, INBOX_FILTER_MAX, INBOX_FILTER_MAX + 1]) {
      const text = '\u{1F600}'.repeat(n);
      const taken = (await ask(text)).statusCode === 200;
      expect(filterTooLong(text)).toBe(!taken);
      expect(taken).toBe(n <= INBOX_FILTER_MAX);
    }
  },
);
