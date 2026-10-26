// Manual capture (FR-D1 manual source): hand over a posting as a link or as pasted text, and
// the server extracts it into the review queue. Opened from the queue for a new posting, or
// from a needs_capture lead to complete that lead in place (its link pre-filled).
//
// Server answers handled here: 422 with a hint (LinkedIn and other unfetchable pages: paste the
// text instead), 503 ai_unavailable (fall back to the New Opportunity dialog), 409 duplicate.
// Server text (hints, messages) and posting fields are rendered as text only.
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
import { ApiError, errorMessage } from '@/lib/api';
import { safeHttpUrl } from '@/lib/opportunities';
import { useCapture, type CaptureVars, type DiscoveryResult } from './api';
import { resultLabel } from './QueueRow';

type Mode = 'url' | 'text';

/** What the last failed submit asks of the user. */
type Failure =
  | { kind: 'paste_text'; hint: string }
  | { kind: 'ai_unavailable'; hint: string }
  | { kind: 'other'; message: string };

const TEXT_MAX = 200_000;

function validUrl(value: string): string | null {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' ? null : 'Enter an https link';
  } catch {
    return 'Enter the posting link';
  }
}

function hintOf(err: ApiError, fallback: string): string {
  const hint = err.details.hint;
  return typeof hint === 'string' && hint.length > 0 ? hint : fallback;
}

function toFailure(err: unknown): Failure {
  if (err instanceof ApiError) {
    if (err.status === 422 && typeof err.details.hint === 'string') {
      const fetchProblem = ['prohibited_host', 'fetch_blocked', 'fetch_failed'].includes(err.code);
      return fetchProblem
        ? { kind: 'paste_text', hint: hintOf(err, '') }
        : { kind: 'other', message: hintOf(err, errorMessage(err)) };
    }
    if (err.status === 503 && err.code === 'ai_unavailable') {
      return {
        kind: 'ai_unavailable',
        hint: hintOf(err, 'AI extraction is unavailable. Add the posting by hand instead.'),
      };
    }
    if (err.code === 'duplicate') {
      return { kind: 'other', message: 'That posting is already in your queue or pipeline.' };
    }
  }
  return { kind: 'other', message: errorMessage(err) };
}

/**
 * Mounted while open (the parent unmounts it on close, which resets it). `lead` is a pending
 * needs_capture result to complete; without it the capture adds a new result.
 */
export function CaptureDialog(props: {
  lead?: DiscoveryResult | null;
  onClose: () => void;
  /** Opens the New Opportunity dialog (the manual-entry fallback when AI is unavailable). */
  onManualEntry: () => void;
}) {
  const lead = props.lead ?? null;
  const capture = useCapture();
  const modeName = useId();
  const [mode, setMode] = useState<Mode>('url');
  const [url, setUrl] = useState(() => {
    const href = safeHttpUrl(lead?.posting.postingUrl);
    return href !== null && href.startsWith('https:') ? href : '';
  });
  const [text, setText] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<Failure | null>(null);

  function switchMode(next: Mode) {
    setMode(next);
    setFieldError(undefined);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFailure(null);
    let body: CaptureVars;
    if (mode === 'url') {
      const value = url.trim();
      const problem = validUrl(value);
      if (problem !== null) {
        setFieldError(problem);
        return;
      }
      body = { url: value };
    } else {
      const value = text.trim();
      if (value === '') {
        setFieldError('Paste the posting description');
        return;
      }
      if (value.length > TEXT_MAX) {
        setFieldError('That text is too long to capture');
        return;
      }
      body = { text: value };
    }
    setFieldError(undefined);
    if (lead !== null) body = { ...body, resultId: lead.id };
    try {
      const res = await capture.mutateAsync(body);
      toast({
        title: lead === null ? 'Posting captured' : 'Description captured',
        description: `${res.posting.title} at ${res.posting.company}`,
        variant: 'success',
      });
      props.onClose();
    } catch (err) {
      setFailure(toFailure(err));
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{lead === null ? 'Capture posting' : 'Capture description'}</DialogTitle>
          <DialogDescription className="break-words">
            {lead === null
              ? 'Give a posting link or paste its text. It is added to the review queue.'
              : `Complete the lead for ${resultLabel(lead)} with its full description.`}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" noValidate onSubmit={(e) => void submit(e)}>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Capture from</legend>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="inline-flex items-center gap-2">
                <input
                  type="radio"
                  name={modeName}
                  value="url"
                  checked={mode === 'url'}
                  onChange={() => switchMode('url')}
                />
                Link
              </label>
              <label className="inline-flex items-center gap-2">
                <input
                  type="radio"
                  name={modeName}
                  value="text"
                  checked={mode === 'text'}
                  onChange={() => switchMode('text')}
                />
                Pasted text
              </label>
            </div>
          </fieldset>

          {mode === 'url' ? (
            <FormField
              label="Posting link"
              hint="An https link to the job posting."
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
            <FormField
              label="Posting description"
              hint="Paste the whole posting: title, company, location and description."
              error={fieldError}
            >
              {(c) => (
                <Textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} {...c} />
              )}
            </FormField>
          )}

          {failure?.kind === 'other' ? <FormError message={failure.message} /> : null}
          {failure?.kind === 'paste_text' ? (
            <div
              role="alert"
              className="grid gap-2 rounded-md border border-primary/40 bg-accent px-3 py-2 text-sm text-accent-foreground"
            >
              <p className="break-words">{failure.hint}</p>
              {mode === 'url' ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="w-fit"
                  onClick={() => {
                    setFailure(null);
                    switchMode('text');
                  }}
                >
                  Paste the text instead
                </Button>
              ) : null}
            </div>
          ) : null}
          {failure?.kind === 'ai_unavailable' ? (
            <div
              role="alert"
              className="grid gap-2 rounded-md border border-primary/40 bg-accent px-3 py-2 text-sm text-accent-foreground"
            >
              <p className="break-words">{failure.hint}</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="w-fit"
                onClick={props.onManualEntry}
              >
                New opportunity
              </Button>
            </div>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={capture.isPending}>
              {capture.isPending ? 'Capturing...' : 'Capture'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
