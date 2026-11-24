import { SharedDemoNotice } from '@/components/SharedDemoNotice';
import { Download, ExternalLink, Paperclip, Trash2 } from 'lucide-react';
import { useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { useOpportunitySubmissions } from '@/components/apply/api';
import { MainWithRail } from '@/components/MainWithRail';
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
  CHECK_ENDED,
  isPostingSearching,
  useAttachments,
  useCheckOver,
  useChecksEnded,
  useConfirmPosting,
  useDeleteAttachment,
  useFindPosting,
  useRederivePosting,
  useUnconfirmPosting,
  useUpdateOpportunity,
  useUploadAttachment,
  type FindPostingResult,
} from './api';
import { postingErrorMessage } from './AlreadyTracked';
import { FindPostingDialog } from './FindPostingDialog';
import {
  PostingConfirmedStatus,
  PostingStateBanner,
  RederiveFromCaptureAction,
} from './PostingStateBanner';
import { descriptionAtStake, ReplaceDescriptionDialog } from './ReplaceDescription';

/** Mirrors the server's upload cap (apps/server/src/routes/attachments.ts). */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export function Attachments({ opportunityId }: { opportunityId: string }) {
  const { data, error } = useAttachments(opportunityId);
  const upload = useUploadAttachment(opportunityId);
  const remove = useDeleteAttachment(opportunityId);
  // A resume snapshot an application names (assisted apply, #115 and #117): deleting it is
  // allowed, but the confirm says what is lost and what is kept. null where the feature is off.
  const submissions = useOpportunitySubmissions(opportunityId);
  const snapshotIds = new Set(
    (submissions.data?.items ?? []).flatMap((s) =>
      typeof s.resumeAttachmentId === 'string' ? [s.resumeAttachmentId] : [],
    ),
  );
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
        {/* What an attached file means on a shared demo account (#671, decision 133). */}
        <SharedDemoNotice about="files" />
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
        title={
          deleting !== null && snapshotIds.has(deleting.id)
            ? 'Delete this resume snapshot?'
            : 'Delete this file?'
        }
        description={
          deleting === null
            ? ''
            : snapshotIds.has(deleting.id)
              ? `${deleting.filename} is the copy of the resume an application on this opportunity was prepared with. It cannot be changed, but you can delete it: the file goes, and Opportun keeps its fingerprint and title so the record still shows which resume was used.`
              : `${deleting.filename} will be deleted.`
        }
        confirmLabel="Delete"
        onConfirm={async () => {
          if (deleting === null) return;
          try {
            await remove.mutateAsync(deleting.id);
            // The server clears the application's reference to a deleted snapshot.
            if (snapshotIds.has(deleting.id)) void submissions.refetch();
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
  // Cancelled while a save was in flight (#737). The server stores the link whatever the editor
  // does, and the card then switches to it, so a save that settles after Cancel says how it ended
  // rather than changing the card with nothing said.
  const cancelled = useRef(false);

  async function save() {
    const raw = value.trim();
    if (raw !== '' && safeHttpUrl(raw) === null) {
      setFieldError('Enter an http or https link');
      return;
    }
    setFieldError(undefined);
    setError(null);
    cancelled.current = false;
    const sent = raw === '' ? null : raw;
    try {
      const saved = await update.mutateAsync({ postingUrl: sent });
      if (cancelled.current) {
        // Named (#785): a later save of another link may have landed first, and the answer is the
        // row as it now is (#714), so this one says when it was replaced rather than reading as
        // that save's.
        const replaced = saved.postingUrl !== sent;
        toast({
          title: replaced ? 'Posting link saved, then replaced' : 'Posting link saved',
          description: sent ?? 'The link was cleared.',
          variant: replaced ? 'default' : 'success',
        });
      } else onDone();
    } catch (err) {
      if (cancelled.current) {
        toast({
          title: 'Posting link not saved',
          description: errorMessage(err),
          variant: 'destructive',
        });
      } else setError(errorMessage(err));
    }
  }

  function cancel() {
    if (update.isPending) cancelled.current = true;
    onDone();
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
        <Button type="button" size="sm" variant="outline" onClick={cancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** What a Refetch changed, as its toast names it (#866). */
const CHANGED_SAID = new Map<NonNullable<FindPostingResult['changed']>[number], string>([
  ['link', 'posting link'],
  ['job', 'job on the board'],
]);

export function DetailsPanel({ opp }: { opp: OpportunityView }) {
  const posting = safeHttpUrl(opp.postingUrl);
  const find = useFindPosting(opp.id);
  const confirmPosting = useConfirmPosting(opp.id);
  const unconfirmPosting = useUnconfirmPosting(opp.id);
  const rederive = useRederivePosting(opp.id);
  /** `replaces`: the description the user agreed to lose to what this search finds. */
  const [found, setFound] = useState<{ result: FindPostingResult; replaces?: string } | null>(null);
  /** Asking before a search that would replace the user's description (#858): the one it asks about. */
  const [asking, setAsking] = useState<string | null>(null);
  const checksEnded = useChecksEnded(opp.postingState);
  const checkOver = useCheckOver(opp.id);
  /** `untilCheck`: the refusal for a running check, true only until that check ends (#870). */
  const [findError, setFindError] = useState<{ message: ReactNode; untilCheck?: number } | null>(
    null,
  );
  /**
   * The board could not be read (#835): said as such, with a retry, not as "no match". Kept as
   * `checksEnded` when Find posting was pressed: a check that ends since has its own result to
   * show, and what could not be read before it no longer matters (#866).
   */
  const [unreachableAt, setUnreachableAt] = useState<number | null>(null);
  const unreachable = unreachableAt === checksEnded;
  const [editing, setEditing] = useState<'description' | 'link' | null>(null);
  const described = opp.descriptionMd != null && opp.descriptionMd.trim() !== '';

  // The posting is looked up only when asked for: nothing searches a board on its own.
  // Where it would replace what the user wrote, they are asked first.
  function startFind() {
    const atStake = descriptionAtStake(opp);
    if (atStake === null) void runFind();
    else setAsking(atStake);
  }

  async function runFind(replaces?: string) {
    setFindError(null);
    setUnreachableAt(null);
    try {
      const result = await find.mutateAsync({
        seen: opp.postingState ?? 'none',
        ...(replaces === undefined ? {} : { replaceDescription: replaces }),
      });
      if (result.outcome === 'already_confirmed') {
        // A background check finished while the page was open (#852): nothing searched again.
        toast({
          title: 'Already confirmed',
          description: "The board check finished while this page was open; it's up to date now.",
          variant: 'success',
        });
        return;
      }
      if (result.outcome === 'unreachable') {
        setUnreachableAt(checksEnded);
        return;
      }
      // A description of the user's is kept without comparing it, so it is not said to match (tl on
      // #930).
      const kept = result.keptDescription === true ? ['Your own description was kept.'] : [];
      const note = result.note === undefined ? [] : [result.note];
      if (result.outcome === 'attached' && result.unchanged === true) {
        // A Refetch that found the same job, link and description (#835, qa on #830).
        const same = kept.length > 0 ? kept : ["The posting matches the company's board."];
        toast({
          title: 'Nothing changed',
          description: [...same, ...note].join(' '),
          variant: 'success',
        });
        return;
      }
      if (result.outcome === 'attached' && result.changed !== undefined) {
        // A Refetch says what it changed (#866, qa on #860): nothing was attached anew.
        const what = result.changed.map((c) => CHANGED_SAID.get(c) ?? c).join(', ');
        toast({
          title: 'Posting updated',
          description: [`Updated from the board: ${what}.`, ...kept, ...note].join(' '),
          variant: 'success',
        });
        return;
      }
      if (result.outcome === 'attached') {
        const title = result.candidate?.posting.title ?? opp.title;
        // #114: a single confident match from a board read only in part (result.note) is
        // attached with no dialog in between, so the toast is the only place the person sees
        // this in the moment. It is also recorded on the timeline (attachPosting, server side)
        // since the toast itself is gone in a few seconds and the truncation stays true after.
        toast({
          title: 'Posting attached',
          description: [title, ...[...kept, ...note].map((l) => `. ${l}`)].join(''),
          variant: 'success',
        });
        return;
      }
      if (result.outcome === 'identified') {
        // #398: the posting link's own Greenhouse job was recognised; nothing was attached.
        toast({
          title: 'Recognised on Greenhouse',
          ...(kept.length === 0 ? {} : { description: kept.join(' ') }),
          variant: 'success',
        });
        return;
      }
      setFound({ result, ...(replaces === undefined ? {} : { replaces }) });
    } catch (err) {
      if (isPostingSearching(err) && checkOver()) {
        toast(CHECK_ENDED);
        return;
      }
      setFindError({
        message: postingErrorMessage(err),
        ...(isPostingSearching(err) ? { untilCheck: checksEnded } : {}),
      });
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

  async function runRederive(asked: string) {
    try {
      const result = await rederive.mutateAsync({ force: true, replaceDescription: asked });
      const title =
        result.outcome === 'no_description_found'
          ? 'Nothing to re-derive'
          : result.outcome === 'left_alone'
            ? 'Left as it is'
            : result.outcome === 'merged'
              ? 'Description re-derived from a board match'
              : 'Description re-derived from the capture';
      const description =
        result.outcome === 'no_description_found'
          ? "The captured page didn't carry a recognizable job description."
          : result.outcome === 'left_alone'
            ? 'The description changed while the board was being checked, so it was kept.'
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
    <MainWithRail>
      <Card className="gap-4">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle>Description</CardTitle>
          {editing === null ? (
            <div className="flex flex-wrap gap-2">
              {/* Until the posting is confirmed, Find posting is what confirms it, a described
                  one included (#756): the user's own description is kept. */}
              {described && opp.postingState === 'confirmed' ? null : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={startFind}
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
          {findError !== null && (findError.untilCheck ?? checksEnded) === checksEnded ? (
            <FormError message={findError.message} />
          ) : null}
          <PostingStateBanner
            opp={opp}
            unreachable={unreachable}
            // A confirmed posting is there already: nothing to add.
            {...(opp.postingState === 'confirmed'
              ? {}
              : { onAddByHand: () => setFound({ result: { outcome: 'unreachable' } }) })}
            busy={find.isPending}
            onAction={startFind}
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
            onRederive={(asked) => void runRederive(asked)}
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
        <FindPostingDialog opp={opp} {...found} onClose={() => setFound(null)} />
      )}
      <ReplaceDescriptionDialog
        open={asking !== null}
        from="board"
        onOpenChange={(open) => {
          if (!open) setAsking(null);
        }}
        onConfirm={() => {
          if (asking !== null) void runFind(asking);
        }}
      />
    </MainWithRail>
  );
}
