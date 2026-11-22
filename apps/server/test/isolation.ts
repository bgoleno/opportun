// Cross-user isolation harness (FR-S5). Every route task adds one assertIsolated block per
// resource it creates: each user creates, the other must get 404, and the owner still reads it.
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { expect, it } from 'vitest';
import { DEMO_USERS } from '../src/lib/demo/fixture';
import { settings, users } from '../src/db/schema';
import { hashPassword, NO_PEPPERS } from '../src/lib/passwords';
import { REGISTRATION_OPEN_KEY } from '../src/lib/registration';
import type { Config } from '../src/config';
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
export const PASSWORD = 'correct horse battery';

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

/**
 * Signs in an existing account through POST /auth/login (no 2FA). A second call for the same
 * account is a second, separate session: what another person signed in to the same shared demo
 * account holds (#545). Its own session cookie, so its own demo actor.
 */
export async function signIn(
  app: FastifyInstance,
  email: string,
  password = PASSWORD,
): Promise<TestClient> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  if (res.statusCode !== 200) throw new Error(`sign in ${email}: ${res.statusCode} ${res.body}`);
  return client(app, res);
}

/**
 * Signs in as one of the demo seed's pinned accounts (`DEMO_USERS[index]`): a shared demo account,
 * where the demo's own-data rules and the visitor binding apply (decision 133). The user row is
 * written directly with the test password, as the seed would, and then signed in through the
 * route. A user registered the usual way is not pinned: on a demo server, that is an account made
 * for one person, which behaves as on any instance.
 */
export async function sharedDemoUser(app: FastifyInstance, index: number): Promise<TestClient> {
  const user = DEMO_USERS.at(index);
  if (user === undefined) throw new Error(`no pinned demo user ${String(index)}`);
  const now = Date.now();
  await app.db
    .insert(users)
    .values({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      passwordHash: await hashPassword(PASSWORD, app.config.peppers ?? NO_PEPPERS),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();
  return await signIn(app, user.email);
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

// Written directly, not through PATCH /admin/registration: that route re-asks for the admin's
// password (issue #10) and draws on the same 10-attempt budget the re-authentication tests
// assert about, so a harness that used it would start every test with part of that spent.
async function setRegistrationOpen(app: FastifyInstance, open: boolean): Promise<void> {
  const now = Date.now();
  await app.db
    .insert(settings)
    .values({ key: REGISTRATION_OPEN_KEY, userId: null, value: open, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: open, updatedAt: now } })
    .run();
}

/** Registers two users on a fresh app: a (the admin) and b (a regular user). */
export async function registerTwoUsers(
  app: FastifyInstance,
): Promise<{ a: TestClient; b: TestClient }> {
  const a = await register(app, 'isolation-a@example.com');
  await setRegistrationOpen(app, true);
  const b = await register(app, 'isolation-b@example.com');
  await setRegistrationOpen(app, false);
  return { a, b };
}

/** One more regular user, after registerTwoUsers: registration is opened for it and closed again. */
export async function registerAnotherUser(
  app: FastifyInstance,
  email: string,
): Promise<TestClient> {
  await setRegistrationOpen(app, true);
  try {
    return await register(app, email);
  } finally {
    await setRegistrationOpen(app, false);
  }
}

export interface IsolationCase {
  /** Test name suffix; defaults to a generic label. */
  name?: string;
  /** Registers test-only routes before the app is ready (harness self-tests). */
  setup?: (app: FastifyInstance) => void | Promise<void>;
  /** Fakes passed to buildApp (e.g. the Google client). */
  build?: TestAppOptions['build'];
  /** Config overrides for the app, e.g. a feature flag the resource needs (#114). */
  config?: Partial<Config>;
  /** Creates the resource as `c` and returns its id. `app` is there for fixtures that need it. */
  create: (c: TestClient, app: FastifyInstance) => Promise<string>;
  /** Reads (or otherwise targets) the resource by id as `c`. */
  read: (c: TestClient, id: string, app: FastifyInstance) => Promise<Response>;
}

async function checkOneWay(
  app: FastifyInstance,
  opts: IsolationCase,
  owner: TestClient,
  other: TestClient,
  ownerName: string,
  otherName: string,
): Promise<void> {
  const id = await opts.create(owner, app);
  expect(typeof id === 'string' && id.length > 0, 'create must return the new id').toBe(true);
  const asOther = await opts.read(other, id, app);
  expect(
    asOther.statusCode,
    `user ${otherName} reached user ${ownerName}'s resource: ${asOther.body}`,
  ).toBe(404);
  const asOwner = await opts.read(owner, id, app);
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
  await checkOneWay(app, opts, a, b, 'A', 'B');
  await checkOneWay(app, opts, b, a, 'B', 'A');
}

/** Registers a vitest test running checkIsolation (both directions) on a fresh app. */
export function assertIsolated(opts: IsolationCase): void {
  it(`isolates ${opts.name ?? 'the resource'} between users`, async () => {
    const { app } = await testApp(opts.config ?? {}, {
      ...(opts.setup === undefined ? {} : { setup: opts.setup }),
      ...(opts.build === undefined ? {} : { build: opts.build }),
    });
    try {
      await checkIsolation(app, opts);
    } finally {
      await app.close();
    }
  });
}
