import { Download, ExternalLink, Paperclip, Trash2 } from 'lucide-react';
import { useRef, useState, type ChangeEvent } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { FormError } from '@/components/FormError';
import { FormField } from '@/components/FormField';
import { Markdown } from '@/components/Markdown';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { API_BASE, errorMessage } from '@/lib/api';
import {
  formatBytes,
  formatDate,
  safeHttpUrl,
  sourceKindLabel,
  type AttachmentMeta,
  type OpportunityView,
} from '@/lib/opportunities';
import {
  useAttachments,
  useConfirmPosting,
  useDeleteAttachment,
  useFindPosting,
  useRederivePosting,
  useUnconfirmPosting,
  useUpdateOpportunity,
  useUploadAttachment,
  type FindPostingResult,
} from './api';
import { FindPostingDialog } from './FindPostingDialog';
import {
  PostingConfirmedStatus,
  PostingStateBanner,
  RederiveFromCaptureAction,
} from './PostingStateBanner';

/** Mirrors the server's upload cap (apps/server/src/routes/attachments.ts). */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function Attachments({ opportunityId }: { opportunityId: string }) {
  const { data, error } = useAttachments(opportunityId);
  const upload = useUploadAttachment(opportunityId);
  const remove = useDeleteAttachment(opportunityId);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<AttachmentMeta | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function onPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.currentTarget.files?.[0];
    if (input.current) input.current.value = '';
    if (file === undefined) return;
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setUploadError('Files must be 20 MB or smaller.');
      return;
    }
    setUploadError(null);
    try {
      await upload.mutateAsync(file);
      toast({ title: 'File attached', description: file.name, variant: 'success' });
    } catch (err) {
      setUploadError(errorMessage(err));
    }
  }

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>Attachments</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {error ? <FormError message={errorMessage(error)} /> : null}
        {data && data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No files yet.</p>
        ) : null}
        <ul className="grid gap-2">
          {data?.items.map((a) => (
            <li key={a.id} className="flex items-center gap-2">
              <Paperclip className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <a
                href={`${API_BASE}/attachments/${encodeURIComponent(a.id)}`}
                download={a.filename}
                className="min-w-0 flex-1 truncate text-sm text-primary underline-offset-2 hover:underline"
              >
                {a.filename}
              </a>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatBytes(a.bytes)}, {formatDate(a.createdAt)}
              </span>
              <Download className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <IconButton
                variant="ghost"
                className="size-7 text-muted-foreground"
                label={`Delete ${a.filename}`}
                onClick={() => setDeleting(a)}
              >
                <Trash2 aria-hidden="true" />
              </IconButton>
            </li>
          ))}
        </ul>
        <FormError message={uploadError} />
        <div>
          <input
            ref={input}
            id="attachment-upload"
            type="file"
            className="peer sr-only"
            disabled={upload.isPending}
            onChange={(e) => void onPick(e)}
          />
          <label
            htmlFor="attachment-upload"
            className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border bg-card px-4 text-sm font-medium transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring hover:bg-accent hover:text-accent-foreground"
          >
            <Paperclip className="size-4" aria-hidden="true" />
            {upload.isPending ? 'Uploading...' : 'Upload a file'}
          </label>
          <p className="mt-1 text-xs text-muted-foreground">Up to 20 MB.</p>
        </div>
      </CardContent>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete this file?"
        description={deleting ? `${deleting.filename} will be deleted.` : ''}
        confirmLabel="Delete"
        onConfirm={async () => {
          if (deleting === null) return;
          try {
            await remove.mutateAsync(deleting.id);
          } catch (err) {
            toast({
              title: 'Could not delete',
              description: errorMessage(err),
              variant: 'destructive',
            });
          }
        }}
      />
    </Card>
  );
}

