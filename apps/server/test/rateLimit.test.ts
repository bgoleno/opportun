import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { rateLimit } from '../src/lib/rateLimit';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** One request per minute, so the second one is always refused. */
function appRefusingAfterOne(onLimited: (req: unknown) => Promise<void> | void): FastifyInstance {
  const a = Fastify();
  a.addHook(
    'preHandler',
    rateLimit({ keyFn: () => 'one-key', limit: 1, windowMs: 60_000, onLimited }),
  );
  a.get('/thing', async () => ({ ok: true }));
  return a;
}

describe('rateLimit', () => {
  it('still answers 429 when the onLimited hook throws', async () => {
    let calls = 0;
    app = appRefusingAfterOne(() => {
      calls += 1;
      // What a failed audit write looks like from in here.
      throw new Error('database is locked');
    });

    expect((await app.inject({ method: 'GET', url: '/thing' })).statusCode).toBe(200);

    const refused = await app.inject({ method: 'GET', url: '/thing' });
    // The hook failing is the limiter's problem, not the client's: whoever is being throttled
    // must not be handed a 500 (or the 500's error body) by breaking the audit write.
    expect(calls).toBe(1);
    expect(refused.statusCode).toBe(429);
    expect(refused.headers['retry-after']).toBeDefined();
    expect(refused.json()).toEqual({ error: { code: 'rate_limited' } });
  });

  it('still answers 429 when the onLimited hook rejects', async () => {
    app = appRefusingAfterOne(() => Promise.reject(new Error('audit insert failed')));
    expect((await app.inject({ method: 'GET', url: '/thing' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/thing' })).statusCode).toBe(429);
  });
});
