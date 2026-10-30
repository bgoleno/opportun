// Cross-user isolation harness (FR-S5). Every route task adds one assertIsolated block per
// resource it creates: each user creates, the other must get 404, and the owner still reads it.
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { expect, it } from 'vitest';
import { settings } from '../src/db/schema';
import { REGISTRATION_OPEN_KEY } from '../src/lib/registration';
import { testApp, type TestAppOptions } from './helpers';

export type Response = LightMyRequestResponse;

export interface TestRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  payload?: Record<string, unknown> | unknown[] | string | Buffer;
  /** Extra headers (e.g. a multipart content-type); the CSRF header is always sent. */
  headers?: Record<string, string>;
}

/** A logged-in user: carries its session cookie and the matching CSRF token. */
export interface TestClient {
  userId: string;
  session: string;
  csrf: string;
  request(req: TestRequest): Promise<Response>;
}

const SESSION = 'opportun_session';
const CSRF = 'opportun_csrf';
const PASSWORD = 'correct horse battery';

function cookieValue(res: Response, name: string): string {
  const c = (res.cookies as { name: string; value: string }[]).find((x) => x.name === name);
  if (c === undefined || c.value === '') throw new Error(`response did not set ${name}`);
  return c.value;
}

function client(app: FastifyInstance, res: Response): TestClient {
  const session = cookieValue(res, SESSION);
  const csrf = cookieValue(res, CSRF);
  return {
    userId: res.json().user.id,
    session,
    csrf,
    request: ({ method, url, payload, headers }) =>
      app.inject({
        method,
        url,
        ...(payload === undefined ? {} : { payload }),
        cookies: { [SESSION]: session, [CSRF]: csrf },
        headers: { ...headers, 'x-csrf-token': csrf },
      }),
  };
}

async function register(app: FastifyInstance, email: string): Promise<TestClient> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: PASSWORD, displayName: email },
  });
  if (res.statusCode !== 201) throw new Error(`register ${email}: ${res.statusCode} ${res.body}`);
  return client(app, res);
}

/** Registers two users on a fresh app: a (the admin) and b (a regular user). */
export async function registerTwoUsers(
  app: FastifyInstance,
): Promise<{ a: TestClient; b: TestClient }> {
  const a = await register(app, 'isolation-a@example.com');
  // Written directly, not through PATCH /admin/registration: that route re-asks for the admin's
  // password (issue #10) and draws on the same 10-attempt budget the re-authentication tests
  // assert about, so a harness that used it would start every test with part of that spent.
  const setOpen = async (open: boolean) => {
    const now = Date.now();
    await app.db
      .insert(settings)
      .values({ key: REGISTRATION_OPEN_KEY, userId: null, value: open, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value: open, updatedAt: now } })
      .run();
  };
  await setOpen(true);
  const b = await register(app, 'isolation-b@example.com');
  await setOpen(false);
  return { a, b };
}

export interface IsolationCase {
  /** Test name suffix; defaults to a generic label. */
  name?: string;
  /** Registers test-only routes before the app is ready (harness self-tests). */
  setup?: (app: FastifyInstance) => void | Promise<void>;
  /** Fakes passed to buildApp (e.g. the Google client). */
  build?: TestAppOptions['build'];
  /** Creates the resource as `c` and returns its id. */
  create: (c: TestClient) => Promise<string>;
  /** Reads (or otherwise targets) the resource by id as `c`. */
  read: (c: TestClient, id: string) => Promise<Response>;
}

async function checkOneWay(
  opts: IsolationCase,
  owner: TestClient,
  other: TestClient,
  ownerName: string,
  otherName: string,
): Promise<void> {
  const id = await opts.create(owner);
  expect(typeof id === 'string' && id.length > 0, 'create must return the new id').toBe(true);
  const asOther = await opts.read(other, id);
  expect(
    asOther.statusCode,
    `user ${otherName} reached user ${ownerName}'s resource: ${asOther.body}`,
  ).toBe(404);
  const asOwner = await opts.read(owner, id);
  expect(
    asOwner.statusCode >= 200 && asOwner.statusCode < 300,
    `owner read must succeed for the 404 to mean anything (user ${ownerName} got ${asOwner.statusCode})`,
  ).toBe(true);
}

/**
 * The isolation check itself, in both directions: A creates and B must get 404, then B
 * creates and A must get 404. A is the admin, so the reverse pass catches an admin bypass.
 * The other user is asked first (so a destructive `read` such as DELETE cannot hide a
 * leak), then the owner must still succeed: a 404 for everyone proves nothing.
 */
export async function checkIsolation(app: FastifyInstance, opts: IsolationCase): Promise<void> {
  const { a, b } = await registerTwoUsers(app);
  await checkOneWay(opts, a, b, 'A', 'B');
  await checkOneWay(opts, b, a, 'B', 'A');
}

/** Registers a vitest test running checkIsolation (both directions) on a fresh app. */
export function assertIsolated(opts: IsolationCase): void {
  it(`isolates ${opts.name ?? 'the resource'} between users`, async () => {
    const { app } = await testApp(
      {},
      {
        ...(opts.setup === undefined ? {} : { setup: opts.setup }),
        ...(opts.build === undefined ? {} : { build: opts.build }),
      },
    );
    try {
      await checkIsolation(app, opts);
    } finally {
      await app.close();
    }
  });
}
