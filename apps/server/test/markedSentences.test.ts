// https://github.com/bgoleno/opportun/issues/750, the marking pass: a sample of the sentences now
// marked for users, each read from the response as the web shows it (lib/api.ts errorMessage
// reads `message` from the envelope). The scan in userFacingErrors.test.ts covers every marked
// throw; these show the sentence actually reaches the client, through the route's own schema.
import { describe, expect, it } from 'vitest';
import { useApi } from './api';

const boot = useApi();

describe('a marked sentence reaches the client (#750)', () => {
  it("a mail filter refused for its pattern says why, echoing the caller's own pattern", async () => {
    const { a } = await boot();
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/mail-filters',
      payload: { pattern: 'nodot', effect: 'deny' },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toEqual({
      error: { code: 'invalid_pattern', message: 'Not a sender pattern: nodot' },
    });
  });

  it('a Reactive Resume address over http says to use https', async () => {
    const { a } = await boot();
    const res = await a.request({
      method: 'PUT',
      url: '/api/v1/integrations/reactive-resume',
      payload: { baseUrl: 'http://rr.example.com', apiKey: 'rr-key-750-0123456789' },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toEqual({
      code: 'invalid_base_url',
      message: 'Reactive Resume must be reached over https.',
    });
  });

  it('a purge without its confirmation word names the word', async () => {
    const { a } = await boot();
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/communications/purge',
      payload: { what: 'mail_bodies', confirm: 'nope' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toEqual({ code: 'not_confirmed', message: 'Type PURGE to confirm' });
  });
});
