// Settings > Import/Export: upload an import pack or a LinkedIn data export and follow its
// report, download a full export, and (admin) see the nightly backups.
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Download, Upload } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { FormError } from '@/components/FormError';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/components/ui/toast';
import { ApiError, errorMessage } from '@/lib/api';
import { LINKEDIN_DATA_EXPORT_HELP_URL, LINKEDIN_DATA_EXPORT_URL } from '@/lib/externalLinks';
import { PurgeCard } from './PurgeCard';

/**
 * A file input renders as bare text under the CSS reset, which reads as a disabled control
 * rather than something to click. The input is hidden and its label carries the affordance,
 * the same pattern the attachment upload uses.
 */
const FILE_TRIGGER =
  'inline-flex h-9 w-fit cursor-pointer items-center gap-2 rounded-md border bg-card px-4 ' +
  'text-sm font-medium transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring ' +
  'hover:bg-accent hover:text-accent-foreground';
import {
  dk,
  EXPORT_URL,
  useBackups,
  useImportStatus,
  useRunBackup,
  useStartImport,
  useStartLinkedInImport,
  type BackupList,
  type ImportStatus,
  type VerifyResult,
} from './api';

const PACK_COLUMNS =
  'company, title, stage, posting_url, location, source, applied_at, dismissed_reason, notes_file, resume_doc_ref';

export function DataSettings() {
  return (
    <div className="grid gap-6">
      <ImportCard />
      <LinkedInImportCard />
      <ExportCard />
      {/* Before Purge (#152): a destructive, irreversible control reads its backup safety net
          more honestly when the actual backup status is already on screen above it. */}
      <BackupsCard />
      <PurgeCard />
    </div>
  );
}

