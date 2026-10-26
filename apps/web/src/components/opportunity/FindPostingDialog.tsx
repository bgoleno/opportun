// Choosing the posting for an opportunity (FR-O1). Opened only when the server did not settle
// it alone: several confident candidates, none, or no board at all. Candidate text comes from a
// job board, so every field renders as text, never as markup.
//
// The search box works over the whole ranked board, not just the confident rows: a stored title
// as generic as "Staff Product Manager" can rank the wrong req first and bury the right one.
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { FormError } from '@/components/FormError';
import { FormField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { safeHttpUrl, type OpportunityView } from '@/lib/opportunities';
import {
  useAttachPosting,
  type AttachPostingVars,
  type FindPostingResult,
  type PostingCandidateView,
} from './api';

/** Description characters shown per candidate. */
const PREVIEW = 200;
const TEXT_MAX = 200_000;

type Mode = 'url' | 'text';

function headline(result: FindPostingResult, company: string): string {
  if (result.needsConfirmation === true) {
    return `This posting came from a link in a message, on a board that is not ${company}'s own board. Check it before attaching.`;
  }
  if (result.outcome === 'candidates') {
    return `More than one posting on the ${company} board matches. Pick the one you applied to.`;
  }
  if (result.outcome === 'none') {
    return 'No close match on the board. Search it, or add the posting by hand.';
  }
  return result.hint ?? 'No job board found for this company. Add the posting by hand.';
}

function CandidateRow({
  candidate,
  onAttach,
  busy,
}: {
  candidate: PostingCandidateView;
  onAttach: () => void;
  busy: boolean;
}) {
  const { posting, score, otherLocations } = candidate;
  const href = safeHttpUrl(posting.postingUrl);
  const where = [posting.location, ...otherLocations].filter((l) => l != null && l !== '');
  return (
    <li className="grid gap-1 rounded-md border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-0.5">
          <p className="text-sm font-medium">{posting.title}</p>
          {where.length > 0 ? (
            <p className="text-xs text-muted-foreground">{where.join(' / ')}</p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{Math.round(score * 100)}% match</span>
          <Button type="button" size="sm" onClick={onAttach} disabled={busy}>
            Attach
          </Button>
        </div>
      </div>
      {posting.descriptionMd ? (
        <p className="text-xs break-words text-muted-foreground">
          {posting.descriptionMd.slice(0, PREVIEW)}
        </p>
      ) : null}
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="inline-flex items-center gap-1 text-xs break-all text-primary underline underline-offset-2"
        >
          {href}
          <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
        </a>
      ) : null}
    </li>
  );
}

/** Mounted while open; the parent unmounts it on close, which resets it. */
export function FindPostingDialog({
  opp,
  result,
  onClose,
}: {
  opp: OpportunityView;
  result: FindPostingResult;
  onClose: () => void;
}) {
  const attach = useAttachPosting(opp.id);
  const modeName = useId();
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<Mode>('url');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<string | null>(null);

  const confident = result.candidates ?? [];
  const all = result.board ?? result.candidates ?? [];
  const needle = query.trim().toLowerCase();
  const rows =
    needle === ''
      ? confident
      : all.filter((c) =>
          `${c.posting.title} ${c.posting.location ?? ''}`.toLowerCase().includes(needle),
        );

  async function send(body: AttachPostingVars, title: string) {
    setFailure(null);
    try {
      await attach.mutateAsync(body);
      toast({ title: 'Posting attached', description: title, variant: 'success' });
      onClose();
    } catch (err) {
      setFailure(errorMessage(err));
    }
  }

  async function submitByHand(e: FormEvent) {
    e.preventDefault();
    if (mode === 'url') {
      const value = url.trim();
      let valid: boolean;
      try {
        valid = new URL(value).protocol === 'https:';
      } catch {
        valid = false;
      }
      if (!valid) {
        setFieldError('Enter an https link');
        return;
      }
      setFieldError(undefined);
      await send({ url: value }, value);
      return;
    }
    const value = text.trim();
    if (value === '') {
      setFieldError('Paste the posting description');
      return;
    }
    if (value.length > TEXT_MAX) {
      setFieldError('That text is too long');
      return;
    }
    setFieldError(undefined);
    await send({ text: value }, opp.title);
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add the posting</DialogTitle>
          <DialogDescription className="break-words">
            {headline(result, opp.companyName)}
          </DialogDescription>
        </DialogHeader>

        {failure !== null ? <FormError message={failure} /> : null}

        {result.note !== undefined ? (
          <div
            role="status"
            className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
          >
            <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
            <span className="flex-1">{result.note}</span>
          </div>
        ) : null}

        {all.length > 0 ? (
          <div className="grid gap-3">
            <FormField
              label="Search the board"
              hint={`Filters the ${all.length} postings found on the board.`}
            >
              {(c) => (
                <Input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={opp.title}
                  {...c}
                />
              )}
            </FormField>
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing on the board matches that.</p>
            ) : (
              <ul className="grid gap-2">
                {rows.map((candidate) => (
                  <CandidateRow
                    key={`${candidate.posting.externalId ?? candidate.posting.postingUrl ?? candidate.posting.title}`}
                    candidate={candidate}
                    busy={attach.isPending}
                    onAttach={() =>
                      void send({ posting: candidate.posting }, candidate.posting.title)
                    }
                  />
                ))}
              </ul>
            )}
          </div>
        ) : null}

        <form
          className="grid gap-4 border-t pt-4"
          noValidate
          onSubmit={(e) => void submitByHand(e)}
        >
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Add it by hand</legend>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="inline-flex items-center gap-2">
                <input
                  type="radio"
                  name={modeName}
                  value="url"
                  checked={mode === 'url'}
                  onChange={() => {
                    setMode('url');
                    setFieldError(undefined);
                  }}
                />
                Link
              </label>
              <label className="inline-flex items-center gap-2">
                <input
                  type="radio"
                  name={modeName}
                  value="text"
                  checked={mode === 'text'}
                  onChange={() => {
                    setMode('text');
                    setFieldError(undefined);
                  }}
                />
                Pasted text
              </label>
            </div>
          </fieldset>
          {mode === 'url' ? (
            <FormField
              label="Posting link"
              hint="An https link to the job posting. LinkedIn links cannot be read; paste the text instead."
              error={fieldError}
            >
              {(c) => (
                <Input
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  {...c}
                />
              )}
            </FormField>
          ) : (
            <FormField label="Posting description" error={fieldError}>
              {(c) => (
                <Textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} {...c} />
              )}
            </FormField>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={attach.isPending}>
              Attach posting
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
