import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import { PepperRotationCard } from './-pepperRotation';

describe('PepperRotationCard', () => {
  it('renders nothing when no pepper is configured', async () => {
    const { calls } = mockApi({ 'GET /admin/peppers': { currentVersion: 0, pending: [] } });
    renderWithProviders(<PepperRotationCard />);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.queryByText('Password pepper')).toBeNull();
  });

  it('reports every account rehashed as safe to drop the old secret', async () => {
    mockApi({ 'GET /admin/peppers': { currentVersion: 2, pending: [] } });
    renderWithProviders(<PepperRotationCard />);
    expect(await screen.findByText('Password pepper')).toBeInTheDocument();
    expect(
      await screen.findByText(/Every account has signed in since pepper version 2/),
    ).toBeInTheDocument();
    expect(screen.getByText(/safe to drop/)).toBeInTheDocument();
  });

  it('names the accounts that have not yet signed in since the rotation', async () => {
    mockApi({
      'GET /admin/peppers': {
        currentVersion: 2,
        pending: [
          { id: 'u1', email: 'bob@example.com', displayName: 'Bob Member', lastSignInAt: null },
        ],
      },
    });
    renderWithProviders(<PepperRotationCard />);
    expect(
      await screen.findByText(/have not signed in since pepper version 2/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Bob Member/)).toBeInTheDocument();
    expect(screen.getByText(/bob@example.com/)).toBeInTheDocument();
    expect(screen.getByText(/never signed in/)).toBeInTheDocument();
  });

  it("shows a pending account's last sign-in instead of 'never' when it has one", async () => {
    mockApi({
      'GET /admin/peppers': {
        currentVersion: 2,
        pending: [
          {
            id: 'u1',
            email: 'bob@example.com',
            displayName: 'Bob Member',
            lastSignInAt: Date.UTC(2026, 9, 15, 12),
          },
        ],
      },
    });
    renderWithProviders(<PepperRotationCard />);
    expect(await screen.findByText(/last signed in Oct 15, 2026/)).toBeInTheDocument();
    expect(screen.queryByText(/never signed in/)).toBeNull();
  });
});
