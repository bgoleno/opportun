// Assisted apply is on by default (https://github.com/bgoleno/opportun/issues/455): unset, empty
// or 1 is on, 0 is off, anything else refuses to start. tl's criteria and sec's conditions are on
// the issue. Every setting here is read through loadConfig, so the tests hold the parsing an
// operator's environment goes through, not a Config a test wrote by hand.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, submissionsEnabled, type Config } from '../src/config';
import { readSchedules } from '../src/jobs/runner';
import { SUBMISSION_EXPIRE_JOB_KIND } from '../src/jobs/submissionExpire';
import { SUBMISSION_FOLLOWUP_JOB_KIND } from '../src/jobs/submissionFollowup';
import { SNAPSHOT_RECONCILE_JOB_KIND } from '../src/jobs/submissionSnapshot';
import { restartableTestApp } from './helpers';
import { registerTwoUsers, type TestClient } from './isolation';
import { api, handedOffAttempt } from './submissionFixtures';

const ENV = {
  OPPORTUN_MASTER_KEY: randomBytes(32).toString('hex'),
  OPPORTUN_BASE_URL: 'https://opportun.example.com',
  DATA_DIR: '/data',
};
const PASSWORD = 'correct horse battery';

/** The two settings the feature reads, as loadConfig gives them for this environment. */
function settingsFor(extra: NodeJS.ProcessEnv): Pick<Config, 'submissions' | 'demo'> {
  const cfg = loadConfig({ ...ENV, ...extra });
  return { submissions: cfg.submissions, demo: cfg.demo };
}
const UNSET = {};
const OFF = { OPPORTUN_SUBMISSIONS: '0' };

describe('OPPORTUN_SUBMISSIONS (criterion 3)', () => {
  it.each([
    ['unset', UNSET],
    ['empty, as compose.yml passes it when .env has no line', { OPPORTUN_SUBMISSIONS: '' }],
    ['1', { OPPORTUN_SUBMISSIONS: '1' }],
  ])('%s is on', (_n, env) => {
    expect(loadConfig({ ...ENV, ...env }).submissions).toBe(true);
  });

  it('0 is off', () => {
    expect(loadConfig({ ...ENV, ...OFF }).submissions).toBe(false);
  });

  // Before #455 every value but 1 was off, so an operator who wrote one of these meant off. On
  // after the upgrade would be a silent change of meaning, so the server refuses to start.
  it.each(['false', 'off', 'no', 'true', 'yes', 'on', ' 1', '1 ', '01', '2'])(
    '%j refuses to start, naming the variable',
    (value) => {
      let thrown: unknown;
      try {
        loadConfig({ ...ENV, OPPORTUN_SUBMISSIONS: value });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ConfigError);
      expect((thrown as Error).message).toMatch(/OPPORTUN_SUBMISSIONS/);
      expect((thrown as Error).message).toMatch(/\b0\b/);
    },
  );
});

// Every app a test boots, closed after it.
const opened: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((o) => o.close()));
});

async function bootWith(env: NodeJS.ProcessEnv) {
  const handle = await restartableTestApp(settingsFor(env));
  opened.push(handle);
  const { a } = await registerTwoUsers(handle.app());
  return { handle, app: handle.app(), a };
}

const mint = (c: TestClient, scopes: string[]) =>
  c.request({
    method: 'POST',
    url: '/api/v1/device-tokens',
    payload: { name: 'Chrome', scopes, password: PASSWORD },
  });

const current = (app: FastifyInstance, token: string, url: string) =>
  app.inject({
    method: 'GET',
    url: `/api/v1/connector/apply/current?url=${encodeURIComponent(url)}`,
    headers: { authorization: `Bearer ${token}` },
  });

const SCHEDULES = [
  SUBMISSION_EXPIRE_JOB_KIND,
  SUBMISSION_FOLLOWUP_JOB_KIND,
  SNAPSHOT_RECONCILE_JOB_KIND,
] as const;
const kinds = async (app: FastifyInstance) => (await readSchedules(app.db)).map((r) => r.kind);

