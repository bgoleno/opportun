// Registers the instance administrator (the first account) and reopens registration, so
// every test can register its own user and see only its own data.
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
  } finally {
    await api.dispose();
  }
}
