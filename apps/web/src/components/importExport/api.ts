// Import, export and backup data for Settings > Import/Export (FR-I1 to I4).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface ImportReport {
  created: number;
  updated: number;
  skipped: number;
  /** Rows the ingestion window left out; only the LinkedIn import reports it (issue #53). */
  outsideWindow?: number;
  /** LinkedIn connections with no name, link, email, company or role at all; only the
   *  LinkedIn import reports it (issue #132). */
  strippedConnections?: number;
  errors: { line: number; message: string }[];
}

export interface ImportStatus {
  id: string;
  status: 'pending' | 'running' | 'done' | 'dead';
  attempts: number;
  lastError: string | null;
  progress: { processed: number; total: number } | null;
  report: ImportReport | null;
}

/** issue #170: a snapshot "existing and completed" is not "restorable" -- null means never
 *  checked (a snapshot from before this shipped), distinct from checked and bad. */
export interface VerifyResult {
  ok: boolean;
  checkedAt: number;
  detail: string | null;
}

export interface BackupList {
  items: { name: string; bytes: number; createdAt: number; verified: VerifyResult | null }[];
  schedule: { cron: string; enabled: boolean } | null;
  nextRunAt: number | null;
  /** The live database's own most recent scheduled check (issue #170); null on Postgres or
   *  before the first scheduled run. */
  liveCheck: VerifyResult | null;
  /** The database directory's filesystem, checked once at boot (issue #197); null on Postgres
   *  or when it is not one known to be unsafe for SQLite's WAL locking. */
  filesystemHazard: { fsType: string; message: string } | null;
  /** The most recent backup attempt, when it exhausted its retries instead of succeeding
   *  (issue #241). Null when the most recent attempt is not dead, or none has run yet. */
  lastBackupFailure: { failedAt: number; attempts: number; detail: string | null } | null;
}

export const dk = {
  import: (id: string) => ['imports', id] as const,
  backups: ['backups'] as const,
  purgePreview: ['purge-preview'] as const,
};

export const EXPORT_URL = '/api/v1/export';
const POLL_MS = 1000;

/** Uploads a zip or the files of a folder (each named by its path inside the folder). */
export function useStartImport() {
  return useMutation({
    mutationFn: (files: File[]) => {
      const body = new FormData();
      for (const f of files) body.append('files', f, f.webkitRelativePath || f.name);
      return api<{ jobId: string }>('/imports', { method: 'POST', body });
    },
  });
}

/** Uploads a LinkedIn data export zip (FR-C2): the only way LinkedIn data enters the app. */
export function useStartLinkedInImport() {
  return useMutation({
    mutationFn: (file: File) => {
      const body = new FormData();
      body.append('file', file, file.name);
      return api<{ jobId: string }>('/imports/linkedin', { method: 'POST', body });
    },
  });
}

/** Polls an import job until it is done or dead. */
export function useImportStatus(jobId: string | undefined) {
  return useQuery({
    queryKey: dk.import(jobId ?? ''),
    queryFn: () => api<ImportStatus>(`/imports/${encodeURIComponent(jobId ?? '')}`),
    enabled: jobId !== undefined,
    staleTime: 0,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === 'done' || s === 'dead' ? false : POLL_MS;
    },
  });
}

export function useBackups() {
  return useQuery({
    queryKey: dk.backups,
    queryFn: () => api<BackupList>('/backups'),
    retry: false,
  });
}

export function useRunBackup() {
  return useMutation({
    mutationFn: () => api<{ jobId: string }>('/backups', { method: 'POST' }),
  });
}

/** What a purge would take (spec D5). A read: nothing happens until the user asks. */
export interface PurgePreview {
  discoveryResults: number;
  mailBodies: number;
  bodiesInUse: number;
  backupRetentionDays: number;
}

export interface PurgeOutcome {
  discoveryResults: number;
  mailBodies: { cleared: number; deleted: number; shared: number; skipped: number };
}

export function usePurgePreview() {
  return useQuery({
    queryKey: dk.purgePreview,
    queryFn: () => api<PurgePreview>('/communications/purge-preview'),
  });
}

export function usePurge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { what: 'discovery' | 'mail_bodies' | 'both'; confirm: string }) =>
      api<PurgeOutcome>('/communications/purge', { method: 'POST', body }),
    onSettled: () => {
      // The counts the preview showed are stale the moment a purge runs, and so is every inbox
      // and discovery view that was showing what it took.
      void qc.invalidateQueries({ queryKey: dk.purgePreview });
      void qc.invalidateQueries({ queryKey: ['communications'] });
      void qc.invalidateQueries({ queryKey: ['discovery'] });
    },
  });
}
