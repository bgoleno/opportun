import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { mockApi } from '@/test/render';
import { forceLocalSignOut, logout, meQuery } from './auth';

const USER = { id: 'u1', email: 'owner@example.com', displayName: 'Alex Rivera', isAdmin: false };

/**
 * Issue #151: clearing the local session is only honest once the server has actually
 * confirmed it ended. These pin the exact ordering `logout` and `forceLocalSignOut` have to
 * keep, apart from any component wired on top of them.
 */
describe('logout', () => {
  it('clears the cache only after the server confirms the session ended', async () => {
    const qc = new QueryClient();
    qc.setQueryData(meQuery.queryKey, USER);
    mockApi({ 'POST /auth/logout': { status: 204, body: null } });

    await logout(qc);

    expect(qc.getQueryData(meQuery.queryKey)).toBeNull();
  });

  it('leaves the cache alone and throws when the server call fails', async () => {
    const qc = new QueryClient();
    qc.setQueryData(meQuery.queryKey, USER);
    mockApi({
      'POST /auth/logout': () => ({ status: 500, body: { error: { code: 'server_error' } } }),
    });

    await expect(logout(qc)).rejects.toThrow();
    // The point of #151: still signed in here, since the server never confirmed otherwise.
    expect(qc.getQueryData(meQuery.queryKey)).toEqual(USER);
  });
});

describe('forceLocalSignOut', () => {
  it("clears this browser's own session belief with no server call at all", () => {
    const qc = new QueryClient();
    qc.setQueryData(meQuery.queryKey, USER);

    forceLocalSignOut(qc);

    expect(qc.getQueryData(meQuery.queryKey)).toBeNull();
  });
});
