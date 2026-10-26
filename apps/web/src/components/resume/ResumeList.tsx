// The resumes page: register a base resume (Google Docs, or Reactive Resume when chosen in
// Settings > Integrations) and list every resume.
import { Link } from '@tanstack/react-router';
import { Search, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { FormError } from '@/components/FormError';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/opportunities';
import {
  resumeErrorMessage,
  statusLabel,
  useCreateResume,
  useDeleteResume,
  useDocumentStore,
  useGoogleStatus,
  useReactiveResumeStatus,
  useResumes,
  type DriveSearchHit,
  type Resume,
} from './api';
import { DriveSearchModal } from './DriveSearchModal';

/** Shown where Google is needed but not connected yet. */
export function GoogleConnectHint() {
  const status = useGoogleStatus();
  if (status.data === undefined || status.data.connected) return null;
  return (
    <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
      Resumes live in your Google Docs.{' '}
      <Link
        to="/settings/integrations"
        className="font-medium text-primary underline-offset-4 hover:underline"
      >
        Connect your Google account
      </Link>{' '}
      to register and copy them.
    </p>
  );
}

/** Shown where Reactive Resume is the chosen store but not connected any more. */
function ReactiveResumeConnectHint() {
  const status = useReactiveResumeStatus();
  if (status.data === undefined || status.data.connected) return null;
  return (
    <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
      <Link
        to="/settings/integrations"
        className="font-medium text-primary underline-offset-4 hover:underline"
      >
        Connect Reactive Resume
      </Link>{' '}
      to register resumes from it.
    </p>
  );
}

/**
 * Register an existing document. Plain (no `opportunityId`) registers a base resume; given
 * one, it registers and attaches in one step (#77), landing as tailored with no parent since
 * nothing was copied.
 */
export function RegisterDocCard({ opportunityId }: { opportunityId?: string } = {}) {
  const create = useCreateResume();
  const pref = useDocumentStore();
  const [docRef, setDocRef] = useState('');
  const [searching, setSearching] = useState(false);
  const rr = pref.data?.store === 'reactive_resume';
  const attaching = opportunityId !== undefined;

  function registered(r: { title: string }) {
    toast({
      title: attaching ? 'Resume registered and attached' : 'Base resume registered',
      description: r.title,
      variant: 'success',
    });
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate(
      {
        store: rr ? 'reactive_resume' : 'google_doc',
        docRef: docRef.trim(),
        ...(attaching ? { opportunityId } : {}),
      },
      {
        onSuccess: (r) => {
          setDocRef('');
          registered(r);
        },
      },
    );
  }

  function pickFromDrive(hit: DriveSearchHit) {
    create.mutate(
      { store: 'google_doc', docRef: hit.id, ...(attaching ? { opportunityId } : {}) },
      { onSuccess: registered },
    );
  }

  return (
    <Card {...(attaching ? {} : { 'data-tour': 'register-resume' })}>
      <CardHeader>
        <CardTitle>{attaching ? 'Attach a new document' : 'Register a base resume'}</CardTitle>
        <CardDescription>
          {attaching
            ? rr
              ? "Paste the link of a Reactive Resume not yet registered in Opportun. It's registered and attached here in one step."
              : "Search Google Drive, or paste the link of a document not yet registered. It's registered and attached here in one step."
            : rr
              ? 'Paste the builder link or id of a resume in your Reactive Resume. Tailored copies are made from it for each opportunity.'
              : 'Search Google Drive, or paste a link. Tailored copies are made from it for each opportunity.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3">
          {rr ? <ReactiveResumeConnectHint /> : <GoogleConnectHint />}
          {rr ? null : (
            <>
              <Button
                type="button"
                variant="outline"
                className="w-fit"
                onClick={() => setSearching(true)}
                disabled={create.isPending}
              >
                <Search aria-hidden="true" />
                Search Google Drive
              </Button>
              <DriveSearchModal
                open={searching}
                onOpenChange={setSearching}
                onPick={pickFromDrive}
              />
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                or paste a link
                <span className="h-px flex-1 bg-border" />
              </div>
            </>
          )}
          <form onSubmit={submit} className="grid gap-3">
            <div className="grid gap-2">
              <Label htmlFor="base-doc-ref">
                {rr ? 'Reactive Resume link' : 'Google Doc link'}
              </Label>
              <Input
                id="base-doc-ref"
                value={docRef}
                maxLength={500}
                placeholder={
                  rr
                    ? 'https://resume.example.com/builder/...'
                    : 'https://docs.google.com/document/d/...'
                }
                onChange={(e) => setDocRef(e.currentTarget.value)}
              />
            </div>
            {create.error ? (
              <FormError message={resumeErrorMessage(create.error) ?? errorMessage(create.error)} />
            ) : null}
            <div>
              <Button type="submit" disabled={create.isPending || docRef.trim().length === 0}>
                {create.isPending
                  ? attaching
                    ? 'Attaching...'
                    : 'Registering...'
                  : attaching
                    ? 'Register and attach'
                    : 'Register'}
              </Button>
            </div>
          </form>
        </div>
      </CardContent>
    </Card>
  );
}

export function StatusBadge({ status }: { status: Resume['status'] }) {
  return (
    <Badge
      variant={status === 'submitted' ? 'success' : status === 'final' ? 'default' : 'outline'}
    >
      {statusLabel(status)}
    </Badge>
  );
}

/** A resume still connected to its opportunity, but displayed apart from active ones (#70). */
export function ArchivedBadge() {
  return <Badge variant="secondary">Archived</Badge>;
}

/** How many tailored copies a base resume has, for the delete dialog's detach warning. */
function tailoredCountOf(items: Resume[], resume: Resume): number {
  if (resume.kind !== 'base') return 0;
  return items.filter((r) => r.parentResumeId === resume.id).length;
}

/**
 * The confirm dialog's copy predicts the outcome from the resume's own (possibly stale)
 * status, which is fine for a prediction shown before the request goes out; the toast after
 * the request answers, in handleDelete below, reports what the server actually did instead.
 */
function deleteDescription(resume: Resume, tailoredCount: number): string {
  if (resume.status === 'submitted') {
    return (
      'This resume has been submitted, so it cannot be fully deleted. It will be archived ' +
      'instead: it stays connected to its opportunity, but is displayed separately from your ' +
      'active resumes.'
    );
  }
  const parts = ['The Google Doc itself is not deleted.'];
  if (tailoredCount > 0) {
    parts.push(
      `${tailoredCount} tailored ${tailoredCount === 1 ? 'copy' : 'copies'} will be detached ` +
        'and kept, with no base resume.',
    );
  }
  parts.push('All tailoring chat history for this resume will be permanently lost.');
  return parts.join(' ');
}

/**
 * The delete control (#70), used both on the Resumes list and on an opportunity's Resume tab
 * (#77): a self-contained icon button and its confirm dialog, so both places share one copy
 * of the archive-vs-delete copy and the server-reports-the-outcome handling.
 */
export function DeleteResumeButton({
  resume,
  tailoredCount,
}: {
  resume: Resume;
  tailoredCount: number;
}) {
  const del = useDeleteResume();
  const [pending, setPending] = useState(false);
  return (
    <>
      <IconButton variant="ghost" label={`Delete ${resume.title}`} onClick={() => setPending(true)}>
        <Trash2 aria-hidden="true" />
      </IconButton>
      {!pending ? null : (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) setPending(false);
          }}
          title={resume.status === 'submitted' ? 'Archive this resume?' : 'Delete this resume?'}
          description={deleteDescription(resume, tailoredCount)}
          confirmLabel={resume.status === 'submitted' ? 'Archive' : 'Delete'}
          onConfirm={async () => {
            const result = await del.mutateAsync(resume.id);
            // The notice reports what the server did, not what the dialog predicted (#75).
            if (result.outcome === 'archived') {
              toast({
                title: 'Resume archived',
                description:
                  'This resume has been submitted and cannot be fully deleted. It has been ' +
                  'archived. Archived resumes are still connected to the opportunity, but ' +
                  'displayed separately.',
              });
            } else {
              toast({ title: 'Resume deleted', variant: 'success' });
            }
          }}
        />
      )}
    </>
  );
}