describe('a fresh install with no setting (criterion 1)', () => {
  it('has assisted apply: the routes, an apply:assist token and the three schedules', async () => {
    const { app, a } = await bootWith(UNSET);
    expect(submissionsEnabled(app.config)).toBe(true);
    // The Apply panel's own routes: the whole draft, review and handoff, then its history.
    const s = await handedOffAttempt(app, a);
    const history = await api(a, 'GET', `/opportunities/${s.oppId}/submissions`);
    expect(history.statusCode, history.body).toBe(200);
    const minted = await mint(a, ['apply:assist']);
    expect(minted.statusCode, minted.body).toBe(201);
    const res = await current(app, minted.json().token as string, s.ats.url as string);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().attempt.id).toBe(s.id);
    expect(await kinds(app)).toEqual(expect.arrayContaining([...SCHEDULES]));
  });
});

describe('OPPORTUN_SUBMISSIONS=0 (criterion 2)', () => {
  it('has no routes, no apply:assist token and none of the three schedules', async () => {
    const { app, a } = await bootWith(OFF);
    expect(submissionsEnabled(app.config)).toBe(false);
    const minted = await mint(a, ['apply:assist']);
    expect(minted.statusCode, minted.body).toBe(422);
    expect(minted.json().error.code).toBe('scope_unavailable');
    const opp = await api(
      a,
      'GET',
      '/opportunities/00000000-0000-7000-8000-000000000000/submissions',
    );
    expect(opp.statusCode).toBe(404);
    expect(opp.json().error.code).toBe('feature_unavailable');
    const scheduled = await kinds(app);
    for (const kind of SCHEDULES) expect(scheduled).not.toContain(kind);
  });

  // Criterion 6: until #455 few installs went from on to off, and boot removed only the snapshot
  // reconcile schedule. Now 0 after an upgrade is the usual way off, so it removes all three.
  it('after a boot with it on, leaves none of the three schedules', async () => {
    const { handle, app } = await bootWith(UNSET);
    expect(await kinds(app)).toEqual(expect.arrayContaining([...SCHEDULES]));
    const off = await handle.restart(settingsFor(OFF));
    const scheduled = await kinds(off);
    for (const kind of SCHEDULES) expect(scheduled).not.toContain(kind);
  });
});

// Criterion 5 (sec's condition 3): turning the feature off never revoked a token. A token made
// while it was on reaches nothing with 0, and works again once the variable is gone, which is
// what the changelog tells an operator who removed the variable to turn it off.
describe('an apply:assist token across the upgrade (criterion 5)', () => {
  it('reaches no apply route with 0, and reaches them again with the variable unset', async () => {
    const { handle, app, a } = await bootWith({ OPPORTUN_SUBMISSIONS: '1' });
    const s = await handedOffAttempt(app, a);
    const minted = await mint(a, ['apply:assist']);
    expect(minted.statusCode, minted.body).toBe(201);
    const token = minted.json().token as string;
    const page = s.ats.url as string;
    expect((await current(app, token, page)).statusCode).toBe(200);

    const off = await handle.restart(settingsFor(OFF));
    const refused = await current(off, token, page);
    expect(refused.statusCode, refused.body).toBe(404);
    expect(refused.json().error.code).toBe('feature_unavailable');

    const upgraded = await handle.restart(settingsFor(UNSET));
    const again = await current(upgraded, token, page);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().attempt.id).toBe(s.id);
  });
});

describe('the demo never has it (criterion 4)', () => {
  it.each([
    ['unset', { OPPORTUN_DEMO: '1' }],
    ['1', { OPPORTUN_DEMO: '1', OPPORTUN_SUBMISSIONS: '1' }],
  ])('with the variable %s', async (_n, env) => {
    const { app, a } = await bootWith(env);
    expect(app.config.demo).toBe(true);
    expect(submissionsEnabled(app.config)).toBe(false);
    const minted = await mint(a, ['apply:assist']);
    expect(minted.statusCode, minted.body).toBe(422);
    expect(minted.json().error.code).toBe('scope_unavailable');
    const capture = await mint(a, ['capture:push']);
    expect(capture.statusCode, capture.body).toBe(201);
    const routed = await current(app, capture.json().token as string, 'https://example.com/job');
    expect(routed.statusCode, routed.body).toBe(404);
    const opp = await api(
      a,
      'GET',
      '/opportunities/00000000-0000-7000-8000-000000000000/submissions',
    );
    expect(opp.statusCode).toBe(404);
    expect(opp.json().error.code).toBe('feature_unavailable');
    const scheduled = await kinds(app);
    for (const kind of SCHEDULES) expect(scheduled).not.toContain(kind);
  });
});
