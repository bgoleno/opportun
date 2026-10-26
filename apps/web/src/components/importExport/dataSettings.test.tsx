import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LINKEDIN_DATA_EXPORT_HELP_URL, LINKEDIN_DATA_EXPORT_URL } from '@/lib/externalLinks';
import { mockApi, renderWithProviders } from '@/test/render';
import { DataSettings } from './DataSettings';

const report = {
  created: 6,
  updated: 1,
  skipped: 2,
  errors: [{ line: 7, message: 'stage "ofer" is not one of: discovered, interested' }],
};

describe('DataSettings', () => {
  it('uploads a pack, then shows progress, counts and per-line problems', async () => {
    let polls = 0;
    const { calls } = mockApi({
      'POST /imports': () => ({ status: 202, body: { jobId: 'job-1' } }),
      'GET /imports/job-1': () => {
        polls += 1;
        // Wrapped: the job's own `status` field would read as an HTTP status to mockApi.
        const body =
          polls === 1
            ? {
                id: 'job-1',
                status: 'running',
                attempts: 1,
                lastError: null,
                progress: { processed: 3, total: 10 },
                report: { created: 3, updated: 0, skipped: 0, errors: [] },
              }
            : {
                id: 'job-1',
                status: 'done',
                attempts: 1,
                lastError: null,
                progress: { processed: 10, total: 10 },
                report,
              };
        return { status: 200, body };
      },
      'GET /backups': () => ({ status: 403, body: { error: { code: 'forbidden' } } }),
    });
    renderWithProviders(<DataSettings />);
    const user = userEvent.setup();
    const zip = new File(['PK'], 'pack.zip', { type: 'application/zip' });
    await user.upload(await screen.findByLabelText('Zip file'), zip);
    await user.click(screen.getByRole('button', { name: 'Import' }));

    expect(await screen.findByText('3 of 10 rows')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Import progress' })).toHaveAttribute(
      'aria-valuenow',
      '30',
    );
    const table = await screen.findByRole('table', { name: 'Import problems' }, { timeout: 3000 });
    expect(within(table).getByRole('row', { name: /7 stage "ofer"/ })).toBeInTheDocument();
    expect(screen.getByText('Import finished')).toBeInTheDocument();
    expect(screen.getByText('Unchanged').nextSibling).toHaveTextContent('2');

    const upload = calls.find((c) => c.method === 'POST' && c.path === '/imports');
    expect(upload?.body).toBeInstanceOf(FormData);
    expect(((upload?.body as FormData).get('files') as File).name).toBe('pack.zip');
    // Both the Backups card and the Purge card explain the 403 (#152: Purge says it too, since
    // it is no longer silent about backup status either way).
    expect(await screen.findAllByText(/managed by its administrator/)).toHaveLength(2);
  });

  it('says how much of an archive the ingestion window left out', async () => {
    // Issue #53. An export carries everything the user ever sent or received, and the window
    // cuts most of it. Reporting those as "unchanged" would read as a bug in the import.
    mockApi({
      'POST /imports/linkedin': () => ({ status: 202, body: { jobId: 'job-win' } }),
      'GET /imports/job-win': () => ({
        status: 200,
        body: {
          id: 'job-win',
          status: 'done',
          attempts: 1,
          lastError: null,
          progress: { processed: 1818, total: 1818 },
          report: { created: 38, updated: 0, skipped: 0, outsideWindow: 1780, errors: [] },
        },
      }),
      'GET /backups': () => ({ status: 403, body: { error: { code: 'forbidden' } } }),
    });
    renderWithProviders(<DataSettings />);
    const user = userEvent.setup();
    const zip = new File(['PK'], 'Basic_LinkedInDataExport.zip', { type: 'application/zip' });
    await user.upload(await screen.findByLabelText('LinkedIn export zip'), zip);
    await user.click(screen.getByRole('button', { name: 'Import LinkedIn export' }));

    expect(await screen.findByText('Import finished')).toBeInTheDocument();
    expect(screen.getByText('Outside the window').nextSibling).toHaveTextContent('1780');
    expect(screen.getByText(/older than your sync window/i)).toBeInTheDocument();
  });

  it('counts connections LinkedIn itself stripped apart from errors (issue #132)', async () => {
    // A real export: 21 of 1775 connections have every identity field blank, for profiles
    // LinkedIn no longer has anything to show. Reporting those as errors would read as a page
    // of failures the person did nothing to cause and cannot fix.
    mockApi({
      'POST /imports/linkedin': () => ({ status: 202, body: { jobId: 'job-stripped' } }),
      'GET /imports/job-stripped': () => ({
        status: 200,
        body: {
          id: 'job-stripped',
          status: 'done',
          attempts: 1,
          lastError: null,
          progress: { processed: 1775, total: 1775 },
          report: { created: 1754, updated: 0, skipped: 0, strippedConnections: 21, errors: [] },
        },
      }),
      'GET /backups': () => ({ status: 403, body: { error: { code: 'forbidden' } } }),
    });
    renderWithProviders(<DataSettings />);
    const user = userEvent.setup();
    const zip = new File(['PK'], 'Complete_LinkedInDataExport.zip', { type: 'application/zip' });
    await user.upload(await screen.findByLabelText('LinkedIn export zip'), zip);
    await user.click(screen.getByRole('button', { name: 'Import LinkedIn export' }));

    expect(await screen.findByText('Import finished')).toBeInTheDocument();
    expect(screen.getByText('Stripped by LinkedIn').nextSibling).toHaveTextContent('21');
    expect(screen.getByText(/profile LinkedIn linked to no longer exists/i)).toBeInTheDocument();
    expect(screen.getByText('Every row imported cleanly.')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Import problems' })).not.toBeInTheDocument();
  });

  it('uploads a LinkedIn export zip as one file and follows its report', async () => {
    const { calls } = mockApi({
      'POST /imports/linkedin': () => ({ status: 202, body: { jobId: 'job-li' } }),
      'GET /imports/job-li': () => ({
        status: 200,
        body: {
          id: 'job-li',
          status: 'done',
          attempts: 1,
          lastError: null,
          progress: { processed: 8, total: 8 },
          report: { created: 5, updated: 0, skipped: 3, errors: [] },
        },
      }),
      'GET /backups': () => ({ status: 403, body: { error: { code: 'forbidden' } } }),
    });
    renderWithProviders(<DataSettings />);
    const user = userEvent.setup();
    const button = await screen.findByRole('button', { name: 'Import LinkedIn export' });
    expect(button).toBeDisabled();
    const zip = new File(['PK'], 'Basic_LinkedInDataExport.zip', { type: 'application/zip' });
    await user.upload(screen.getByLabelText('LinkedIn export zip'), zip);
    await user.click(button);

    expect(await screen.findByText('Import finished')).toBeInTheDocument();
    expect(screen.getByText('8 of 8 rows')).toBeInTheDocument();
    expect(screen.getByText('Every row imported cleanly.')).toBeInTheDocument();
    const upload = calls.find((c) => c.method === 'POST' && c.path === '/imports/linkedin');
    expect(((upload?.body as FormData).get('file') as File).name).toBe(
      'Basic_LinkedInDataExport.zip',
    );
    // The pack importer was not used.
    expect(calls.some((c) => c.method === 'POST' && c.path === '/imports')).toBe(false);
  });

  it('offers the export download and lists backups for the admin', async () => {
    mockApi({
      'GET /backups': {
        items: [
          {
            name: 'opportun-20261015-0300.db',
            bytes: 2_097_152,
            createdAt: Date.UTC(2026, 9, 15, 3),
            verified: null,
          },
        ],
        schedule: { cron: '0 3 * * *', enabled: true },
        nextRunAt: Date.UTC(2026, 9, 16, 3),
        liveCheck: null,
        filesystemHazard: null,
        lastBackupFailure: null,
      },
    });
    renderWithProviders(<DataSettings />);
    expect(await screen.findByRole('link', { name: 'Download export' })).toHaveAttribute(
      'href',
      '/api/v1/export',
    );
    const table = await screen.findByRole('table', { name: 'Backups' });
    expect(within(table).getByText('opportun-20261015-0300.db')).toBeInTheDocument();
    expect(within(table).getByText('2.0 MB')).toBeInTheDocument();
    expect(within(table).getByText('Not yet checked')).toBeInTheDocument();
    expect(screen.getByText(/Schedule: 0 3 \* \* \*/)).toBeInTheDocument();
    expect(screen.getByText('Live database: not yet checked.')).toBeInTheDocument();
  });

  it('shows a snapshot that failed its restorability check distinctly from one never checked (issue #170)', async () => {
    // A snapshot that exists but can't be restored is a worse claim than "nobody looked yet",
    // so the UI must never collapse the two into the same look.
    mockApi({
      'GET /backups': {
        items: [
          {
            name: 'opportun-20261020-0300.db',
            bytes: 1_048_576,
            createdAt: Date.UTC(2026, 9, 20, 3),
            verified: { ok: true, checkedAt: Date.UTC(2026, 9, 20, 3, 1), detail: null },
          },
          {
            name: 'opportun-20261021-0300.db',
            bytes: 2_048,
            createdAt: Date.UTC(2026, 9, 21, 3),
            verified: {
              ok: false,
              checkedAt: Date.UTC(2026, 9, 21, 3, 1),
              detail: 'file is truncated',
            },
          },
        ],
        schedule: { cron: '0 3 * * *', enabled: true },
        nextRunAt: Date.UTC(2026, 9, 22, 3),
        liveCheck: null,
        filesystemHazard: null,
        lastBackupFailure: null,
      },
    });
    renderWithProviders(<DataSettings />);
    const table = await screen.findByRole('table', { name: 'Backups' });
    const okRow = within(table).getByRole('row', { name: /opportun-20261020-0300\.db/ });
    expect(within(okRow).getByText('Verified')).toBeInTheDocument();
    const failedRow = within(table).getByRole('row', { name: /opportun-20261021-0300\.db/ });
    const failedBadge = within(failedRow).getByText('Verification failed');
    expect(failedBadge).toBeInTheDocument();
    expect(failedBadge).toHaveAttribute('title', 'file is truncated');
  });

  it("surfaces the live database's own failed check as the more serious half of a silent corruption (issue #170)", async () => {
    mockApi({
      'GET /backups': {
        items: [],
        schedule: { cron: '0 3 * * *', enabled: true },
        nextRunAt: Date.UTC(2026, 9, 22, 3),
        liveCheck: {
          ok: false,
          checkedAt: Date.UTC(2026, 9, 22, 2, 30),
          detail: 'row 4821 missing from index',
        },
        filesystemHazard: null,
        lastBackupFailure: null,
      },
    });
    renderWithProviders(<DataSettings />);
    expect(
      await screen.findByText(/Live database check FAILED.*row 4821 missing from index/),
    ).toBeInTheDocument();
  });

  it("shows the live database's own check as healthy once it has actually run (issue #170)", async () => {
    mockApi({
      'GET /backups': {
        items: [],
        schedule: { cron: '0 3 * * *', enabled: true },
        nextRunAt: Date.UTC(2026, 9, 22, 3),
        liveCheck: { ok: true, checkedAt: Date.UTC(2026, 9, 22, 2, 30), detail: null },
        filesystemHazard: null,
        lastBackupFailure: null,
      },
    });
    renderWithProviders(<DataSettings />);
    expect(await screen.findByText(/Live database: OK, checked/)).toBeInTheDocument();
  });

  it('shows a filesystem hazard found at boot, distinct from the live database check (issue #197)', async () => {
    mockApi({
      'GET /backups': {
        items: [],
        schedule: { cron: '0 3 * * *', enabled: true },
        nextRunAt: Date.UTC(2026, 9, 22, 3),
        liveCheck: { ok: true, checkedAt: Date.UTC(2026, 9, 22, 2, 30), detail: null },
        filesystemHazard: {
          fsType: 'virtiofs',
          message: 'The database directory is on a virtiofs filesystem. Move it.',
        },
        lastBackupFailure: null,
      },
    });
    renderWithProviders(<DataSettings />);
    expect(await screen.findByText(/on a virtiofs filesystem/)).toBeInTheDocument();
    // The two lines report different things and must not read as the same claim.
    expect(screen.getByText(/Live database: OK, checked/)).toBeInTheDocument();
  });

  it('shows nothing about the filesystem when no hazard was found: quiet, not reassuring (issue #197)', async () => {
    mockApi({
      'GET /backups': {
        items: [],
        schedule: { cron: '0 3 * * *', enabled: true },
        nextRunAt: Date.UTC(2026, 9, 22, 3),
        liveCheck: null,
        filesystemHazard: null,
        lastBackupFailure: null,
      },
    });
    renderWithProviders(<DataSettings />);
    await screen.findByText('Live database: not yet checked.');
    expect(screen.queryByText(/filesystem/i)).toBeNull();
  });

  it('surfaces a dead backup job, distinct from the live database check, with a link to Jobs (issue #241)', async () => {
    mockApi({
      'GET /backups': {
        items: [],
        schedule: { cron: '0 3 * * *', enabled: true },
        nextRunAt: Date.UTC(2026, 9, 22, 3),
        liveCheck: null,
        filesystemHazard: null,
        lastBackupFailure: {
          failedAt: Date.UTC(2026, 9, 22, 3, 5),
          attempts: 3,
          detail: 'pg_dump exited with status 1: server closed the connection unexpectedly',
        },
      },
    });
    renderWithProviders(<DataSettings />);
    expect(
      await screen.findByText(
        /The last backup attempt failed.*after 3 tries.*server closed the connection unexpectedly/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See Jobs' })).toHaveAttribute(
      'href',
      '/settings/jobs',
    );
  });

  it('links to LinkedIn for the archive request, with the help article as the fallback', async () => {
    mockApi({});
    renderWithProviders(<DataSettings />);
    expect(
      await screen.findByRole('link', { name: 'Request your archive on LinkedIn' }),
    ).toHaveAttribute('href', LINKEDIN_DATA_EXPORT_URL);
    expect(screen.getByRole('link', { name: "LinkedIn's instructions" })).toHaveAttribute(
      'href',
      LINKEDIN_DATA_EXPORT_HELP_URL,
    );
  });

  // The guide repeats these URLs in prose, and LinkedIn moves them. Opportun never fetches
  // linkedin.com (C-1), so the only thing worth checking is that the two copies agree: updating
  // one and not the other fails here instead of rotting silently.
  it('keeps the guide in step with the LinkedIn links', () => {
    // Under jsdom, import.meta.url is an http: URL, so the repo root comes from vitest's cwd,
    // which is this package's directory (apps/web).
    const guide = readFileSync(resolve(process.cwd(), '../../docs/guide/network.md'), 'utf8');
    expect(guide).toContain(LINKEDIN_DATA_EXPORT_URL);
    expect(guide).toContain(LINKEDIN_DATA_EXPORT_HELP_URL);
  });
});