function ImportCard() {
  const [files, setFiles] = useState<File[]>([]);
  const [jobId, setJobId] = useState<string>();
  const start = useStartImport();
  const status = useImportStatus(jobId);
  const zipInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  function pick(list: FileList | null, other: HTMLInputElement | null) {
    setFiles(list === null ? [] : Array.from(list));
    if (other !== null) other.value = '';
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (files.length === 0) return;
    setJobId(undefined);
    start.mutate(files, { onSuccess: ({ jobId: id }) => setJobId(id) });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Import</CardTitle>
        <CardDescription>
          Upload a zip or a folder with <code>opportunities.csv</code> (columns: {PACK_COLUMNS}),
          optionally <code>contacts.csv</code> (name, email, linkedin_url, company, notes) and the
          Markdown notes it refers to. Importing the same pack again changes nothing: rows match on
          company, title and location, and stages only move forward.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="import-zip">Zip file</Label>
              <input
                id="import-zip"
                ref={zipInput}
                type="file"
                accept=".zip,application/zip"
                className="peer sr-only"
                onChange={(e) => pick(e.target.files, folderInput.current)}
              />
              <label htmlFor="import-zip" className={FILE_TRIGGER}>
                <Upload className="size-4" aria-hidden="true" />
                Choose zip file
              </label>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="import-folder">Or a folder</Label>
              <input
                id="import-folder"
                ref={(el) => {
                  folderInput.current = el;
                  el?.setAttribute('webkitdirectory', '');
                }}
                type="file"
                multiple
                className="peer sr-only"
                onChange={(e) => pick(e.target.files, zipInput.current)}
              />
              <label htmlFor="import-folder" className={FILE_TRIGGER}>
                <Upload className="size-4" aria-hidden="true" />
                Choose folder
              </label>
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">
              {files.length === 0
                ? 'Nothing chosen yet. Import stays disabled until you choose a zip or a folder.'
                : files.length === 1
                  ? files[0]!.name
                  : `${String(files.length)} files chosen`}
            </p>
            <Button type="submit" disabled={files.length === 0 || start.isPending}>
              <Upload aria-hidden="true" />
              {start.isPending ? 'Uploading...' : 'Import'}
            </Button>
          </div>
          {start.error ? <FormError message={errorMessage(start.error)} /> : null}
        </form>
        {jobId !== undefined ? (
          <ImportProgress
            status={status.data}
            error={status.error ? errorMessage(status.error) : undefined}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

/** The LinkedIn data export upload (FR-C2): the app never contacts LinkedIn itself. */
function LinkedInImportCard() {
  const [file, setFile] = useState<File>();
  const [jobId, setJobId] = useState<string>();
  const start = useStartLinkedInImport();
  const status = useImportStatus(jobId);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (file === undefined) return;
    setJobId(undefined);
    start.mutate(file, { onSuccess: ({ jobId: id }) => setJobId(id) });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>LinkedIn export</CardTitle>
        <CardDescription>
          Ask LinkedIn for a copy of your data, then upload the zip it emails you: connections
          become contacts and messages land in the inbox. Opportun never connects to LinkedIn, and
          importing a newer export again only adds what changed.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="mb-4 grid gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          <p>
            <a
              className="font-medium underline"
              href={LINKEDIN_DATA_EXPORT_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              Request your archive on LinkedIn
            </a>{' '}
            and choose <strong>Download larger data archive</strong>, then press Request archive.
            The file-by-file picker under it does not offer connections or messages, so the larger
            archive is the one to ask for.
          </p>
          <p>
            LinkedIn sends it in two emails: a first part, then a second part up to 24 hours later.
            Import whichever zip holds Connections.csv and messages.csv, or both if you are unsure,
            since importing an archive it has already seen only adds what changed. If that link does
            not open the right page, in LinkedIn go to Settings, Data privacy, Get a copy of your
            data (
            <a
              className="underline"
              href={LINKEDIN_DATA_EXPORT_HELP_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              LinkedIn&apos;s instructions
            </a>
            ).
          </p>
        </div>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="linkedin-zip">LinkedIn export zip</Label>
            <input
              id="linkedin-zip"
              type="file"
              accept=".zip,application/zip"
              className="peer sr-only"
              onChange={(e) => setFile(e.target.files?.[0])}
            />
            <label htmlFor="linkedin-zip" className={FILE_TRIGGER}>
              <Upload className="size-4" aria-hidden="true" />
              Choose zip file
            </label>
            <p className="text-xs text-muted-foreground">
              {file === undefined
                ? 'No file chosen yet. Import stays disabled until you choose one.'
                : file.name}
            </p>
          </div>
          <div>
            <Button type="submit" disabled={file === undefined || start.isPending}>
              <Upload aria-hidden="true" />
              {start.isPending ? 'Uploading...' : 'Import LinkedIn export'}
            </Button>
          </div>
          {start.error ? <FormError message={errorMessage(start.error)} /> : null}
        </form>
        {jobId !== undefined ? (
          <ImportProgress
            status={status.data}
            error={status.error ? errorMessage(status.error) : undefined}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

export function ImportProgress({
  status,
  error,
}: {
  status: ImportStatus | undefined;
  error?: string | undefined;
}) {
  if (error !== undefined) return <FormError message={error} />;
  if (status === undefined) {
    return <p className="mt-4 text-sm text-muted-foreground">Starting import...</p>;
  }
  const { progress, report } = status;
  const finished = status.status === 'done';
  const pct =
    progress === null || progress.total === 0
      ? finished
        ? 100
        : 0
      : Math.round((progress.processed / progress.total) * 100);
  return (
    <div className="mt-6 grid gap-4" aria-live="polite">
      <div className="grid gap-1">
        <div className="flex justify-between text-sm">
          <span className="font-medium">
            {status.status === 'dead'
              ? 'Import failed'
              : finished
                ? 'Import finished'
                : 'Importing...'}
          </span>
          {progress !== null ? (
            <span className="text-muted-foreground">
              {progress.processed} of {progress.total} rows
            </span>
          ) : null}
        </div>
        <div
          role="progressbar"
          aria-label="Import progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          className="h-2 overflow-hidden rounded-full bg-muted"
        >
          <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>
      {status.status === 'dead' && status.lastError !== null ? (
        <FormError message={status.lastError} />
      ) : null}
      {report !== null ? (
        <>
          <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
            {(
              [
                ['Created', report.created],
                ['Updated', report.updated],
                ['Unchanged', report.skipped],
                // Only an importer that applies the ingestion window reports this, and leaving
                // it out would make an archive import look like it lost most of the file.
                ...(report.outsideWindow === undefined || report.outsideWindow === 0
                  ? []
                  : ([['Outside the window', report.outsideWindow]] as const)),
                // Same treatment, same reason (issue #132): a long-lived LinkedIn account's
                // export carries connections LinkedIn itself stripped of every field but the
                // date, and a page of "errors" nobody can fix is worse than not mentioning it.
                ...(report.strippedConnections === undefined || report.strippedConnections === 0
                  ? []
                  : ([['Stripped by LinkedIn', report.strippedConnections]] as const)),
              ] as const
            ).map(([label, n]) => (
              <div key={label} className="rounded-md border px-3 py-2">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-lg font-semibold">{n}</dd>
              </div>
            ))}
          </dl>
          {report.outsideWindow === undefined || report.outsideWindow === 0 ? null : (
            <p className="text-xs text-muted-foreground">
              Those messages are older than your sync window, so they were not imported. The window
              is the one on the Gmail card in Integrations, and it applies to everything Opportun
              reads. Widen it and import the file again to take more of it.
            </p>
          )}
          {report.strippedConnections === undefined || report.strippedConnections === 0 ? null : (
            <p className="text-xs text-muted-foreground">
              These connections are exactly as LinkedIn exported them: no name, profile link, email,
              company or role, usually because the profile LinkedIn linked to no longer exists.
              There is nothing in the file to import for them, so they are counted here rather than
              as errors.
            </p>
          )}
          {report.errors.length > 0 ? (
            <Table aria-label="Import problems">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20">Line</TableHead>
                  <TableHead>Problem</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.errors.map((e, i) => (
                  <TableRow key={`${e.line}-${i}`}>
                    <TableCell>{e.line}</TableCell>
                    <TableCell>{e.message}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : finished ? (
            <p className="text-sm text-muted-foreground">Every row imported cleanly.</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function ExportCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Export</CardTitle>
        <CardDescription>
          A zip of everything you own: <code>export.json</code> with every table, a Markdown summary
          per opportunity, and <code>opportunities.csv</code> you can import again. Stored keys and
          tokens are never included.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild variant="outline">
          <a href={EXPORT_URL} download>
            <Download aria-hidden="true" />
            Download export
          </a>
        </Button>
      </CardContent>
    </Card>
  );
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** issue #170: "exists" and "restorable" are different claims, so this never collapses a
 *  genuine failure into the same look as "nobody has checked yet". */
function VerifiedBadge({ verified }: { verified: VerifyResult | null }) {
  if (verified === null) {
    return <Badge variant="outline">Not yet checked</Badge>;
  }
  if (!verified.ok) {
    return (
      <Badge variant="destructive" title={verified.detail ?? undefined}>
        Verification failed
      </Badge>
    );
  }
  return <Badge variant="success">Verified</Badge>;
}

/** The live database's own most recent scheduled check (issue #170), distinct from the
 *  snapshots' own verification: a bad live database is the more serious half of what a
 *  silent corruption costs. */
function LiveCheckLine({ liveCheck }: { liveCheck: VerifyResult | null }) {
  if (liveCheck === null) {
    return <p className="text-sm text-muted-foreground">Live database: not yet checked.</p>;
  }
  if (!liveCheck.ok) {
    return (
      <p className="text-sm text-destructive">
        Live database check FAILED {dateTime.format(liveCheck.checkedAt)}
        {liveCheck.detail !== null ? `: ${liveCheck.detail}` : ''}
      </p>
    );
  }
  return (
    <p className="text-sm text-muted-foreground">
      Live database: OK, checked {dateTime.format(liveCheck.checkedAt)}.
    </p>
  );
}

/**
 * A filesystem known to be unsafe for SQLite's WAL locking (issue #197), said once at boot and
 * shown here too since a log line is read once if ever. Distinct from LiveCheckLine on
 * purpose: this reports what was observed about the substrate, not a check that watches the
 * data for corruption (dbIntegrityCheck.ts is that). Nothing renders when there is no hazard:
 * an ordinary filesystem earns no reassuring line, only a quiet absence of one.
 */
function FilesystemHazardLine({ hazard }: { hazard: BackupList['filesystemHazard'] }) {
  if (hazard === null) return null;
  return <p className="text-sm text-destructive">{hazard.message}</p>;
}

/**
 * The backup job's own status (issue #241), distinct from LiveCheckLine: that reports on the
 * database's content, this reports on whether the backup mechanism itself has been succeeding.
 * Before this, a dead backup job was visible only at Settings -> Jobs, a page with no reason to
 * think to check while this one looked empty rather than failing.
 */
function LastBackupFailureLine({ failure }: { failure: BackupList['lastBackupFailure'] }) {
  if (failure === null) return null;
  return (
    <p className="text-sm text-destructive">
      The last backup attempt failed {dateTime.format(failure.failedAt)} after {failure.attempts}{' '}
      {failure.attempts === 1 ? 'try' : 'tries'}
      {failure.detail !== null ? `: ${failure.detail}` : ''}.{' '}
      <Link to="/settings/jobs" className="underline">
        See Jobs
      </Link>
      .
    </p>
  );
}

function BackupsCard() {
  const backups = useBackups();
  const run = useRunBackup();
  const qc = useQueryClient();
  const forbidden = backups.error instanceof ApiError && backups.error.status === 403;

  function backupNow() {
    run.mutate(undefined, {
      onSuccess: () => {
        toast({ title: 'Backup queued', description: 'It will appear here in a moment.' });
        window.setTimeout(() => void qc.invalidateQueries({ queryKey: dk.backups }), 3000);
      },
    });
  }

  const data = backups.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Backups</CardTitle>
        <CardDescription>
          The server snapshots its database every night into <code>data/backups/</code> and keeps
          the 14 newest. See the install guide for restoring one.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {backups.isPending ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : forbidden ? (
          <p className="text-sm text-muted-foreground">
            Backups cover the whole instance and are managed by its administrator.
          </p>
        ) : backups.isError ? (
          <FormError message={errorMessage(backups.error)} />
        ) : data !== undefined ? (
          <>
            <p className="text-sm text-muted-foreground">
              {data.schedule === null || !data.schedule.enabled
                ? 'Nightly backups are switched off.'
                : `Schedule: ${data.schedule.cron} (server time).`}
              {data.nextRunAt !== null ? ` Next: ${dateTime.format(data.nextRunAt)}.` : ''}
            </p>
            <LastBackupFailureLine failure={data.lastBackupFailure} />
            <LiveCheckLine liveCheck={data.liveCheck} />
            <FilesystemHazardLine hazard={data.filesystemHazard} />
            {data.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">No backups yet.</p>
            ) : (
              <Table aria-label="Backups">
                <TableHeader>
                  <TableRow>
                    <TableHead>Taken</TableHead>
                    <TableHead>File</TableHead>
                    <TableHead className="text-right">Size</TableHead>
                    <TableHead>Verified</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((b) => (
                    <TableRow key={b.name}>
                      <TableCell>{dateTime.format(b.createdAt)}</TableCell>
                      <TableCell className="font-mono text-xs">{b.name}</TableCell>
                      <TableCell className="text-right">{size(b.bytes)}</TableCell>
                      <TableCell>
                        <VerifiedBadge verified={b.verified} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <div>
              <Button variant="outline" disabled={run.isPending} onClick={backupNow}>
                Back up now
              </Button>
            </div>
            {run.error ? <FormError message={errorMessage(run.error)} /> : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
