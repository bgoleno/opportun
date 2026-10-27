// The demo's Caddy access log cannot see which shared demo account a request came from (it
// cannot read the session cookie), so in demo mode the app labels signed-in /api responses
// with X-Opportun-Actor and Caddy logs that header. The properties that matter: the label is a
// seeded account name and never an email, it appears only on a demo deployment, and a request
// with no session carries none.
import { describe, expect, it } from 'vitest';
import { DEMO_USERS } from '../src/cli/seedDemoFixture';
import { users } from '../src/db/schema';
import { createSession } from '../src/lib/sessions';
import { testApp } from './helpers';
import { registerTwoUsers } from './isolation';

async function sessionFor(
  app: Awaited<ReturnType<typeof testApp>>['app'],
  id: string,
  email: string,
): Promise<string> {
  const now = Date.now();
  await app.db
    .insert(users)
    .values({
      id,
      email,
      passwordHash: 'unused',
      displayName: email,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return (await createSession(app.db, id, {})).token;
}

describe('X-Opportun-Actor (demo access log)', () => {
  it('names a pinned demo account by its seeded label plus a session key, not its email', async () => {
    const { app } = await testApp({ demo: true });
    try {
      const pinned = DEMO_USERS[2]!;
      const token = await sessionFor(app, pinned.id, pinned.email);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        cookies: { opportun_session: token },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-opportun-actor']).toMatch(/^demo-user2\.[0-9a-f]{10}$/);
    } finally {
      await app.close();
    }
  });

  it('labels a signed-in user who is not a pinned demo account as demo-other, never their email', async () => {
    const { app } = await testApp({ demo: true });
    try {
      const { a } = await registerTwoUsers(app);
      const res = await a.request({ method: 'GET', url: '/api/v1/auth/me' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-opportun-actor']).toMatch(/^demo-other\.[0-9a-f]{10}$/);
    } finally {
      await app.close();
    }
  });

  it('gives two sessions on the same account different keys, and one session the same key every time', async () => {
    const { app } = await testApp({ demo: true });
    try {
      const pinned = DEMO_USERS[1]!;
      const first = await sessionFor(app, pinned.id, pinned.email);
      const second = (await createSession(app.db, pinned.id, {})).token;
      const actor = async (token: string): Promise<unknown> =>
        (
          await app.inject({
            method: 'GET',
            url: '/api/v1/auth/me',
            cookies: { opportun_session: token },
          })
        ).headers['x-opportun-actor'];
      const a1 = await actor(first);
      const a2 = await actor(first);
      const b = await actor(second);
      expect(a1).toBe(a2);
      expect(b).not.toBe(a1);
      expect(String(b)).toMatch(/^demo-user1\./);
      // The value must not carry the cookie itself, in whole or as the stored session id.
      expect(String(a1)).not.toContain(first);
    } finally {
      await app.close();
    }
  });

  it('sends nothing without a session', async () => {
    const { app } = await testApp({ demo: true });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
      expect(res.headers['x-opportun-actor']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('is off when the deployment is not the demo: a real install does not name users in headers', async () => {
    const { app } = await testApp({ demo: false });
    try {
      const pinned = DEMO_USERS[1]!;
      const token = await sessionFor(app, pinned.id, pinned.email);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        cookies: { opportun_session: token },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-opportun-actor']).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
