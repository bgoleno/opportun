// Settings > Data > "Delete stored content" (spec D5, Plan 3 Task 4).
//
// The one destructive action in the mail funnel the user triggers themselves, so the panel is
// built to be understood before it is used: the counts come first, the word has to be typed, and
// the copy says what a purge does NOT reach. Claiming that purging makes something unrecoverable
// would be a lie while nightly snapshots exist, and the honest version is more useful anyway.
import { useState } from 'react';
import { FormError } from '@/components/FormError';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toast';
import { ApiError, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/opportunities';
import { useBackups, usePurge, usePurgePreview, type PurgeOutcome } from './api';

/** The word the server wants typed, so a stray click cannot do this. */
const CONFIRMATION = 'PURGE';

/**
 * How long ago the most recent completed backup may be before this panel stops treating it as
 * a safety net (issue #152): the schedule is nightly (BACKUP_CRON, apps/server/src/jobs/backup.ts),
 * so one day plus a few hours of slack for when the job actually runs. This checks that a
 * snapshot THIS JOB wrote and moved into place exists recently -- listBackups only recognizes
 * its own opportun-<date>-<time> names, so a file an external script produced (any name, any
 * timestamp) is invisible to it and cannot satisfy this check; see backup.test.ts's regression
 * test for exactly that. Existing and recent is not the same claim as restorable -- issue #165
 * is the proof those differ: a same-named, plausibly-sized backup file existed and was
 * malformed. See `BackupSafety` below for how restorability itself is checked, and the card's
 * own copy for exactly what each state claims.
 */
const BACKUP_FRESH_MS = 26 * 3_600_000;

/**
 * What the most recent backup within the freshness window actually earns (issue #170's
 * `verified` folded in here, not left as the "exists and completed" guarantee alone):
 * - `none`: no recent completed backup at all (stale, missing, or unreadable).
 * - `unverified`: a recent backup exists but has never been checked for restorability (it
 *   predates #170, or tonight's scheduled check hasn't run against it yet). Deliberately its
 *   own state rather than folded into either neighbor: treating it as `verified` would show a
 *   green check next to a backup nobody has confirmed, and treating it as `none` would say
 *   "no backup" about a file that exists, which is its own false claim in the other direction.
 * - `failed`: a recent backup exists and is already known bad. This is worse than `none`, not
 *   the same as it: it means the automated backup process is actively producing files that
 *   will not restore, not merely that one hasn't run recently.
 * - `verified`: a recent backup exists and passed its integrity check.
 */
type BackupSafety = 'none' | 'unverified' | 'failed' | 'verified';

const summarize = (out: PurgeOutcome): string =>
  [
    out.discoveryResults > 0 ? `${out.discoveryResults} discovery results emptied` : null,
    out.mailBodies.cleared > 0 ? `${out.mailBodies.cleared} message bodies deleted` : null,
    out.mailBodies.skipped > 0 ? `${out.mailBodies.skipped} left for a pending job` : null,
  ]
    .filter((part) => part !== null)
    .join(', ') || 'nothing left to delete';

export function PurgeCard() {
  const preview = usePurgePreview();
  const purge = usePurge();
  const backups = useBackups();
  const [typed, setTyped] = useState('');
  const [what, setWhat] = useState<'discovery' | 'mail_bodies' | 'both'>('both');
  const [acknowledgedRisk, setAcknowledgedRisk] = useState(false);

  const counts = preview.data;
  const nonAdmin = backups.error instanceof ApiError && backups.error.status === 403;
  // Settled either way: a successful read, or a 403 (not this user's to see, issue #152's own
  // point about not collapsing distinct states applied here too). Any OTHER failure to read
  // backup status (a 500, a dropped connection) is treated as unsafe, the same as a stale or
  // missing backup, rather than optimistically let it through just because the check itself
  // broke: "the check failed" is not "backups are fine".
  const backupsSettled = backups.isSuccess || backups.isError;
  const lastBackup = backups.data?.items[0];
  const lastBackupAt = lastBackup?.createdAt;
  const hasRecentBackup =
    lastBackupAt !== undefined && Date.now() - lastBackupAt <= BACKUP_FRESH_MS;
  const safety: BackupSafety = !hasRecentBackup
    ? 'none'
    : lastBackup!.verified === null
      ? 'unverified'
      : lastBackup!.verified.ok
        ? 'verified'
        : 'failed';
  const knownUnsafe = backupsSettled && !nonAdmin && safety !== 'verified';
  const ready =
    typed === CONFIRMATION &&
    counts !== undefined &&
    backupsSettled &&
    (!knownUnsafe || acknowledgedRisk);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Delete stored content</CardTitle>
        <CardDescription>
          Opportun keeps as little as it can of your mail and of the postings it finds. This deletes
          what was stored before it worked that way, or any time you would rather it held less.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {preview.isError ? <FormError message={errorMessage(preview.error)} /> : null}
        {counts === undefined ? (
          <p className="text-sm text-muted-foreground">Counting...</p>
        ) : (
          <ul className="grid gap-1 text-sm" aria-label="What would be deleted">
            <li>
              <strong className="tabular-nums">{counts.discoveryResults}</strong> discovery results
              would keep their company and role, and lose the description, the link and the
              model&apos;s notes. Anything you accepted is never touched.
            </li>
            <li>
              <strong className="tabular-nums">{counts.mailBodies}</strong> stored message bodies
              would be deleted. Each message keeps its sender, its date and its link back to your
              mailbox.
            </li>
            {counts.bodiesInUse > 0 ? (
              <li className="text-muted-foreground">
                {counts.bodiesInUse} are being read by a job that has not finished, and are left
                alone until it has.
              </li>
            ) : null}
          </ul>
        )}

        <p className="text-xs text-muted-foreground">
          This changes the live database and cannot be undone from here.{' '}
          {nonAdmin
            ? 'Backups cover the whole instance and are managed by its administrator; check with them that one has completed recently and passed its integrity check before deleting.'
            : safety === 'verified'
              ? `A backup completed ${formatDateTime(lastBackupAt!)} and passed its integrity check; it should hold what you delete, for up to ${counts?.backupRetentionDays ?? 14} days, after which it ages out on its own.`
              : safety === 'failed'
                ? `A backup completed ${formatDateTime(lastBackupAt!)} but failed its integrity check, so it cannot be trusted to hold what you delete.`
                : safety === 'unverified'
                  ? `A backup completed ${formatDateTime(lastBackupAt!)}, but it has not been checked for restorability (it predates that check, or tonight's scheduled check hasn't run against it yet). "Back up now" on the Backups card above produces one that is checked immediately.`
                  : backups.isError
                    ? 'Backup status could not be checked just now, so nothing is confirmed to protect this deletion.'
                    : lastBackupAt === undefined
                      ? 'No backup has completed yet, so nothing protects this deletion.'
                      : `The last completed backup was ${formatDateTime(lastBackupAt)}, more than a day ago, so nothing recent protects this deletion.`}
        </p>
        {knownUnsafe ? (
          <div className="grid gap-2 rounded-md border border-destructive/50 p-3">
            <p className="text-sm font-medium text-destructive">
              {safety === 'failed'
                ? 'The most recent backup failed its integrity check, so nothing you delete here will be recoverable from it.'
                : safety === 'unverified'
                  ? 'The most recent backup has not been checked for restorability, so Opportun cannot confirm it would recover anything you delete here.'
                  : 'Nothing you delete here will be recoverable from a recent backup.'}
            </p>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-4"
                checked={acknowledgedRisk}
                onChange={(e) => setAcknowledgedRisk(e.currentTarget.checked)}
              />
              {safety === 'failed'
                ? 'I understand the most recent backup failed verification, and this deletion cannot be undone from here.'
                : safety === 'unverified'
                  ? 'I understand the most recent backup has not been checked for restorability, and this deletion cannot be undone from here.'
                  : 'I understand there is no recent backup, and this deletion cannot be undone from here.'}
            </label>
          </div>
        ) : null}

        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">What to delete</legend>
          {(
            [
              ['both', 'Discovery content and message bodies'],
              ['discovery', 'Discovery content only'],
              ['mail_bodies', 'Message bodies only'],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="purge-what"
                className="size-4"
                checked={what === value}
                onChange={() => setWhat(value)}
              />
              {label}
            </label>
          ))}
        </fieldset>

        <div className="grid gap-2">
          <Label htmlFor="purge-confirm">Type {CONFIRMATION} to confirm</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="purge-confirm"
              className="w-40 font-mono"
              value={typed}
              onChange={(e) => setTyped(e.currentTarget.value)}
            />
            <Button
              type="button"
              variant="destructive"
              disabled={!ready || purge.isPending}
              onClick={() =>
                purge.mutate(
                  { what, confirm: typed },
                  {
                    onSuccess: (out) => {
                      setTyped('');
                      toast({ title: `Deleted: ${summarize(out)}` });
                    },
                    onError: (err) => toast({ title: errorMessage(err), variant: 'destructive' }),
                  },
                )
              }
            >
              Delete it
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
