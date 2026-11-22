// #546 (slice 3 of #542; tl and sec's note, and decisions 132 and 133): on one of the demo's shared
// accounts, Settings > Profile and its application details say that what is entered there is
// visible to others on the account, and the places where mail is connected say so of email by
// name. A dedicated account on a demo server is a normal one, and sees none of it. Every name and
// address here is made up.
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { GoogleStatus } from '@/components/resume/api';
import { Attachments } from '@/components/opportunity/DetailsPanel';
import {
  SHARED_DEMO_DOCUMENTS_WARNING,
  SHARED_DEMO_FILES_WARNING,
  SHARED_DEMO_GOOGLE_WARNING,
  SHARED_DEMO_MAIL_WARNING,
  SHARED_DEMO_TWO_FACTOR_WARNING,
  SHARED_DEMO_WARNING,
} from '@/components/SharedDemoNotice';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import { DevicesCard } from './-devices';
import { GmailCard, GoogleCard, ReactiveResumeCard } from './integrations';
import { TwoFactorCard } from './-twoFactor';
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

// #618, criterion 1 (decision 133: a notice, not a refusal): what a visitor connects for resumes on
// a shared account is everyone's on it until the reset. Google: their Drive, through the OAuth
// client saved here. Reactive Resume: the store new resumes go to.
describe('#618: where resumes are stored, on a shared demo account', () => {
  const stores = {
    'GET /integrations/google': GOOGLE,
    'GET /integrations/reactive-resume': {
      baseUrl: null,
      keySet: false,
      connected: false,
      targetVersions: ['6.0'],
    },
    'GET /settings/document-store': { store: 'google_doc' },
  };

  it('the Google card says the connected Drive is used by everyone on the account', async () => {
    mockApi({ ...onboarding(true), ...stores });
    renderWithProviders(<GoogleCard flash={undefined} />);
    await screen.findByRole('heading', { name: 'Google' });
    const notice = await within(card('Google')).findByRole('status', {
      name: 'Shared demo account',
    });
    expect(notice).toHaveTextContent(SHARED_DEMO_GOOGLE_WARNING);
    expect(notice).toHaveTextContent(/Drive/);
    expect(notice).toHaveTextContent(/nightly reset/);
  });

  it('the Reactive Resume card says the store gets everyone’s new resumes', async () => {
    mockApi({ ...onboarding(true), ...stores });
    renderWithProviders(<ReactiveResumeCard />);
    await screen.findByRole('heading', { name: 'Reactive Resume' });
    const notice = await within(card('Reactive Resume')).findByRole('status', {
      name: 'Shared demo account',
    });
    expect(notice).toHaveTextContent(SHARED_DEMO_DOCUMENTS_WARNING);
    expect(notice).toHaveTextContent(/new resumes/);
  });

  it('a dedicated account sees neither', async () => {
    const api = mockApi({ ...onboarding(false), ...stores });
    renderWithProviders(
      <>
        <GoogleCard flash={undefined} />
        <ReactiveResumeCard />
      </>,
    );
    await screen.findByRole('heading', { name: 'Google' });
    await screen.findByRole('heading', { name: 'Reactive Resume' });
    await answered(api);
    expect(screen.queryByRole('status', { name: 'Shared demo account' })).toBeNull();
  });
});

// #671 (qa's demo-flow check): a file a visitor attaches, and two-factor sign-in a visitor turns
// on, are everyone's business on a shared account too: the one is readable by all on it, the
// other locks them out. Told, as elsewhere (decision 133); a dedicated account sees neither.
describe('#671: the attachment upload and two-factor setup, on a shared demo account', () => {
  const places = {
    'GET /opportunities/o1/attachments': { items: [], total: 0 },
    'GET /opportunities/o1/submissions': { items: [] },
    'GET /auth/2fa': { enabled: false, recoveryCodesLeft: 0 },
  };
  const both = () => (
    <>
      <Attachments opportunityId="o1" />
      <TwoFactorCard />
    </>
  );

  it('the attachment upload says files are seen by everyone on the account, until the reset', async () => {
    mockApi({ ...onboarding(true), ...places });
    renderWithProviders(both());
    await screen.findByRole('heading', { name: 'Attachments' });
    const notice = await within(card('Attachments')).findByRole('status', {
      name: 'Shared demo account',
    });
    expect(notice).toHaveTextContent(SHARED_DEMO_FILES_WARNING);
    expect(notice).toHaveTextContent(/nightly reset/);
  });

  it('two-factor setup says turning it on locks the others out until the reset', async () => {
    mockApi({ ...onboarding(true), ...places });
    renderWithProviders(both());
    await screen.findByRole('heading', { name: /Two-factor sign-in/ });
    const twoFactor = screen
      .getByRole('heading', { name: /Two-factor sign-in/ })
      .closest('[data-slot="card"]') as HTMLElement;
    const notice = await within(twoFactor).findByRole('status', {
      name: 'Shared demo account',
    });
    expect(notice).toHaveTextContent(SHARED_DEMO_TWO_FACTOR_WARNING);
    expect(notice).toHaveTextContent(/locks/);
  });

  // #682 (qa on #676): once two-factor sign-in is on, the account is locked to whoever turned it
  // on; telling the next visitor that turning it on would lock others out says nothing true.
  it('once two-factor sign-in is on, the two-factor notice is gone', async () => {
    const api = mockApi({
      ...onboarding(true),
      ...places,
      'GET /auth/2fa': { enabled: true, recoveryCodesLeft: 8 },
    });
    renderWithProviders(<TwoFactorCard />);
    const heading = await screen.findByRole('heading', { name: /Two-factor sign-in/ });
    const twoFactor = heading.closest('[data-slot="card"]') as HTMLElement;
    await answered(api);
    // The card shows it is on, so the answer is in.
    await within(twoFactor).findByText(/8 recovery codes left/);
    expect(within(twoFactor).queryByRole('status', { name: 'Shared demo account' })).toBeNull();
    expect(twoFactor).not.toHaveTextContent(SHARED_DEMO_TWO_FACTOR_WARNING);
  });

  it('a dedicated account sees neither', async () => {
    const api = mockApi({ ...onboarding(false), ...places });
    renderWithProviders(both());
    await screen.findByRole('heading', { name: 'Attachments' });
    await screen.findByRole('heading', { name: /Two-factor sign-in/ });
    await answered(api);
    expect(screen.queryByRole('status', { name: 'Shared demo account' })).toBeNull();
  });
});
