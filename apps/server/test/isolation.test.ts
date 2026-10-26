import { newId } from '@opportun/core';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { requireUser } from '../src/repos/base';
import { testApp } from './helpers';
import { assertIsolated, checkIsolation, registerTwoUsers, type IsolationCase } from './isolation';

/**
 * Test-only notes routes for the harness self-test. `scoped` filters by owner;
 * otherwise the read leaks every note to any signed-in user. Never registered in src.
 */
type NotesMode = 'scoped' | 'leaky' | 'nobody' | 'adminLeaky';

function notesRoutes(mode: NotesMode) {
  return (app: FastifyInstance): void => {
    const notes = new Map<string, { owner: string; text: string }>();
    app.post('/api/v1/__test/notes', async (req) => {
      const ctx = requireUser(req);
      const id = newId();
      notes.set(id, { owner: ctx.userId, text: 'hello' });
      return { id };
    });
    app.get<{ Params: { id: string } }>('/api/v1/__test/notes/:id', async (req, reply) => {
      const ctx = requireUser(req);
      const note = notes.get(req.params.id);
      const foreign = note !== undefined && note.owner !== ctx.userId;
      const hidden =
        note === undefined ||
        mode === 'nobody' ||
        (mode === 'scoped' && foreign) ||
        // Leaks only toward the admin: the forward (A creates, B reads) check cannot see it.
        (mode === 'adminLeaky' && foreign && !ctx.isAdmin);
      if (hidden) return reply.code(404).send({ error: { code: 'not_found' } });
      return { id: req.params.id, text: note.text };
    });
  };
}

const notesCase = (mode: NotesMode): IsolationCase => ({
  name: `test notes (${mode})`,
  setup: notesRoutes(mode),
  create: async (c) => (await c.request({ method: 'POST', url: '/api/v1/__test/notes' })).json().id,
  read: (c, id) => c.request({ method: 'GET', url: `/api/v1/__test/notes/${id}` }),
});

async function withApp<T>(
  setup: IsolationCase['setup'],
  fn: (app: FastifyInstance) => Promise<T>,
): Promise<T> {
  const { app } = await testApp({}, setup === undefined ? {} : { setup });
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

describe('isolation harness self-test', () => {
  it('fails when user B can read user A resource', async () => {
    const leaky = notesCase('leaky');
    await withApp(leaky.setup, async (app) => {
      await expect(checkIsolation(app, leaky)).rejects.toThrow(/user B reached user A/);
    });
  });

  it('fails when user A can read user B resource (reverse direction)', async () => {
    const adminLeaky = notesCase('adminLeaky');
    await withApp(adminLeaky.setup, async (app) => {
      await expect(checkIsolation(app, adminLeaky)).rejects.toThrow(/user A reached user B/);
    });
  });

  it('fails when even the owner cannot read, so a blanket 404 proves nothing', async () => {
    const nobody = notesCase('nobody');
    await withApp(nobody.setup, async (app) => {
      await expect(checkIsolation(app, nobody)).rejects.toThrow(/owner read must succeed/);
    });
  });

  it('registers two distinct signed-in users with csrf tokens', async () => {
    await withApp(undefined, async (app) => {
      const { a, b } = await registerTwoUsers(app);
      expect(a.userId).not.toBe(b.userId);
      for (const c of [a, b]) {
        const me = await c.request({ method: 'GET', url: '/api/v1/auth/me' });
        expect(me.json().user.id).toBe(c.userId);
        expect(c.csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
      }
      const reg = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'late@example.com', password: 'correct horse battery', displayName: 'L' },
      });
      expect(reg.statusCode).toBe(403); // registration closed again afterwards
    });
  });

  assertIsolated(notesCase('scoped'));
});

describe('requireUser', () => {
  it('rejects a request without a session with 401', async () => {
    await withApp(notesRoutes('scoped'), async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/__test/notes/x' });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: { code: 'unauthorized' } });
    });
  });

  it('is exposed as an app decorator', async () => {
    await withApp(undefined, async (app) => {
      expect(app.requireUser).toBe(requireUser);
    });
  });
});

describe('resource isolation', () => {
  // Secrets have no GET by id: DELETE is the by-id access. B goes first, so a leak
  // cannot be masked by the delete, and A's 204 proves the secret was still there.
  assertIsolated({
    name: 'secrets',
    create: async (c) =>
      (
        await c.request({
          method: 'POST',
          url: '/api/v1/secrets',
          payload: { kind: 'ai_api_key', label: 'OpenAI', value: 'sk-isolation-test' },
        })
      ).json().id,
    read: (c, id) => c.request({ method: 'DELETE', url: `/api/v1/secrets/${id}` }),
  });
});
