// The purge panel (spec D5, Plan 3 Task 4). What matters here is not that the button works: it
// is that the user sees the counts before anything happens, cannot trigger it by accident, and
// is told the truth about backups rather than something reassuring.
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import { PurgeCard } from './PurgeCard';

const PREVIEW = {
  discoveryResults: 12,
  mailBodies: 7,
  bodiesInUse: 0,
  backupRetentionDays: 14,
};

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const VERIFIED_OK = { ok: true, checkedAt: NOW - 9 * 3_600_000, detail: null };
const recentBackup = {
  items: [
    {
      name: 'opportun-20261021-0300.db',
      bytes: 1024,
      createdAt: NOW - 9 * 3_600_000,
      verified: VERIFIED_OK,
    },
  ],
  schedule: { cron: '0 3 * * *', enabled: true },
  nextRunAt: null,
  liveCheck: null,
};

describe('PurgeCard', () => {
  beforeEach(() => {
    vi.setSystemTime(NOW);
    mockApi({ 'GET /communications/purge-preview': PREVIEW, 'GET /backups': recentBackup });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows what would go before offering to do it', async () => {
    renderWithProviders(<PurgeCard />);

    const counts = await screen.findByRole('list', { name: /what would be deleted/i });
    expect(counts).toHaveTextContent('12');
    expect(counts).toHaveTextContent('7');
    expect(screen.getByRole('button', { name: /delete it/i })).toBeDisabled();
  });

  it('says that a recent backup holds what was deleted, rather than implying one always does (#152)', async () => {
    renderWithProviders(<PurgeCard />);
    expect(await screen.findByText(/a backup completed/i)).toBeInTheDocument();
    expect(screen.getByText(/14 days/i)).toBeInTheDocument();
  });

  it('says the recent backup passed its integrity check, not just that it exists (#170)', async () => {
    renderWithProviders(<PurgeCard />);
    expect(await screen.findByText(/passed its integrity check/i)).toBeInTheDocument();
    // No acknowledgment gate: a verified backup needs no extra step beyond typing the word.
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('needs the word typed, and sends what the user chose', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /communications/purge-preview': PREVIEW,
      'GET /backups': recentBackup,
      'POST /communications/purge': {
        discoveryResults: 12,
        mailBodies: { cleared: 0, deleted: 0, shared: 0, skipped: 0 },
      },
    });
    renderWithProviders(<PurgeCard />);
    await screen.findByRole('list', { name: /what would be deleted/i });
    await screen.findByText(/a backup completed/i);

    await user.click(screen.getByRole('radio', { name: /discovery content only/i }));
    const button = screen.getByRole('button', { name: /delete it/i });
    await user.type(screen.getByLabelText(/type purge to confirm/i), 'purge');
    expect(button, 'the word is the word, not a near miss').toBeDisabled();

    await user.clear(screen.getByLabelText(/type purge to confirm/i));
    await user.type(screen.getByLabelText(/type purge to confirm/i), 'PURGE');
    await user.click(button);

    const sent = calls.find((c) => c.path === '/communications/purge');
    expect(sent?.body).toEqual({ what: 'discovery', confirm: 'PURGE' });
  });

  it('says when bodies were left alone because a job is still reading them', async () => {
    mockApi({
      'GET /communications/purge-preview': { ...PREVIEW, bodiesInUse: 3 },
      'GET /backups': recentBackup,
    });
    renderWithProviders(<PurgeCard />);

    expect(await screen.findByText(/3 are being read by a job/i)).toBeInTheDocument();
  });

  describe('the backup safety net (#152)', () => {
    it('blocks the delete button on a stale backup until the person acknowledges it', async () => {
      const user = userEvent.setup();
      mockApi({
        'GET /communications/purge-preview': PREVIEW,
        'GET /backups': {
          items: [{ name: 'old.db', bytes: 1, createdAt: NOW - 9 * 24 * 3_600_000 }],
          schedule: { cron: '0 3 * * *', enabled: true },
          nextRunAt: null,
        },
      });
      renderWithProviders(<PurgeCard />);
      await screen.findByText(/more than a day ago/i);
      await user.type(screen.getByLabelText(/type purge to confirm/i), 'PURGE');
      const button = screen.getByRole('button', { name: /delete it/i });
      expect(button).toBeDisabled();

      await user.click(screen.getByRole('checkbox', { name: /no recent backup/i }));
      expect(button).toBeEnabled();
    });

    it('blocks the delete button when no backup has ever completed', async () => {
      const user = userEvent.setup();
      mockApi({
        'GET /communications/purge-preview': PREVIEW,
        'GET /backups': { items: [], schedule: null, nextRunAt: null },
      });
      renderWithProviders(<PurgeCard />);
      expect(await screen.findByText(/no backup has completed yet/i)).toBeInTheDocument();
      await user.type(screen.getByLabelText(/type purge to confirm/i), 'PURGE');
      expect(screen.getByRole('button', { name: /delete it/i })).toBeDisabled();
    });

    it('does not block on a 403 (backups are the administrator’s to see, not this user’s)', async () => {
      const user = userEvent.setup();
      mockApi({
        'GET /communications/purge-preview': PREVIEW,
        'GET /backups': () => ({ status: 403, body: { error: { code: 'forbidden' } } }),
      });
      renderWithProviders(<PurgeCard />);
      expect(await screen.findByText(/managed by its administrator/i)).toBeInTheDocument();
      await user.type(screen.getByLabelText(/type purge to confirm/i), 'PURGE');
      expect(screen.getByRole('button', { name: /delete it/i })).toBeEnabled();
      expect(screen.queryByRole('checkbox', { name: /no recent backup/i })).not.toBeInTheDocument();
    });

    it('blocks on a recent backup that failed its integrity check, with copy naming the failure (#170)', async () => {
      const user = userEvent.setup();
      mockApi({
        'GET /communications/purge-preview': PREVIEW,
        'GET /backups': {
          items: [
            {
              name: 'opportun-20261021-0300.db',
              bytes: 1024,
              createdAt: NOW - 9 * 3_600_000,
              verified: { ok: false, checkedAt: NOW - 8 * 3_600_000, detail: 'file is truncated' },
            },
          ],
          schedule: { cron: '0 3 * * *', enabled: true },
          nextRunAt: null,
          liveCheck: null,
        },
      });
      renderWithProviders(<PurgeCard />);
      expect(
        await screen.findByText(/cannot be trusted to hold what you delete/i),
      ).toBeInTheDocument();
      // Must not read like the "no backup" case: a failed backup and a missing one are not
      // the same claim, and collapsing them would hide that a backup process is actively broken.
      expect(screen.queryByText(/no backup has completed yet/i)).not.toBeInTheDocument();
      await user.type(screen.getByLabelText(/type purge to confirm/i), 'PURGE');
      const button = screen.getByRole('button', { name: /delete it/i });
      expect(button).toBeDisabled();

      await user.click(screen.getByRole('checkbox', { name: /failed verification/i }));
      expect(button).toBeEnabled();
    });

    it('does not silently wave through, or silently block, a backup nobody has checked yet (#170)', async () => {
      const user = userEvent.setup();
      mockApi({
        'GET /communications/purge-preview': PREVIEW,
        'GET /backups': {
          items: [
            {
              name: 'opportun-20261021-0300.db',
              bytes: 1024,
              createdAt: NOW - 9 * 3_600_000,
              verified: null,
            },
          ],
          schedule: { cron: '0 3 * * *', enabled: true },
          nextRunAt: null,
          liveCheck: null,
        },
      });
      renderWithProviders(<PurgeCard />);
      // Told which state this is, not left to guess.
      expect(
        await screen.findByText(/it predates that check, or tonight's scheduled check/i),
      ).toBeInTheDocument();
      // Told what to do about it.
      expect(screen.getByText(/back up now/i)).toBeInTheDocument();
      await user.type(screen.getByLabelText(/type purge to confirm/i), 'PURGE');
      const button = screen.getByRole('button', { name: /delete it/i });
      expect(button).toBeDisabled();

      await user.click(screen.getByRole('checkbox', { name: /has not been checked/i }));
      expect(button).toBeEnabled();
    });

    it('blocks on an unrelated failure to read backup status, rather than let it through', async () => {
      const user = userEvent.setup();
      mockApi({
        'GET /communications/purge-preview': PREVIEW,
        'GET /backups': () => ({ status: 500, body: { error: { code: 'internal' } } }),
      });
      renderWithProviders(<PurgeCard />);
      expect(await screen.findByText(/backup status could not be checked/i)).toBeInTheDocument();
      await user.type(screen.getByLabelText(/type purge to confirm/i), 'PURGE');
      expect(screen.getByRole('button', { name: /delete it/i })).toBeDisabled();
    });
  });
});
