// The Inbox refuses a keyword or sender filter over the server's limit itself, in plain words, and
// never sends it (https://github.com/bgoleno/opportun/issues/894). Its copy of the limit is checked
// against the route: exactly at it is answered, one more is refused.
import { expect, it } from 'vitest';
import { INBOX_FILTER_MAX } from '../../web/src/components/comms/limits';
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
