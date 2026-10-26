import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { GoogleStatus } from '@/components/resume/api';
import { mockApi, renderWithProviders } from '@/test/render';
import { GoogleCard } from './integrations';

function status(over: Partial<GoogleStatus> = {}): GoogleStatus {
  return {
    connected: false,
    scopes: [],
    clientConfigured: false,
    clientId: null,
    redirectUri: 'https://opportun.example.ts.net/api/v1/integrations/google/callback',
    jsOrigin: 'https://opportun.example.ts.net',
    aiAvailable: false,
    validation: null,
    ...over,
  };
}

describe('GoogleCard', () => {
  it('tells a failed session check apart from no session at all (issue #108)', async () => {
    mockApi({ 'GET /integrations/google': status() });
    renderWithProviders(<GoogleCard flash="unavailable" />);
    expect(
      await screen.findByText(/something went wrong checking you were signed in/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/had no login session/i)).toBeNull();
  });
});