/** Edits the description in place: the posting text is the user's to correct (FR-O1). */
function DescriptionEditor({ opp, onDone }: { opp: OpportunityView; onDone: () => void }) {
  const update = useUpdateOpportunity(opp.id);
  const [value, setValue] = useState(opp.descriptionMd ?? '');
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    try {
      await update.mutateAsync({ descriptionMd: value.trim() === '' ? null : value });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="grid gap-3">
      {error !== null ? <FormError message={error} /> : null}
      <FormField label="Description">
        {(c) => (
          <Textarea rows={14} value={value} onChange={(e) => setValue(e.target.value)} {...c} />
        )}
      </FormField>
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={() => void save()} disabled={update.isPending}>
          Save
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Edits the posting link. Emptying it clears the link; a LinkedIn link is kept as metadata. */
function LinkEditor({ opp, onDone }: { opp: OpportunityView; onDone: () => void }) {
  const update = useUpdateOpportunity(opp.id);
  const [value, setValue] = useState(opp.postingUrl ?? '');
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const raw = value.trim();
    if (raw !== '' && safeHttpUrl(raw) === null) {
      setFieldError('Enter an http or https link');
      return;
    }
    setFieldError(undefined);
    setError(null);
    try {
      await update.mutateAsync({ postingUrl: raw === '' ? null : raw });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="grid gap-3">
      {error !== null ? <FormError message={error} /> : null}
      <FormField label="Posting link" error={fieldError}>
        {(c) => (
          <Input
            type="url"
            inputMode="url"
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            {...c}
          />
        )}
      </FormField>
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={() => void save()} disabled={update.isPending}>
          Save
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function DetailsPanel({ opp }: { opp: OpportunityView }) {
  const posting = safeHttpUrl(opp.postingUrl);
  const find = useFindPosting(opp.id);
  const confirmPosting = useConfirmPosting(opp.id);
  const unconfirmPosting = useUnconfirmPosting(opp.id);
  const rederive = useRederivePosting(opp.id);
  const [found, setFound] = useState<FindPostingResult | null>(null);
  const [findError, setFindError] = useState<string | null>(null);
  const [editing, setEditing] = useState<'description' | 'link' | null>(null);
  const described = opp.descriptionMd != null && opp.descriptionMd.trim() !== '';

  // The posting is looked up only when asked for: nothing searches a board on its own.
  async function runFind() {
    setFindError(null);
    try {
      const result = await find.mutateAsync();
      if (result.outcome === 'attached') {
        const title = result.candidate?.posting.title ?? opp.title;
        // #114: a single confident match from a board read only in part (result.note) is
        // attached with no dialog in between, so the toast is the only place the person sees
        // this in the moment. It is also recorded on the timeline (attachPosting, server side)
        // since the toast itself is gone in a few seconds and the truncation stays true after.
        toast({
          title: 'Posting attached',
          description: result.note === undefined ? title : `${title}. ${result.note}`,
          variant: 'success',
        });
        return;
      }
      setFound(result);
    } catch (err) {
      setFindError(errorMessage(err));
    }
  }

  async function runConfirm() {
    try {
      await confirmPosting.mutateAsync();
      toast({ title: 'Posting confirmed', variant: 'success' });
    } catch (err) {
      toast({ title: 'Could not confirm', description: errorMessage(err), variant: 'destructive' });
    }
  }

  async function runUndo() {
    try {
      await unconfirmPosting.mutateAsync();
    } catch (err) {
      toast({ title: 'Could not undo', description: errorMessage(err), variant: 'destructive' });
    }
  }

  async function runRederive() {
    try {
      const result = await rederive.mutateAsync(true);
      const title =
        result.outcome === 'no_description_found'
          ? 'Nothing to re-derive'
          : result.outcome === 'merged'
            ? 'Description re-derived from a board match'
            : 'Description re-derived from the capture';
      const description =
        result.outcome === 'no_description_found'
          ? "The captured page didn't carry a recognizable job description."
          : undefined;
      toast({ title, description, variant: 'success' });
    } catch (err) {
      toast({
        title: 'Could not re-derive',
        description: errorMessage(err),
        variant: 'destructive',
      });
    }
  }
  const facts: [string, string][] = [];
  if (opp.location) facts.push(['Location', opp.location]);
  if (opp.remote != null) facts.push(['Remote', opp.remote ? 'Yes' : 'No']);
  if (opp.compNote) facts.push(['Compensation', opp.compNote]);
  facts.push(['Source', sourceKindLabel(opp.sourceKind)]);
  facts.push(['Added', formatDate(opp.createdAt)]);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <Card className="gap-4">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle>Description</CardTitle>
          {editing === null ? (
            <div className="flex flex-wrap gap-2">
              {described ? null : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void runFind()}
                  disabled={find.isPending}
                >
                  {find.isPending ? 'Searching...' : 'Find posting'}
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setEditing('description')}
              >
                Edit description
              </Button>
            </div>
          ) : null}
        </CardHeader>
        <CardContent className="grid gap-3">
          {findError !== null ? <FormError message={findError} /> : null}
          <PostingStateBanner
            opp={opp}
            busy={find.isPending}
            onAction={() => void runFind()}
            confirmBusy={confirmPosting.isPending}
            onConfirm={() => void runConfirm()}
          />
          <PostingConfirmedStatus
            opp={opp}
            busy={find.isPending}
            onRefetch={() => void runFind()}
            undoBusy={unconfirmPosting.isPending}
            onUndo={() => void runUndo()}
          />
          <RederiveFromCaptureAction
            opp={opp}
            busy={rederive.isPending}
            onRederive={() => void runRederive()}
          />
          {editing === 'description' ? (
            <DescriptionEditor opp={opp} onDone={() => setEditing(null)} />
          ) : opp.descriptionMd ? (
            <Markdown>{opp.descriptionMd}</Markdown>
          ) : (
            <p className="text-sm text-muted-foreground">No description.</p>
          )}
        </CardContent>
      </Card>
      <div className="grid content-start gap-6">
        <Card className="gap-4">
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
            <CardTitle>Posting</CardTitle>
            {editing === null ? (
              <Button type="button" size="sm" variant="outline" onClick={() => setEditing('link')}>
                Edit link
              </Button>
            ) : null}
          </CardHeader>
          <CardContent className="grid gap-3">
            {editing === 'link' ? <LinkEditor opp={opp} onDone={() => setEditing(null)} /> : null}
            {editing === 'link' ? null : posting ? (
              <a
                href={posting}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="inline-flex items-center gap-1 text-sm break-all text-primary underline underline-offset-2"
              >
                {posting}
                <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
              </a>
            ) : (
              <p className="text-sm text-muted-foreground">No posting link.</p>
            )}
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              {facts.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
        <Attachments opportunityId={opp.id} />
      </div>
      {found === null ? null : (
        <FindPostingDialog opp={opp} result={found} onClose={() => setFound(null)} />
      )}
    </div>
  );
}
