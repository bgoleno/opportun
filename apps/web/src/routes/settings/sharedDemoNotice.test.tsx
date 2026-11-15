// #546 (slice 3 of #542; tl and sec's note, and decisions 132 and 133): on one of the demo's shared
// accounts, Settings > Profile and its application details say that what is entered there is
// visible to others on the account, and the places where mail is connected say so of email by
// name. A dedicated account on a demo server is a normal one, and sees none of it. Every name and
// address here is made up.
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { GoogleStatus } from '@/components/resume/api';
import { SHARED_DEMO_MAIL_WARNING, SHARED_DEMO_WARNING } from '@/components/SharedDemoNotice';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import { DevicesCard } from './-devices';
import { GmailCard } from './integrations';
import { ProfileSettings } from './profile';

const onboarding = (sharedDemoAccount: boolean) => ({
  'GET /onboarding': {
    tour: { version: 1, status: 'completed', stepId: null, startedAt: null, finishedAt: null },
    checklist: {
      aiKey: false,
      mail: false,
      firstOpportunity: true,
      dismissed: true,
      activatedAt: null,
    },
    autoStart: false,
    demo: true,
    sharedDemoAccount,
  },
});

const PROFILE = {
  userId: 'u1',
  fullName: 'Jane Doe',
  headline: null,
  email: null,
  phone: null,
  location: null,
  workAuth: null,
  links: [],
  applicationDetails: {},
  updatedAt: 1,
};

const GOOGLE: GoogleStatus = {
  connected: false,
  scopes: [],
  clientConfigured: true,
  clientId: 'client',
  redirectUri: 'https://opportun.example.ts.net/api/v1/integrations/google/callback',
  jsOrigin: 'https://opportun.example.ts.net',
  signInRedirectUri: 'https://opportun.example.ts.net/api/v1/auth/oauth/google/callback',
  aiAvailable: false,
  validation: null,
};

const card = (heading: string) =>
  screen.getByRole('heading', { name: heading }).closest('[data-slot="card"]') as HTMLElement;

/** Waits until `/onboarding` has answered, so an absent warning is absent for good. */
async function answered(api: { calls: ApiCall[] }) {
  await waitFor(() =>
    expect(api.calls.filter((c) => c.path === '/onboarding').length).toBeGreaterThan(0),
  );
  await new Promise((r) => setTimeout(r, 20));
}

describe('#546: Settings > Profile on a shared demo account', () => {
  it('the profile and its application details each carry the warning', async () => {
    mockApi({ ...onboarding(true), 'GET /profile': PROFILE });
    renderWithProviders(<ProfileSettings />);
    await screen.findByRole('heading', { name: 'Application details' });
    for (const heading of ['Profile', 'Application details']) {
      await waitFor(() =>
        expect(within(card(heading)).getByText(SHARED_DEMO_WARNING)).toBeVisible(),
      );
    }
  });

  it('a dedicated account sees no warning', async () => {
    const api = mockApi({ ...onboarding(false), 'GET /profile': PROFILE });
    renderWithProviders(<ProfileSettings />);
    await screen.findByRole('heading', { name: 'Application details' });
    await answered(api);
    expect(screen.queryByText(SHARED_DEMO_WARNING)).toBeNull();
  });
});

describe('#546: where mail is connected, on a shared demo account', () => {
  const devices = {
    'GET /device-tokens': { items: [] },
    'GET /integrations/apple-mail': {
      connected: false,
      lastSyncAt: null,
      status: null,
      count: 0,
      staleHint: null,
    },
  };
  const gmail = {
    'GET /integrations/google': GOOGLE,
    'GET /integrations/gmail': {
      connected: false,
      lastSyncAt: null,
      count: 0,
      status: null,
      lookbackDays: 180,
    },
  };

  it('the Apple Mail connector names email in its warning', async () => {
    mockApi({ ...onboarding(true), ...devices });
    renderWithProviders(<DevicesCard />);
    const c = (await screen.findByRole('heading', { name: 'Extensions and Connectors' })).closest(
      '[data-slot="card"]',
    ) as HTMLElement;
    const notice = await within(c).findByRole('status', { name: 'Shared demo account' });
    expect(notice).toHaveTextContent(SHARED_DEMO_MAIL_WARNING);
    expect(notice).toHaveTextContent(/email/i);
    expect(notice).toHaveTextContent(/senders, subjects and text/);
    expect(notice).toHaveTextContent(/confirmed/);
  });

  it('the Gmail card names email in its warning', async () => {
    mockApi({ ...onboarding(true), ...gmail });
    renderWithProviders(<GmailCard />);
    const notice = await screen.findByRole('status', { name: 'Shared demo account' });
    expect(notice).toHaveTextContent(SHARED_DEMO_MAIL_WARNING);
  });

  it('a dedicated account sees no mail warning in either place', async () => {
    const api = mockApi({ ...onboarding(false), ...devices, ...gmail });
    renderWithProviders(
      <>
        <DevicesCard />
        <GmailCard />
      </>,
    );
    await screen.findByRole('heading', { name: 'Extensions and Connectors' });
    await screen.findByRole('heading', { name: 'Gmail' });
    await answered(api);
    expect(screen.queryByRole('status', { name: 'Shared demo account' })).toBeNull();
    expect(screen.queryByText(SHARED_DEMO_MAIL_WARNING)).toBeNull();
  });
});