function ResumeTable({ items }: { items: Resume[] }) {
  function row(r: Resume) {
    return (
      <TableRow key={r.id}>
        <TableCell className="font-medium">
          <Link
            to="/resumes/$id"
            params={{ id: r.id }}
            className="break-all text-primary underline-offset-4 hover:underline"
          >
            {r.title}
          </Link>
        </TableCell>
        <TableCell>{r.kind === 'base' ? 'Base' : 'Tailored'}</TableCell>
        <TableCell>
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge status={r.status} />
            {r.archivedAt === null ? null : <ArchivedBadge />}
          </div>
        </TableCell>
        <TableCell className="text-muted-foreground">{formatDate(r.updatedAt)}</TableCell>
        <TableCell>
          <DeleteResumeButton resume={r} tailoredCount={tailoredCountOf(items, r)} />
        </TableCell>
      </TableRow>
    );
  }

  const active = items.filter((r) => r.archivedAt === null);
  const archived = items.filter((r) => r.archivedAt !== null);

  return (
    <div className="grid gap-6">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Updated</TableHead>
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>{active.map(row)}</TableBody>
      </Table>
      {archived.length === 0 ? null : (
        <div className="grid gap-2">
          <p className="text-sm font-medium text-muted-foreground">Archived</p>
          <Table>
            <TableBody>{archived.map(row)}</TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

export function ResumeList() {
  const resumes = useResumes();
  const items = resumes.data?.items ?? [];
  return (
    <div className="grid gap-6">
      <RegisterDocCard />
      <Card>
        <CardHeader>
          <CardTitle>Your resumes</CardTitle>
        </CardHeader>
        <CardContent>
          {resumes.isPending ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : resumes.isError ? (
            <FormError message={errorMessage(resumes.error)} />
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No resumes yet.</p>
          ) : (
            <ResumeTable items={items} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
