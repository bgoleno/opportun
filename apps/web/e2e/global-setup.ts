// Registers the instance administrator (the first account) and reopens registration, so
// every test can register its own user and see only its own data.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request, type FullConfig } from '@playwright/test';

export const ADMIN = {
  displayName: 'E2E Admin',
  email: 'e2e-admin@example.com',
  password: 'correct horse battery staple',
};

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (baseURL === undefined) throw new Error('baseURL is not configured');
  const api = await request.newContext({ baseURL });
  try {
    const reg = await api.post('/api/v1/auth/register', { data: ADMIN });
    if (!reg.ok())
      throw new Error(`admin registration failed: ${reg.status()} ${await reg.text()}`);
    const state = await api.storageState();
    const csrf = state.cookies.find((c) => c.name === 'opportun_csrf')?.value ?? '';
    const open = await api.patch('/api/v1/admin/registration', {
      data: { open: true, password: ADMIN.password },
      headers: { 'x-csrf-token': csrf },
    });
    if (!open.ok()) throw new Error(`opening registration failed: ${open.status()}`);
    // The admin is a brand-new account too: record the tour as declined, as Not now does, so
    // flows that sign in as the admin are not met by the first-run tour (FR-U11).
    const tour = await api.put('/api/v1/onboarding/tour', {
      data: { status: 'skipped', stepId: 'welcome' },
      headers: { 'x-csrf-token': csrf },
    });
    if (!tour.ok()) throw new Error(`declining the admin's tour failed: ${tour.status()}`);
    // The admin's session, kept for every spec that acts as the admin, so the suite signs the
    // admin in through the form only where sign-in itself is under test: each sign-in spends the
    // login limit, 10 per address and email in 15 minutes (routes/auth.ts LOGIN_LIMIT; #776).
    // Stored in a directory of its own, made fresh for the run (mode 0700 from mkdtemp), and read
    // by helpers.ts (adminContext, signInAsAdmin) through E2E_ADMIN_STATE: an environment
    // variable set here is passed on to every worker. global-teardown.ts removes the directory.
    const dir = await mkdtemp(join(tmpdir(), 'opportun-e2e-admin-'));
    const path = join(dir, 'admin-state.json');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this run's own temp file
    await writeFile(path, JSON.stringify(await api.storageState()), { mode: 0o600 });
    process.env.E2E_ADMIN_STATE = path;
  } finally {
    await api.dispose();
  }
}
